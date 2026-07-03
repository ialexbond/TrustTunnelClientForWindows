import { useImperativeHandle, forwardRef, useMemo, useState, useCallback, useRef, useEffect, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useConfigList, type ConfigSummary } from "../../shared/hooks/useConfigList";
import { usePerConfigPing, type PingTarget } from "../../shared/hooks/usePerConfigPing";
import type { ConfigPingSource } from "../../shared/hooks/useConfigPingSource";
import { useConfirm } from "../../shared/ui/useConfirm";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { formatError } from "../../shared/utils/formatError";
import { samePath } from "../../shared/utils/samePath";
import { dedupeConfigsByIdentity } from "../../shared/utils/dedupeConfigsByIdentity";
import { ConfigList } from "./ConfigList";
import { ConfigEditView } from "./ConfigEditView";
import { ConfigQr } from "./ConfigQr";
import type { VpnStatus, ReconnectProgress } from "../../shared/types";

export interface ConnectionPanelHandle {
  /** Re-fetch the manifest list WITH the loading skeleton (initial/explicit reload). */
  reload: () => void;
  /** Re-fetch the manifest list SILENTLY (no skeleton, scroll preserved) — for automatic
   *  refreshes (window focus / the fs-watcher). */
  refresh: () => void;
}

interface ConnectionPanelProps {
  /** Open the production import modal — wired by App.tsx. */
  onImport: () => void;
  /** Live VPN status (drives the lead card lifecycle + active-config delete copy). */
  status: VpnStatus;
  /** Path of the currently active/connected config (the lead card). Empty when none. */
  activeConfigPath: string;
  /** Connect a specific config by path (used when nothing is active yet). */
  onConnect: (path: string) => void;
  /** Disconnect the active tunnel. */
  onDisconnect: () => Promise<void> | void;
  /** Manual switch to another config (D-20) — disconnect-then-connect of the selected path. */
  onSwitchTo: (path: string) => void;
  /** Reconnect the active tunnel (used by ConfigEditView's save-and-reconnect). */
  onReconnect: () => Promise<void>;
  /**
   * Phase 14 (D-12): a seamless A→B switch is in flight (App-level FE-only flag). Threaded
   * straight through to ConfigList, where it is OR'd into the leadIsLive gate so the frosted
   * hero stays mounted + hoisted through the transient teardown `disconnected`. No panel-level
   * logic keys on it — pure pass-through (mirrors the existing prop threading).
   */
  isSwitching?: boolean;
  /**
   * F28 (14-UAT round 3): the path of the config whose connect was JUST clicked, for the window before
   * the live status becomes `connecting`. Pure pass-through to ConfigList → the target card shows an
   * instant spinner + the list locks. Set/cleared by App around the connect initiators.
   */
  pendingConnectPath?: string | null;
  /**
   * Phase 14 (F6, 14-UAT): the switch-failed-reverted notice — pure pass-through to ConfigList's
   * lead card, where it renders EMBEDDED inside the active card. Set/cleared by App.
   */
  revertNotice?: string | null;
  onRevertDismiss?: () => void;
  /**
   * 12-07: the App-level SINGLE config-list + inactive-ping source. When supplied, this panel reuses
   * its already-dedup'd `configs` + `pings` + reload/refresh/loading instead of running its OWN
   * `useConfigList`/`usePerConfigPing` — so the auto-switch engine and the cards share ONE ping loop
   * (T-12-14). When OMITTED (the panel's own unit tests render it standalone), it falls back to its
   * internal hooks and behaves exactly as before. `source.configs` is ALREADY identity-collapsed by
   * `useConfigPingSource`, so the panel must NOT re-dedup it.
   */
  source?: ConfigPingSource;
  /**
   * F20 (14-UAT round 2): the live reconnect attempt progress {attempt, max}, threaded straight to
   * ConfigList's lead card where it renders «Переподключение · Попытка N из M». `null` when no
   * per-attempt counter is live. Pure pass-through — no panel logic keys on it.
   */
  reconnectProgress?: ReconnectProgress | null;
}

