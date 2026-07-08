import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { i18n as I18nType } from "i18next";
import type { ConfigSummary } from "./useConfigList";
import type { VpnStatus } from "../types";
import { ADAPTER_CONFLICT_EVENT, type AdapterConflictEvent } from "../ipc/events";
import { formatError } from "../utils/formatError";
import { markSelfDelete, clearSelfDelete } from "../utils/selfDeleteGuard";
import type { ConfirmFn } from "../ui/ConfirmDialogProvider";

/**
 * `useConfigMutations` (PA-5, Phase 17 / 17-07) — the config-list IPC pulled OUT of
 * `ConnectionPanel` so that component only RENDERS. It owns:
 *
 *   - the two `listen` subscriptions the panel used to run inline:
 *       • `configs-changed` — the Rust fs-watcher's «a config appeared/disappeared on disk»
 *         signal → a SILENT list refresh (no skeleton, scroll preserved);
 *       • `vpn-adapter-conflict` — the second-VPN (Amnezia/WireGuard) contention warning
 *         (typed `AdapterConflictEvent`, PA-1) → lifted into `banner` state for the panel to
 *         render as the reused `ErrorBanner variant="warning"`;
 *   - the three manifest MUTATION `invoke` calls:
 *       • `duplicate_config` → reveal-reload + success snackbar;
 *       • `delete_config` → the full delete domain flow (D-03 disconnect-then-delete, the B2/#7
 *         self-delete guard with its TTL timing, the FAB-05 mid-switch abort) preserved VERBATIM;
 *       • `rename_config` → reload + snackbar, returns an error string on rejection (D-14).
 *
 * This mirrors the `useConfigLifecycle` extraction that moved `config-file-changed` out of App:
 * the domain logic is unchanged, only its home moved. The panel passes in the VPN-action and
 * list callbacks it already holds; the hook returns render-ready handlers + the banner state.
 *
 * PA-4 (17-07): the mutation commands now return `Result<(), String>` (was a discarded
 * `Vec<ConfigSummary>`). These callers already re-invoked `list_configs` via reload/refresh, so
 * nothing changes here beyond the command no longer handing back a list we ignored.
 */

/** The second-VPN conflict banner state, lifted from the `vpn-adapter-conflict` event. */
interface ConflictBanner {
  /** True when a conflict is present AND not dismissed for this exact adapter set. */
  show: boolean;
  /** The conflicting adapter names (D-29 — never an endpoint/secret). Empty when no conflict. */
  adapters: string[];
  /** Dismiss the banner for the CURRENT adapter set (session-scoped, per-adapter-key). */
  dismiss: () => void;
}

interface UseConfigMutationsParams {
  /** Live VPN status — drives the delete disconnect-first decision + the connect-edge banner reset. */
  status: VpnStatus;
  /** Path of the currently active/connected config (the file the active-config watcher follows). */
  activeConfigPath: string;
  /** True while a seamless A→B switch is in flight (FAB-05: blocks a mid-switch delete). */
  isSwitching: boolean;
  /** Is THIS path the LIVE active config (path matches AND a tunnel is up/in-flight)? */
  isLiveActive: (path: string) => boolean;
  /** Disconnect the active tunnel (the switch-GUARDED handler App threads in). */
  onDisconnect: () => Promise<void> | void;
  /** Re-fetch the manifest list WITH the loading skeleton (delete/rename after-mutation reload). */
  reload: () => Promise<void> | void;
  /** Re-fetch the manifest list SILENTLY (the `configs-changed` fs-watcher refresh). */
  refresh: () => Promise<void> | void;
  /** Re-fetch the list AND reveal the new card (a duplicate is a user-add — reveal the copy). */
  reloadAndReveal: () => Promise<void> | void;
  /** The danger confirm dialog (useConfirm) — the delete gate. */
  confirm: ConfirmFn;
  /** Push a snackbar (success default, "error" for a failure). */
  pushSnack: (message: string, variant?: "success" | "error") => void;
  /** i18n translate. */
  t: I18nType["t"];
}

export interface UseConfigMutationsResult {
  /** «Дублировать» → duplicate_config → reveal-reload. */
  handleDuplicate: (config: ConfigSummary) => Promise<void>;
  /** «Удалить» → danger confirm → (D-03 disconnect-then-delete) → delete_config → reload. */
  handleDelete: (config: ConfigSummary) => Promise<void>;
  /** Inline rename commit → rename_config; resolves to an error string on rejection (D-14). */
  handleRename: (config: ConfigSummary, newName: string) => Promise<string | void>;
  /** The second-VPN conflict banner state (rendered by the panel as ErrorBanner warning). */
  banner: ConflictBanner;
}

