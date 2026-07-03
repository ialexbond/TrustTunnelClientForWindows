import { useMemo, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Inbox, Plus } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { EmptyState } from "../../shared/ui/EmptyState";
import { Skeleton } from "../../shared/ui/Skeleton";
import { samePath } from "../../shared/utils/samePath";
import { ConfigCard } from "./ConfigCard";
import type { ConfigPing } from "./ConfigPingPill";
import type { ConfigSummary } from "../../shared/hooks/useConfigList";
import type { VpnStatus, ReconnectProgress } from "../../shared/types";

interface ConfigListProps {
  configs: ConfigSummary[];
  loading: boolean;
  /** Opens the import modal (wired by ConnectionPanel/App in later waves). */
  onImport: () => void;
  /** Resolved ping bands per config id (from usePerConfigPing). Absent → no-data «—». */
  pings?: Record<string, ConfigPing>;
  /** Per-card action callbacks (wired by ConnectionPanel). */
  onConnect?: (config: ConfigSummary) => void;
  onEdit?: (config: ConfigSummary) => void;
  onDelete?: (config: ConfigSummary) => void;
  onDuplicate?: (config: ConfigSummary) => void;
  /** Commit a rename for a config; resolves to an error string on rejection (D-14). */
  onRename?: (config: ConfigSummary, newName: string) => Promise<string | void> | string | void;
  /** The live VPN status for the active/lead config (drives the lead-card lifecycle). */
  status?: VpnStatus;
  /** Path of the currently active/connected config. When set, the matching card becomes the
   *  connected lead and OTHER cards read «Переключиться» (D-20). Matched by normalized path
   *  (samePath), not raw `===`, because this path and the manifest paths come from different
   *  string sources (11-UAT gaps B/C). */
  activeConfigPath?: string;
  /**
   * Phase 14 (D-12): a seamless A→B switch is in flight (App-level FE-only flag, threaded
   * App→ConnectionPanel→here). OR'd into the leadIsLive gate below so the frosted sticky hero
   * stays mounted + hoisted through the transient `disconnected` the teardown emits, and the
   * lead card renders the amber «Переключение» face (passed as `switching` to the lead ConfigCard).
   */
  isSwitching?: boolean;
  /**
   * F28 (14-UAT round 3): the path of the config whose connect was just clicked (pre-`connecting`
   * window). The card matching it (samePath) shows an instant spinner; ANY non-null value locks the whole
   * list. Cleared by App once the live status takes over. `null`/absent → nothing pending.
   */
  pendingConnectPath?: string | null;
  /**
   * Phase 14 (F6, 14-UAT): the switch-failed-reverted notice, threaded to the LEAD ConfigCard where
   * it renders EMBEDDED inside the active card (not a floating window-level banner). Only the lead
   * card shows it; set/cleared by App.
   */
  revertNotice?: string | null;
  onRevertDismiss?: () => void;
  /**
   * F20 (14-UAT round 2): the live reconnect attempt progress {attempt, max}, shown ONLY on the LEAD
   * card as «Переподключение · Попытка N из M» (a resting inactive card has no reconnect state). `null`
   * whenever no per-attempt counter is live. Pure pass-through from App→ConnectionPanel→here.
   */
  reconnectProgress?: ReconnectProgress | null;
}

/** The active card carries the live status only while a tunnel is actually up or in flight.
 *  A settled "disconnected"/"error" means no live tunnel, so other cards read «Подключить»
 *  (not «Переключиться») and the active card shows its disconnected/error face. */
function isTunnelLive(status: VpnStatus): boolean {
  return status !== "disconnected" && status !== "error";
}