/**
 * `ConnectionPanel` (production, Phase 11) — the «Подключение» tab body, now fully wired.
 * It owns the multi-config list (`useConfigList`), the per-config ping loop
 * (`usePerConfigPing`), the per-config edit modal (`ConfigEditView`), and routes every
 * card action through the Wave-1 manifest commands + the VPN actions App passes in:
 *
 *   - «Подключить»/«Переключиться»/«Отключить» → onConnect / onSwitchTo / onDisconnect.
 *   - «Изменить» → opens ConfigEditView for that config.
 *   - «Дублировать» → duplicate_config («(копия)», honest measuring ping by construction
 *     since the new card has no prior ping) → reload.
 *   - «Удалить» → a danger ConfirmDialog (useConfirm). The ACTIVE config disconnects first
 *     (disconnect-then-delete, D-03); on the LAST delete the list returns to
 *     empty-no-configs (ConfigList renders that state when the list is empty).
 *   - inline rename → rename_config (Enter saves, Escape cancels, empty/duplicate blocked
 *     in the card; a backend failure surfaces as a FieldError under the field).
 *
 * After any mutation the manifest list is reloaded (the manifest is the source of truth).
 */
export const ConnectionPanel = forwardRef<ConnectionPanelHandle, ConnectionPanelProps>(
  function ConnectionPanel(
    { onImport, status, activeConfigPath, onConnect, onDisconnect, onSwitchTo, onReconnect, isSwitching, pendingConnectPath, revertNotice, onRevertDismiss, source, reconnectProgress },
    ref,
  ) {
    const { t } = useTranslation();
    // 12-07: when an App-level `source` is injected, this panel REUSES it (single ping loop). The
    // internal hooks below still run (hooks cannot be conditional) but are made inert when source is
    // present: the internal list is ignored in favour of source.configs, and the internal ping loop
    // is fed an EMPTY target set so it never probes (the App-level loop is the only one fanning out).
    const usingSource = source !== undefined;
    const internal = useConfigList();
    const reload = source?.reload ?? internal.reload;
    const refresh = source?.refresh ?? internal.refresh;
    const loading = source?.loading ?? internal.loading;
    const confirm = useConfirm();
    const pushSnack = useSnackBar();

    // IN-45: a USER-initiated add should reveal the new card. We flag the next list-settle as a
    // "reveal" the moment such a reload is REQUESTED (import / install / duplicate), then the scroll
    // effect below consumes it once the real list is mounted. Keying on the request (not on
    // observing the loading=true render) is robust to React batching the loading flip.
    const pendingRevealRef = useRef(false);
    const reloadAndReveal = useCallback(() => {
      pendingRevealRef.current = true;
      return reload();
    }, [reload]);

    // The imperative reload() (called by App for import / install) reveals the new card; refresh()
    // (silent fs-watcher / focus backstop) never moves the scroll.
    useImperativeHandle(ref, () => ({ reload: reloadAndReveal, refresh }), [reloadAndReveal, refresh]);

    // IN-31: refresh the list the INSTANT the config data dir changes on disk (a config added or
    // removed externally, e.g. deleted in the file manager). The Rust fs-watcher emits
    // `configs-changed`; we silent-refresh (no skeleton, scroll preserved) so a deleted card
    // disappears immediately. Mirrors useDeepLinkImport's listen pattern.
    useEffect(() => {
      const unlisten = listen("configs-changed", () => {
        void refresh();
      });
      return () => {
        unlisten.then((f) => f());
      };
    }, [refresh]);

    // Collapse same-server twins (host+user) into one card before anything renders or pings —
    // a machine upgraded from the old single-config build can hold one server as two physical
    // .toml files, which migration (path-dedup only) keeps as two manifest entries (11-UAT gap
    // A). This is a presentation-layer collapse; the on-disk manifest is untouched. The
    // active-path-aware winner keeps the connected file so the live status still lands.
    // 12-07: when a `source` is injected its `configs` are ALREADY dedup'd by useConfigPingSource —
    // re-running the collapse would be redundant, so we take them as-is. Only the standalone (no
    // source) path dedups the internal list here.
    const internalVisibleConfigs = useMemo(
      () => dedupeConfigsByIdentity(internal.configs, activeConfigPath),
      [internal.configs, activeConfigPath],
    );
    const visibleConfigs = source?.configs ?? internalVisibleConfigs;

    // ─── Scroll handling (IN-49 — trust native preservation) ───
    // The list scroll used to jump to the top in MANY situations. The ONLY real root was reload()
    // flashing the loading SKELETON on every mutation: the tall list was swapped for 3 short skeleton
    // rows in this scroller → the browser clamped scrollTop to 0. That is fixed at the source — the
    // skeleton is FIRST-LOAD-ONLY (useConfigList) + ConfigList renders it only on an empty list. With
    // no content collapse, the browser PRESERVES scrollTop NATIVELY across a tab switch
    // (visibility:hidden keeps it), a mutation reconcile (keyed cards reused, same height), and
    // minimize/restore — proven in an isolated DOM repro. Every custom save/restore we tried (IN-39/44/47)
    // RACED the async tab-show re-render and reset scroll instead of preserving it, so it is GONE. The
    // only deliberate scroll move left is the IN-45 reveal-to-bottom when the USER adds a config.
    const scrollerRef = useRef<HTMLDivElement>(null);

    // IN-45: when the user ADDS a config, bring the new card into view (instant jump — no animated
    // sweep). The reveal is requested by the user-add callers (reloadAndReveal: import / install /
    // duplicate) and consumed once the list has settled; a passive fs-watcher / focus refresh() never
    // sets it. `prevConfigCount > 0` skips the initial empty→loaded population.
    const prevConfigCount = useRef(0);
    useLayoutEffect(() => {
      if (loading) return; // wait for the real list
      const n = visibleConfigs.length;
      const el = scrollerRef.current;
      if (pendingRevealRef.current && prevConfigCount.current > 0 && n > prevConfigCount.current && el) {
        el.scrollTop = el.scrollHeight; // instant — reveal the just-added card at the bottom
      }
      pendingRevealRef.current = false; // consume the request once the list has settled
      prevConfigCount.current = n;
    }, [visibleConfigs.length, loading]);

    // Ping every config's endpoint for live reachability bands (D-16). The targets are
    // memoized on the joined id|path so a pure re-render does not restart the ping loop.
    // 12-07: when a `source` is injected the App-level loop already produced `source.pings` — feed
    // the INTERNAL loop an EMPTY target set so it never probes (exactly ONE inactive-ping loop, the
    // App-level one). Standalone (no source) keeps the panel's own loop as before.
    const internalTargets: PingTarget[] = useMemo(
      () => (usingSource ? [] : internalVisibleConfigs.map((c) => ({ id: c.id, path: c.path }))),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only when the set changes
      [usingSource, internalVisibleConfigs.map((c) => `${c.id}:${c.path}`).join("|")],
    );
    const internalPings = usePerConfigPing(internalTargets);
    const pings = source?.pings ?? internalPings;

    // ─── ConfigEditView (per-config settings modal) ───
    // Two pieces of state so the modal plays its EXIT animation: `editOpen` drives the Modal's
    // isOpen (false → 200ms fade-out), and `editConfig` (the content) is cleared only AFTER that
    // fade so the modal does not snap shut (Modal lifecycle contract — never unmount before exit).
    const [editConfig, setEditConfig] = useState<ConfigSummary | null>(null);
    const [editOpen, setEditOpen] = useState(false);
    const editCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const openEdit = useCallback((config: ConfigSummary) => {
      if (editCloseTimer.current) clearTimeout(editCloseTimer.current);
      setEditConfig(config);
      setEditOpen(true);
    }, []);
    const closeEdit = useCallback(() => {
      setEditOpen(false);
      editCloseTimer.current = setTimeout(() => setEditConfig(null), 200);
    }, []);

    // ─── ConfigQr (per-config QR/link transfer modal, Phase 15 D-09) ───
    // Mirrors the ConfigEditView open/close pattern above: `qrOpen` drives the Modal's isOpen
    // (false → 200ms exit animation), and `qrConfig` (the content) is cleared only AFTER that
    // fade so the modal does not snap shut mid-transition (Modal lifecycle contract). Opened from
    // any card's «…» → «QR-код» — active OR inactive (no state gating).
    const [qrConfig, setQrConfig] = useState<ConfigSummary | null>(null);
    const [qrOpen, setQrOpen] = useState(false);
    const qrCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const openQr = useCallback((config: ConfigSummary) => {
      if (qrCloseTimer.current) clearTimeout(qrCloseTimer.current);
      setQrConfig(config);
      setQrOpen(true);
    }, []);
    const closeQr = useCallback(() => {
      setQrOpen(false);
      qrCloseTimer.current = setTimeout(() => setQrConfig(null), 200);
    }, []);
    // Clear the pending cleanup timer on unmount (like the edit timer) so a late setState never
    // fires on an unmounted panel.
    useEffect(() => {
      return () => {
        if (qrCloseTimer.current) clearTimeout(qrCloseTimer.current);
      };
    }, []);

    // A config is "live-active" only when its path matches AND a tunnel is actually up/in-flight
    // (not merely the last-used pointer). After a disconnect the former-active config is NO LONGER
    // live-active, so it behaves like any inactive config: its primary CONNECTS (not disconnects),
    // delete needs no disconnect-first, and «Изменить» shows «Сохранить» (not save+reconnect).
    const tunnelLive = status !== "disconnected" && status !== "error";
    const isLiveActive = useCallback(
      (path: string) => samePath(path, activeConfigPath) && status !== "disconnected" && status !== "error",
      [activeConfigPath, status],
    );

    // ─── Connect / switch (the live card disconnects; an inactive card connects/switches) ───
    const handleCardConnect = useCallback(
      (config: ConfigSummary) => {
        if (isLiveActive(config.path)) {
          // The LIVE active card's primary is «Отключить».
          void onDisconnect();
          return;
        }
        if (tunnelLive) {
          // A tunnel is up on ANOTHER config → «Переключиться» (D-20).
          onSwitchTo(config.path);
        } else {
          // Nothing live → plain connect (incl. the disconnected former-active card on top).
          onConnect(config.path);
        }
      },
      [tunnelLive, isLiveActive, onConnect, onDisconnect, onSwitchTo],
    );

    // ─── Duplicate ───
    const handleDuplicate = useCallback(
      async (config: ConfigSummary) => {
        try {
          await invoke("duplicate_config", { id: config.id });
          await reloadAndReveal(); // IN-45: a duplicate is a user add → reveal the new copy
          pushSnack(t("connection.snackbar.config_duplicated"));
        } catch (e) {
          pushSnack(formatError(e), "error");
        }
      },
      [reloadAndReveal, pushSnack, t],
    );

    // ─── Delete (LIVE active = disconnect-then-delete, D-03; last → empty) ───
    const handleDelete = useCallback(
      async (config: ConfigSummary) => {
        // Phase 14 (FAB-05): the delete confirm is ASYNC — the user may sit on the dialog while a
        // switch starts (or the active config changes underneath). The copy is chosen at OPEN time
        // (active-vs-inactive wording), but the DESTRUCTIVE decision — whether to disconnect first —
        // is RE-EVALUATED at CONFIRM time below against live `isLiveActive`/`isSwitching`. And the
        // confirm button is DISABLED while a switch is in flight so the user cannot delete a config
        // (least of all the active one) out from under a mid-flight swap.
        const activeAtOpen = isLiveActive(config.path);
        const ok = await confirm({
          title: activeAtOpen ? t("connection.delete.title_active") : t("connection.delete.title"),
          message: activeAtOpen
            ? t("connection.delete.body_active", { name: config.name })
            : t("connection.delete.body", { name: config.name }),
          variant: "danger",
          confirmText: activeAtOpen ? t("connection.delete.confirm_active") : t("connection.delete.confirm"),
          cancelText: t("connection.delete.cancel"),
          // FAB-05: block the confirm while a switch is in flight — a delete landing mid-swap would
          // race the teardown/reconnect (and delete the .toml the swap is connecting).
          confirmDisabled: isSwitching,
        });
        if (!ok) return;
        // FAB-05: re-check at CONFIRM time. If a switch is in flight now (started while the dialog was
        // open), abort the delete entirely — the swap owns the connection lifecycle right now.
        if (isSwitching) return;
        try {
          // D-03: an ACTIVE config must disconnect BEFORE the file is removed — never delete
          // the .toml out from under a live tunnel. Re-evaluate active at CONFIRM time (the active
          // config may have changed while the dialog was open).
          if (isLiveActive(config.path)) await onDisconnect();
          await invoke("delete_config", { id: config.id });
          await reload();
          pushSnack(t("connection.snackbar.config_deleted"));
        } catch (e) {
          pushSnack(formatError(e), "error");
        }
      },
      [isLiveActive, isSwitching, confirm, onDisconnect, reload, pushSnack, t],
    );

    // ─── Rename (Enter/✓ commits via rename_config; returns an error string on failure) ───
    const handleRename = useCallback(
      async (config: ConfigSummary, newName: string): Promise<string | void> => {
        try {
          await invoke("rename_config", { id: config.id, name: newName });
          await reload();
          pushSnack(t("connection.snackbar.config_renamed"));
        } catch (e) {
          // Surface the failure inline in the card's FieldError (the rename stays open).
          return formatError(e);
        }
      },
      [reload, pushSnack, t],
    );

    // After a per-config save the card may need a fresh summary (name/host unchanged here,
    // but a re-read keeps the manifest authoritative).
    const handleConfigChanged = useCallback(() => {
      void reload();
    }, [reload]);

    return (
      <div ref={scrollerRef} className="h-full overflow-y-auto p-[var(--space-4)]">
        <ConfigList
          configs={visibleConfigs}
          loading={loading}
          onImport={onImport}
          pings={pings}
          status={status}
          activeConfigPath={activeConfigPath}
          onConnect={handleCardConnect}
          onEdit={openEdit}
          onQr={openQr}
          onDelete={handleDelete}
          onDuplicate={handleDuplicate}
          onRename={handleRename}
          isSwitching={isSwitching}
          pendingConnectPath={pendingConnectPath}
          revertNotice={revertNotice}
          onRevertDismiss={onRevertDismiss}
          reconnectProgress={reconnectProgress}
        />
        {/* Per-config settings modal — kept MOUNTED while a config is selected so the
            Modal exit animation plays on close (parent must not early-return null). */}
        {editConfig && (
          <ConfigEditView
            isOpen={editOpen}
            onClose={closeEdit}
            configPath={editConfig.path}
            configName={editConfig.name}
            isActiveConfig={isLiveActive(editConfig.path)}
            status={status}
            onReconnect={onReconnect}
            onConfigChange={handleConfigChanged}
            // Phase 14 (D-13): lock the active-config save while a switch is in flight (a re-save
            // would fire a competing reconnect). ConfigEditView only acts on isActiveConfig.
            isSwitching={isSwitching}
          />
        )}
        {/* Per-config QR/link transfer modal (D-09) — kept MOUNTED while a config is selected
            so the Modal exit animation plays on close (parent must not early-return null). The
            deeplink is generated LOCALLY (export_config_deeplink_local) inside ConfigQr — no SSH. */}
        {qrConfig && (
          <ConfigQr isOpen={qrOpen} onClose={closeQr} config={qrConfig} />
        )}
      </div>
    );
  },
);