export function useConfigMutations({
  status,
  activeConfigPath,
  isSwitching,
  isLiveActive,
  onDisconnect,
  reload,
  refresh,
  reloadAndReveal,
  confirm,
  pushSnack,
  t,
}: UseConfigMutationsParams): UseConfigMutationsResult {
  // ─── configs-changed: silent refresh the INSTANT the config data dir changes on disk ───
  // (IN-31) A config added/removed externally (e.g. deleted in the file manager). The Rust
  // fs-watcher emits `configs-changed`; we silent-refresh (no skeleton, scroll preserved) so a
  // deleted card disappears immediately. Mount-once, async-unlisten cleanup.
  useEffect(() => {
    const unlisten = listen("configs-changed", () => {
      void refresh();
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [refresh]);

  // ─── T-34: second-VPN conflict banner (Phase 16) ───
  // A running SECOND VPN client (Amnezia / WireGuard) contends for routes/adapter and can break the
  // tunnel. The Rust backend emits `vpn-adapter-conflict` { adapters, message } (own-adapter already
  // filtered T-21). useVpnEvents (App-level) still logs it; here we ALSO subscribe and lift the
  // payload into local state so the panel can render the reused ErrorBanner variant="warning" atop
  // the tab body (LOCKED contract — NO SecondVpnBanner component). Dismiss is keyed per-adapter-name
  // and session-scoped: dismissing stores the current adapter key; the SAME conflicting adapter
  // re-firing recomputes the same key → stays hidden (no re-nag on every connect), while a
  // NEW/DIFFERENT adapter set yields a different key → re-shows the banner.
  const [conflict, setConflict] = useState<{ adapters: string[]; message: string } | null>(null);
  const [dismissedAdapterKey, setDismissedAdapterKey] = useState<string | null>(null);
  useEffect(() => {
    const unlisten = listen<AdapterConflictEvent>(ADAPTER_CONFLICT_EVENT, (event) => {
      setConflict({ adapters: event.payload.adapters, message: event.payload.message });
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);
  // Fable review #151: clear a stale conflict at the START of each connect attempt. The Rust
  // detection thread re-emits `vpn-adapter-conflict` ~1s after every vpn_connect, so a conflict
  // that is STILL present re-shows on its own; one the user already resolved (disabled the other
  // VPN — the banner's own advice) produces no event, so the banner correctly disappears instead
  // of asserting a resolved conflict for the rest of the session. The event fires only on a
  // non-empty conflict set (vpn.rs), so there is no all-clear signal to rely on — the connect
  // edge is the reset point. `dismissedAdapterKey` is left intact so a within-session dismiss
  // still holds; a fresh connect that re-detects the SAME adapter re-emits and (if not dismissed
  // this session) re-shows.
  useEffect(() => {
    if (status === "connecting") setConflict(null);
  }, [status]);
  const adapterKey = conflict?.adapters.join("|") ?? null;
  const showBanner = !!conflict && adapterKey !== dismissedAdapterKey;
  const dismissBanner = useCallback(() => {
    setDismissedAdapterKey(adapterKey);
  }, [adapterKey]);

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
        // B2 (16-UAT round 2): mark the paths this in-app delete will remove so the fs-watcher on
        // the ACTIVE config does not raise a SECOND (red) «Конфиг удалён» snackbar on top of the
        // green success below (the double-snackbar bug). We mark both the card's own path AND the
        // current activeConfigPath (the file the watcher actually watches — usually the same, but a
        // delete of the active card while its path form differs is covered). B6: delete_config now
        // sweeps same-server twins, but only the ACTIVE `.toml` is watched, so marking the active
        // path is sufficient to suppress the one watcher event a sweep can trigger.
        //
        // #7 (Fable re-review): the mark is set HERE — AFTER `await onDisconnect()`, immediately
        // before invoke("delete_config") — NOT before the disconnect. The disconnect teardown can
        // take up to ~7s (graceful 1.5s + hard-kill confirm + DNS restore); marking before it
        // meant the guard's TTL could expire DURING the disconnect, so the mark was already gone by
        // the time the fs Remove landed → the watcher saw an UNMARKED delete and fired the red
        // snackbar on top of the green success (the B2 bug resurfacing on its flagship case:
        // deleting the ACTIVE config while CONNECTED). The file cannot be removed during the
        // disconnect leg — delete_config has not run yet — so nothing is lost by marking later, and
        // the TTL now covers only the short delete → reload round-trip.
        markSelfDelete(config.path);
        if (activeConfigPath) markSelfDelete(activeConfigPath);
        await invoke("delete_config", { id: config.id });
        await reload();
        pushSnack(t("connection.snackbar.config_deleted"));
      } catch (e) {
        pushSnack(formatError(e), "error");
      } finally {
        // Clear the guard once the reload has settled (a TTL backstop in the guard clears it
        // anyway if this is skipped). After this point a GENUINE external delete of the same
        // path warns normally again.
        clearSelfDelete(config.path);
        if (activeConfigPath) clearSelfDelete(activeConfigPath);
      }
    },
    [isLiveActive, isSwitching, activeConfigPath, confirm, onDisconnect, reload, pushSnack, t],
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

  return {
    handleDuplicate,
    handleDelete,
    handleRename,
    banner: {
      show: showBanner,
      adapters: conflict?.adapters ?? [],
      dismiss: dismissBanner,
    },
  };
}