/**
 * `ConfigList` — the vertical stack of config cards that IS the «Подключение» tab surface
 * (Phase 11). It owns the three list-level states the live Storybook contract
 * (`ConfigList.stories.tsx`) specifies:
 *
 *   - `loading-skeleton` — card-shaped skeletons whose silhouette mirrors a real row, so
 *     swapping in real cards causes no layout shift (mirrors ServerPanelSkeleton).
 *   - `empty-no-configs` — `EmptyState` with ONE clear CTA «Импортировать конфиг».
 *   - populated — a `ConfigCard` per config. The CONNECTED config (matched to
 *     `activeConfigPath` by normalized path) is the LEAD card on top (sticky), hoisted there
 *     regardless of manifest order and carrying the live status; when nothing is connected the
 *     manifest last-used entry (configs[0], sorted last-used-first by Rust) leads. The rest
 *     are resting (inactive) rows.
 *
 * 11-UAT fix (gaps B/C/D): the active card used to be whichever entry happened to be
 * configs[0], with the live status reaching it only through a raw path `===`. Now the live
 * config is identified by `samePath` and hoisted to the lead, so the connected card always
 * shows green «Отключить» wherever it sits in the manifest. Each card carries a stable
 * `view-transition-name`; the reorder-to-top is animated by the caller committing the
 * active-config change inside a View Transition (App.handleConnectConfig → runViewTransition,
 * the same technique the story demos), so this component stays a pure render of the derived
 * order (no local order state) and the browser morphs each card from its old box to its new one.
 *
 * All colours/spacing come from tokens; icons are lucide-only (project rules).
 */
export function ConfigList({
  configs,
  loading,
  onImport,
  pings = {},
  onConnect,
  onEdit,
  onDelete,
  onDuplicate,
  onRename,
  status = "disconnected",
  activeConfigPath = "",
  isSwitching = false,
  pendingConnectPath = null,
  revertNotice,
  onRevertDismiss,
  reconnectProgress,
}: ConfigListProps) {
  const { t } = useTranslation();

  // ─── Active-config derivation (hooks must run before the loading/empty early returns) ───
  // The connected card is identified by NORMALIZED path match, not list position or raw `===`.
  const activeMatchId = useMemo(() => {
    if (!activeConfigPath) return undefined;
    return configs.find((c) => samePath(c.path, activeConfigPath))?.id;
  }, [configs, activeConfigPath]);

  // IN-52 — the wide, hoisted, STICKY "lead" treatment exists ONLY while a tunnel is LIVE on the
  // active config. With nothing connected the list is a plain UNIFORM list (owner's rule): every
  // card the same full width, in manifest sort order, so a freshly-added config lands at the BOTTOM
  // (not hoisted to the top, not rendered wider). A disconnected former-active config is NO longer
  // pinned/widened on top (that overrides the old IN-14 pin-on-top behaviour).
  //
  // Phase 14 (D-12): OR in isSwitching. During an A→B switch the teardown emits a TRANSIENT
  // `disconnected` for which isTunnelLive is false — that would demote the frosted hero to a plain
  // resting row mid-switch (the "dead-air" the owner reported: the active card reads as "gone").
  // Holding leadIsLive true while isSwitching keeps the sticky/frosted hero mounted + hoisted
  // continuously (activeConfigPath is already promoted to the TARGET at switch start, so the hero
  // shows the target server). IN-52 is UNCHANGED: with NO switch in flight and a SETTLED disconnect,
  // isSwitching is false → leadIsLive false → the hero treatment vanishes (the regression must-keep).
  const leadIsLive = Boolean(activeMatchId) && (isTunnelLive(status) || isSwitching);

  // Phase 14 (FAB-01): the cards are LOCKED not only during an App-owned switch (isSwitching) but
  // ALSO while the backend reconnect supervisor is running (`reconnecting`/`recovering`). A manual
  // «Переключиться» clicked during «Переподключение»/«Восстановление» would race the Rust
  // respawn_sidecar (silent wrong-server / double-spawn — FAB-01). Extending `locked` to those
  // states makes the cards VISIBLY locked (greyed primary + overflow + rename) exactly when a switch
  // is unsafe, matching performSwitch's early refusal in those states. Reuses the EXISTING `locked`
  // idiom (D-21) — no parallel mechanism. (The full Rust generation re-check FAB-R1 is BACKLOGGED.)
  // 3.4 R-DCT (14-UAT F13/Test-5): also lock while a teardown is in flight (the real `disconnecting`
  // wire status). The owner reported that during a disconnect the other cards' buttons stayed
  // clickable — a connect landing mid-teardown raced the kill. With the cards locked here AND the Rust
  // serializer (3.3), an action cannot start until the teardown settles.
  const listLocked =
    isSwitching ||
    // F28: a connect was just clicked and is in its pre-`connecting` window (awaited pre-connect probe).
    // Lock the whole list instantly so no rival action can start (same D-21 idiom) and every card reads
    // as busy — the target card also gets a spinner via `connectPending` below.
    Boolean(pendingConnectPath) ||
    // F31 (14-UAT round 3): also lock while `connecting` — a FRESH «Подключить» (not a switch, so
    // isSwitching is false) left the OTHER cards' «Переключиться» clickable for the whole «Подключение»
    // phase (the owner: switch locks everything, a plain connect did NOT — inconsistent, and clicking a
    // rival «Переключиться» mid-connect races the in-flight connect). `pendingConnectPath` covered only
    // the pre-`connecting` gap and is cleared once status flips to `connecting`; adding `connecting` here
    // completes the lock continuously through a connect AND a switch (a real switch's B is also
    // `connecting`, already covered by isSwitching — this is harmless overlap).
    status === "connecting" ||
    status === "reconnecting" ||
    status === "recovering" ||
    status === "disconnecting";

  // Hoist the live/active config to the top ONLY when it is live; otherwise keep the manifest sort
  // order (no hoist). Pure render — the reorder animation is driven by the caller wrapping the
  // active-config change in a View Transition (see component doc + runViewTransition).
  const order = useMemo(() => {
    if (configs.length === 0 || !leadIsLive) return configs;
    const leadCfg = configs.find((c) => c.id === activeMatchId) ?? configs[0];
    return [leadCfg, ...configs.filter((c) => c.id !== leadCfg.id)];
  }, [configs, activeMatchId, leadIsLive]);

  // IN-47: the skeleton may ONLY replace an EMPTY list (the genuine first load). It must never swap
  // out a populated list — doing so collapses the scroll container and clamps scrollTop to 0
  // (the scroll-reset-on-every-mutation bug). useConfigList only flips loading on the first load now;
  // this is the defensive belt so a future caller can't reintroduce the skeleton flash.
  if (loading && configs.length === 0) {
    return (
      <div
        data-testid="loading-skeleton"
        className="mx-auto flex w-full max-w-[1000px] flex-col gap-[var(--space-2)]"
      >
        {[0, 1, 2].map((i) => (
          <Card key={i} padding="sm">
            <div className="flex items-center gap-[var(--space-3)] min-w-0">
              {/* leading glyph slot (16px square — matches the ClipboardList glyph) */}
              <Skeleton variant="card" width={16} height={16} className="shrink-0" />
              {/* name + «host · username» */}
              <div className="flex flex-col gap-[var(--space-1)] flex-1 min-w-0">
                <Skeleton variant="line" width="45%" height={14} />
                <Skeleton variant="line" width="60%" height={10} />
              </div>
              {/* ping column — w-20 (80px), ~44px pill right-aligned */}
              <div className="flex w-20 shrink-0 items-center justify-end">
                <Skeleton rounded width={44} height={18} />
              </div>
              {/* action zone — 144px primary + 32px kebab */}
              <div className="flex items-center gap-[var(--space-1)] shrink-0 ml-[var(--space-4)]">
                <Skeleton variant="card" width={144} height={32} />
                <Skeleton variant="card" width={32} height={32} />
              </div>
            </div>
          </Card>
        ))}
      </div>
    );
  }

  if (configs.length === 0) {
    return (
      // IN-23: center the empty-state placeholder in the full tab height (the parent
      // ConnectionPanel is h-full). The wrapper itself had no height, so the placeholder
      // pinned to the top; `min-h-full` + flex centering centers it both ways. `min-h-full`
      // (not h-full) keeps it scroll-safe. Only the EMPTY branch centers — the loading and
      // populated branches stay top-aligned (a list grows from the top).
      <div
        data-testid="empty-no-configs"
        className="mx-auto flex min-h-full w-full max-w-[1000px] items-center justify-center"
      >
        <EmptyState
          icon={<Inbox className="w-12 h-12" aria-hidden="true" />}
          heading={t("connection.empty.heading")}
          body={t("connection.empty.body")}
          action={
            <Button variant="primary" size="sm" icon={<Plus className="w-4 h-4" />} onClick={onImport}>
              {t("connection.import.cta")}
            </Button>
          }
        />
      </div>
    );
  }

  const [lead, ...rest] = order;

  // All config names — passed to each resting card so the inline rename can flag a name that
  // collides with ANOTHER config (the card excludes its own current name).
  const allNames = configs.map((c) => c.name);

  // A stable per-config view-transition-name lets the browser pair the SAME card's old and new
  // box across the reorder (cast: the property is newer than the TS DOM lib here).
  const vtName = (id: string): CSSProperties => ({ viewTransitionName: `cfg-${id}` }) as CSSProperties;

  return (
    <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-[var(--space-3)]">
      <div className="flex flex-col gap-[var(--space-2)]">
        {leadIsLive ? (
          <>
            {/* LIVE connection — the connected config is the wide, sticky, FROSTED hero at the top;
                every other card sits 10px in on each side (IN-46) so the active card stands out by
                width (IN-52: the wide/lead treatment exists ONLY while a tunnel is live).

                IN-59 (the MATTE-GLASS look the owner wants): the hero wrapper is a FROSTED surface —
                a semi-transparent glass tint (--color-glass-bg-strong, 0.45) + a heavy
                backdrop-blur(20px) saturate(150%). The lead-card BODY stays transparent in EVERY live
                state (connecting / connected / disconnecting / reconnecting / recovering) so the frost
                shows through — connected additionally adds the 8% green tint + ring (see ConfigCard
                `activeHighlightClass`). The strong blur turns anything scrolling beneath into a soft,
                dimmed blur while the 0.45 tint stops it reading through SHARPLY (the IN-50 bleed the
                0.45 frost had). F9 (14-UAT): the wrapper is ROUNDED + clipped to --radius-lg so no
                SHARP frost corners peek out below/around the rounded card (the owner reported the
                square frost's bottom corners showing under the card) — the frost now matches the
                card's rounded box exactly. This supersedes the old IN-38 «square frost fills the
                corner triangles» treatment. No gap mask above (owner dropped it, IN-52). */}
            <div
              className="sticky top-0 z-10 overflow-hidden rounded-[var(--radius-lg)]"
              style={{
                ...vtName(lead.id),
                backgroundColor: "var(--color-glass-bg-strong)",
                backdropFilter: "blur(20px) saturate(150%)",
                WebkitBackdropFilter: "blur(20px) saturate(150%)",
              }}
            >
              <ConfigCard
                key={lead.id}
                config={lead}
                leadCard
                status={status}
                // Phase 14 (D-12): the lead card shows the amber «Переключение» face while a switch
                // is in flight — forces the amber band + label over the grey teardown status.
                switching={isSwitching}
                // F6 (14-UAT): the switch-failed-reverted notice renders EMBEDDED inside this lead card.
                revertNotice={revertNotice}
                onRevertDismiss={onRevertDismiss}
                // F20 (14-UAT round 2): the reconnect attempt counter — only the lead card is ever
                // in a reconnecting state.
                reconnectProgress={reconnectProgress}
                // Phase 14 (D-13): while a switch is in flight, LOCK the hero's overflow
                // (Изменить/Дублировать/Удалить) so a mid-switch action cannot race the swap. The
                // primary is already an inert spinner via `switching`, but `locked` also greys the
                // overflow menu. Reuse the EXISTING `locked` idiom (D-21) OR'd with isSwitching — do
                // NOT invent a parallel mechanism.
                locked={listLocked}
                // F28: instant spinner if THIS card's connect was just clicked (harmless alongside
                // `switching`, which already spins during a real switch).
                connectPending={pendingConnectPath != null && samePath(lead.path, pendingConnectPath)}
                activeElsewhere={false}
                ping={pings[lead.id]}
                existingNames={allNames}
                onConnect={onConnect ? () => onConnect(lead) : undefined}
                onEdit={onEdit ? () => onEdit(lead) : undefined}
                onDelete={onDelete ? () => onDelete(lead) : undefined}
                onDuplicate={onDuplicate ? () => onDuplicate(lead) : undefined}
                onRename={onRename ? (newName) => onRename(lead, newName) : undefined}
              />
            </div>
            {rest.map((config) => (
              <div key={config.id} className="mx-[10px]" style={vtName(config.id)}>
                <ConfigCard
                  config={config}
                  ping={pings[config.id]}
                  existingNames={allNames}
                  activeElsewhere
                  // Phase 14 (D-13): a mid-switch action on a resting card (a second
                  // «Переключиться», overflow edit/duplicate/delete, inline rename) must be inert
                  // until the swap settles — reuse the existing `locked` idiom (D-21) OR'd with
                  // isSwitching so ConfigCard disables its primary + overflow + rename in one shot.
                  locked={listLocked}
                  // F28: instant spinner if THIS resting card's «Переключиться»/connect was just clicked.
                  connectPending={pendingConnectPath != null && samePath(config.path, pendingConnectPath)}
                  onConnect={onConnect ? () => onConnect(config) : undefined}
                  onEdit={onEdit ? () => onEdit(config) : undefined}
                  onDelete={onDelete ? () => onDelete(config) : undefined}
                  onDuplicate={onDuplicate ? () => onDuplicate(config) : undefined}
                  onRename={onRename ? (newName) => onRename(config, newName) : undefined}
                />
              </div>
            ))}
          </>
        ) : (
          /* NOT CONNECTED (IN-52) — a plain UNIFORM list: NO hero, NO sticky, NO widening. Every card
             is the SAME full width in manifest sort order, so a freshly-added config lands at the
             BOTTOM and no card looks "active". All primaries read «Подключить» (activeElsewhere=false). */
          order.map((config) => (
            <div key={config.id} style={vtName(config.id)}>
              <ConfigCard
                config={config}
                ping={pings[config.id]}
                existingNames={allNames}
                activeElsewhere={false}
                // Phase 14 (D-13): lock every card while switching — even in the not-live list a
                // switch may be tearing down (transient disconnected), so an action here could race
                // the swap. Same `locked` idiom (D-21) OR'd with isSwitching, atomic re-enable on settle.
                locked={listLocked}
                // F28: instant spinner if THIS card's «Подключить» was just clicked (the common fresh-
                // connect path — the uniform not-connected list).
                connectPending={pendingConnectPath != null && samePath(config.path, pendingConnectPath)}
                onConnect={onConnect ? () => onConnect(config) : undefined}
                onEdit={onEdit ? () => onEdit(config) : undefined}
                onDelete={onDelete ? () => onDelete(config) : undefined}
                onDuplicate={onDuplicate ? () => onDuplicate(config) : undefined}
                onRename={onRename ? (newName) => onRename(config, newName) : undefined}
              />
            </div>
          ))
        )}
      </div>
      <div>
        <Button variant="secondary" size="sm" icon={<Plus className="w-4 h-4" />} onClick={onImport}>
          {t("connection.list.add")}
        </Button>
      </div>
    </div>
  );
}
