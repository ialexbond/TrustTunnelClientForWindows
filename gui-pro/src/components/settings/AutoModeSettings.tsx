import { useState, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Wand2, HelpCircle, GripVertical } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Toggle } from "../../shared/ui/Toggle";
import { Tooltip } from "../../shared/ui/Tooltip";
import { NumberInput } from "../../shared/ui/NumberInput";
import { useAppSettings, AUTO_SWITCH_BOUNDS } from "../../shared/hooks/useAppSettings";
import { useConfigList, type ConfigSummary } from "../../shared/hooks/useConfigList";

/**
 * Production «Авто-режим» settings section (Phase 12, plan 12-06).
 *
 * The single unified auto-mode card the owner sees on the «Настройки» tab (D-12). It is the
 * production port of `connection/AutoModeSettings.stories.tsx` — same Card + CardHeader (one
 * Wand2 header icon, no per-row icons) + a stack of 3 Toggle rows on the canonical settings-row
 * pattern (`settings/GeneralSection.tsx`) — but the demo's local `useState` is replaced by the
 * persisted `useAppSettings` store (12-03), and the priority list is backed by the live config
 * manifest with real `reorder_configs` persistence (12-02).
 *
 * D-24/F08: the auto-best params (threshold/interval/checks NumberInputs + priority list) are
 * NOT rendered at all when the master toggle is OFF (hidden entirely, never disabled-but-visible).
 *
 * D-01: the «Автоподключение при запуске» label/description/tooltip describe the honest LAST-USED
 * behavior — no fastest-server / ping-on-launch promise.
 *
 * D-06: the notifications toggle persists a real boolean (Phase 13 reads it); no plashka renders here.
 */

/** «?» help affordance on a setting label — the canonical pattern (HelpCircle in a Tooltip),
 *  matching settings/GeneralSection.tsx. Extra detail lives on hover, NOT as a line under the field. */
function HelpHint({ text }: { text: string }) {
  return (
    <Tooltip text={text}>
      <HelpCircle
        className="w-3 h-3 cursor-help"
        style={{ color: "var(--color-text-muted)" }}
        aria-hidden="true"
      />
    </Tooltip>
  );
}

/** A labelled numeric parameter: label + «?» help on the SAME line, the input below. The input uses
 *  errorDisplay="none" so there is NO muted helper line under the field (the «?» carries the help).
 *
 *  UAT (Phase 12 owner test): the bounds must NOT be clamped on every keystroke — otherwise typing
 *  «300» into the threshold field snapped to the 150 minimum after the first digit and the value could
 *  never be reached. Fix: keep a LOCAL draft string for free typing; clamp + commit to the persisted
 *  store ONLY on blur (`commit`). The committed `value` prop flows back in (the store re-broadcasts on
 *  write — see useAppSettings CR-01) and re-seeds the draft via the effect, so the field shows the
 *  clamped result after the user leaves it. An empty/invalid draft on blur reverts to the last value. */
function NumberParam({
  label,
  help,
  value,
  onCommit,
  min,
  max,
  maxLength,
  ariaLabel,
}: {
  label: string;
  help: string;
  value: string;
  onCommit: (n: number) => void;
  min: number;
  max: number;
  maxLength: number;
  ariaLabel: string;
}) {
  const [draft, setDraft] = useState(value);
  // Re-seed the draft when the committed value changes (blur-clamp result, or a cross-instance sync).
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === "" || !Number.isFinite(n)) {
      setDraft(value); // incomplete/garbage → revert to the last committed value
      return;
    }
    onCommit(n); // parent clamps + persists; the value prop flows back and re-seeds draft
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1">
        <span className="text-sm font-medium text-[var(--color-text-secondary)]">{label}</span>
        <HelpHint text={help} />
      </div>
      <NumberInput
        value={draft}
        onChange={setDraft}
        onBlur={commit}
        min={min}
        max={max}
        maxLength={maxLength}
        aria-label={ariaLabel}
        errorDisplay="none"
      />
    </div>
  );
}

/**
 * The config priority order for auto-connect-to-best. No pinned favourite — only the row order
 * matters (D-05). Two reorder paths, both persisted via `reorder_configs` (12-02):
 *  1. DRAG — the whole row is the handle (grab anywhere). Plain HTML5 drag; rows reorder live as you
 *     drag over a neighbour. NO View Transitions / flushSync — those promoted each row to the browser
 *     top layer and painted OVER the fixed bottom tab bar, and the synchronous flush on every
 *     dragEnter made scroll-while-dragging janky (Phase 12 owner UAT).
 *  2. KEYBOARD (F19) — focus a row (it is tabbable) and press ArrowUp / ArrowDown to move it ±1.
 *     NO visible arrow buttons (owner UAT: the per-row ▲▼ buttons were removed). Drag is mouse-only;
 *     the keyboard arrows are the accessible path.
 * Because screen readers do NOT re-announce a changed static `aria-label`, a visually-hidden
 * `aria-live="polite"` region pushes «<имя> — позиция N из M» on EACH move. After a keyboard move,
 * focus follows the row to its new slot so repeated presses keep moving it.
 */
function PriorityList({ configs, locked = false }: { configs: ConfigSummary[]; locked?: boolean }) {
  const { t } = useTranslation();
  const [order, setOrder] = useState<ConfigSummary[]>(configs);
  const [dragId, setDragId] = useState<string | null>(null);

  // WR-01: `configs` arrives asynchronously (useConfigList starts [] then populates via
  // list_configs). The initial useState seed copies it ONCE, so when the master toggle is
  // persisted ON the params block mounts while configs is still [] — leaving the priority list
  // permanently empty even after the real list arrives. Re-sync local order whenever the SET of
  // ids changes (id-set signature), so the async-arrived list seeds the order, while a pure
  // refresh that returns the SAME ids (WR-02: list_configs hoists last-used first) does NOT
  // clobber a reorder the user just performed. The signature is order-independent (sorted) so a
  // reorder alone never re-triggers this; only added/removed configs do.
  const idSignature = useMemo(
    () => configs.map((c) => c.id).sort().join("|"),
    [configs],
  );
  useEffect(() => {
    // Do not yank the list out from under an in-progress drag.
    if (dragId !== null) return;
    setOrder(configs);
    // Re-seed only when the id SET changes — see idSignature note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: key on the id-set signature, not the array identity
  }, [idSignature]);
  // The live-region message re-announced on each reorder (drag drop or keyboard move).
  const [announce, setAnnounce] = useState("");
  // After a keyboard move we want focus to follow the row to its new slot. Record the moved id; the
  // row ref map lets us re-focus the same <li> after the reorder re-renders.
  const rowRefs = useRef<Map<string, HTMLLIElement | null>>(new Map());
  const pendingFocusId = useRef<string | null>(null);

  // Persist the current top-to-bottom id order to the manifest (best-effort, optimistic — the
  // local order already reflects the move; a failed persist just leaves the optimistic order).
  const persistOrder = (next: ConfigSummary[]) => {
    void invoke("reorder_configs", { ids: next.map((c) => c.id) }).catch(() => {
      // optimistic: keep the local order on a transient persist failure
    });
  };

  // Re-announce a config's position via the live region (F19).
  const announcePosition = (cfg: ConfigSummary, position: number, total: number) => {
    setAnnounce(
      t("settings.autoMode.priority_position_announce", { name: cfg.name, position, total }),
    );
  };

  // Move a row by ±1 via the keyboard arrows. Persists, announces, and returns focus to the row.
  const moveBy = (id: string, dir: "up" | "down") => {
    // Phase 14 (D-13): a mid-switch reorder is a competing state change (it re-persists priority
    // order that useAutoSwitch reads). While locked, swallow the move — no reorder_configs fires.
    if (locked) return;
    setOrder((prev) => {
      const from = prev.findIndex((c) => c.id === id);
      if (from === -1) return prev;
      const to = dir === "up" ? from - 1 : from + 1;
      if (to < 0 || to >= prev.length) return prev; // bounds
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      persistOrder(next);
      announcePosition(moved, to + 1, next.length);
      pendingFocusId.current = id;
      return next;
    });
  };

  // After a keyboard move re-renders the new order, return focus to the moved row so repeated
  // ArrowUp/Down keeps the focus on the item.
  useEffect(() => {
    const id = pendingFocusId.current;
    if (!id) return;
    pendingFocusId.current = null;
    rowRefs.current.get(id)?.focus();
  }, [order]);

  // Live reorder while dragging: entering another row moves the dragged item to that slot, so the
  // list rearranges under the cursor. Plain state update — no View Transitions / flushSync.
  const reorderOver = (overId: string) => {
    if (locked) return; // D-13: no drag reorder while a switch is in flight
    if (!dragId || dragId === overId) return;
    setOrder((prev) => {
      const from = prev.findIndex((c) => c.id === dragId);
      const to = prev.findIndex((c) => c.id === overId);
      if (from === -1 || to === -1) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  return (
    <>
      <ul className="flex flex-col gap-[var(--space-2)]" aria-label={t("settings.autoMode.priority_list_aria")}>
        {order.map((cfg, i) => {
          const dragging = cfg.id === dragId;
          return (
            <li
              key={cfg.id}
              ref={(el) => {
                rowRefs.current.set(cfg.id, el);
              }}
              tabIndex={0}
              // D-13: while a switch is in flight the row is not draggable (a drag reorder persists a
              // competing priority order). Keyboard moves are swallowed in moveBy; drag is blocked here.
              draggable={!locked}
              onDragStart={(e) => {
                if (locked) {
                  e.preventDefault();
                  return;
                }
                setDragId(cfg.id);
                e.dataTransfer.effectAllowed = "move";
              }}
              onDragEnter={() => reorderOver(cfg.id)}
              onDragOver={(e) => e.preventDefault()}
              onDragEnd={() => {
                // Phase 14 (IN-01): if a switch STARTED while this drag was already underway, `locked`
                // flipped true mid-drag. reorderOver already refuses NEW moves while locked, but the
                // drag-end still reached persistOrder here — persisting a competing priority order the
                // auto-switch engine reads mid-switch. Bail out cleanly (drop the drag, persist
                // nothing) so the lock is atomic against an in-flight drag too. The optimistic local
                // order equals the pre-lock order, so nothing visible is lost.
                if (locked) {
                  setDragId(null);
                  return;
                }
                // WR-03: persist/announce from the LATEST committed order, not the `order`
                // captured by this row's render closure. The functional updater always sees the
                // current state.
                setOrder((cur) => {
                  persistOrder(cur);
                  const idx = cur.findIndex((c) => c.id === cfg.id);
                  if (idx !== -1) announcePosition(cfg, idx + 1, cur.length);
                  return cur; // no change — just read the latest committed order
                });
                setDragId(null);
              }}
              onDrop={() => setDragId(null)}
              onKeyDown={(e) => {
                // Keyboard reorder (F19): ArrowUp/ArrowDown move the focused row. preventDefault so
                // the list does not also scroll the page while reordering.
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  moveBy(cfg.id, "up");
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  moveBy(cfg.id, "down");
                }
              }}
              aria-label={t("settings.autoMode.priority_position_announce", {
                name: cfg.name,
                position: i + 1,
                total: order.length,
              })}
              className={`flex cursor-grab select-none items-center gap-[var(--space-2)] rounded-[var(--radius-md)] border bg-[var(--color-bg-surface)] px-[var(--space-2)] py-[var(--space-2)] transition-colors focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] focus-visible:border-[var(--color-input-focus)] active:cursor-grabbing ${
                dragging
                  ? "border-[var(--color-input-focus)] opacity-60 shadow-[var(--focus-ring)]"
                  : "border-[var(--color-border)]"
              }`}
            >
              <GripVertical className="w-4 h-4 shrink-0" style={{ color: "var(--color-text-muted)" }} aria-hidden="true" />
              <span className="w-5 shrink-0 text-center text-xs font-mono" style={{ color: "var(--color-text-muted)" }} aria-hidden="true">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>{cfg.name}</span>
              <span className="hidden shrink-0 max-w-[140px] truncate font-mono text-xs sm:inline" style={{ color: "var(--color-text-muted)" }}>{cfg.host}</span>
            </li>
          );
        })}
      </ul>
      {/* Visually-hidden live region — screen readers re-announce the moved item's new position on
          EACH reorder (a static per-row aria-label is NOT re-announced — F19). */}
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
    </>
  );
}

interface AutoModeSettingsProps {
  /** Fired after any setting change persists — App wires it to the «Сохранено» snackbar, the
   *  SAME affordance the sibling sections (GeneralSection/AppearanceSection) use (12-07). */
  onSaved?: () => void;
  /**
   * Phase 14 (D-13): a seamless A→B switch is in flight (App-owned isSwitching, threaded down). While
   * true, the master toggle + priority reorder are LOCKED — a mid-switch master-on arms useAutoSwitch
   * (Pitfall 5: it re-seeds on [masterOn, status, activeConfigPath]) and a reorder re-persists priority
   * order the engine reads, either of which could fire a COMPETING switch. Reuses the existing disabled
   * idiom (no parallel lock); re-enables atomically when the single App flag flips on settle.
   */
  locked?: boolean;
}

export function AutoModeSettings({ onSaved, locked = false }: AutoModeSettingsProps = {}) {
  const { t } = useTranslation();
  const {
    settings,
    setMasterOn,
    setThresholdMs,
    setIntervalSec,
    setChecksN,
    setAutoConnectOnLaunch,
    setNotificationsOn,
  } = useAppSettings();
  const { configs } = useConfigList();

  const {
    masterOn,
    thresholdMs,
    intervalSec,
    checksN,
    autoConnectOnLaunch,
    notificationsOn,
  } = settings;

  // WR-02: list_configs always returns the list sorted last-used-first (manifest.rs sorts
  // `last_used DESC, order ASC`), but the priority list must show the user's SWITCH-PRIORITY
  // order — the raw manifest `order` (D-02/D-05), independent of the lead-card last-used sort.
  // Sort by `order` ascending here so a refresh never snaps the last-used config to slot 1 and
  // clobbers the drag the user just performed.
  const orderedConfigs = useMemo(
    () => [...configs].sort((a, b) => a.order - b.order),
    [configs],
  );

  // Wrap each setter so a change both persists (useAppSettings) AND flashes the «Сохранено»
  // snackbar — matching GeneralSection/AppearanceSection which call onSaved on every change.
  const saved =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      onSaved?.();
    };

  return (
    <Card padding="md">
      {/* ONE section, ONE header icon (no per-row icon clutter). */}
      <CardHeader
        icon={<Wand2 className="w-4 h-4" />}
        title={t("settings.autoMode.title")}
        description={t("settings.autoMode.description")}
      />

      <div className="space-y-0.5">
        {/* Auto-connect to the best server (the renamed, self-explaining «auto-switch»). */}
        <Toggle
          value={masterOn}
          onChange={saved(setMasterOn)}
          // D-13: locked while a switch is in flight — flipping master-on mid-switch would arm
          // useAutoSwitch and could fire a competing switch (Pitfall 5).
          disabled={locked}
          label={t("settings.autoMode.auto_best_label")}
          description={t("settings.autoMode.auto_best_desc")}
          labelExtra={<HelpHint text={t("settings.autoMode.auto_best_help")} />}
        />

        {/* The auto-best parameters appear only when it is ON (D-24/F08: off → not in the DOM). */}
        {masterOn && (
          <div className="ml-[var(--space-2)] mt-[var(--space-3)] flex flex-col gap-[var(--space-5)] border-l-2 border-[var(--color-accent-interactive)] pl-[var(--space-4)]">
            <NumberParam
              label={t("settings.autoMode.threshold_label")}
              help={t("settings.autoMode.threshold_help")}
              value={String(thresholdMs)}
              onCommit={saved(setThresholdMs)}
              min={AUTO_SWITCH_BOUNDS.thresholdMs.min}
              max={AUTO_SWITCH_BOUNDS.thresholdMs.max}
              maxLength={4}
              ariaLabel={t("settings.autoMode.threshold_label")}
            />
            <NumberParam
              label={t("settings.autoMode.interval_label")}
              help={t("settings.autoMode.interval_help")}
              value={String(intervalSec)}
              onCommit={saved(setIntervalSec)}
              min={AUTO_SWITCH_BOUNDS.intervalSec.min}
              max={AUTO_SWITCH_BOUNDS.intervalSec.max}
              maxLength={3}
              ariaLabel={t("settings.autoMode.interval_label")}
            />
            <NumberParam
              label={t("settings.autoMode.checks_label")}
              help={t("settings.autoMode.checks_help")}
              value={String(checksN)}
              onCommit={saved(setChecksN)}
              min={AUTO_SWITCH_BOUNDS.checksN.min}
              max={AUTO_SWITCH_BOUNDS.checksN.max}
              maxLength={2}
              ariaLabel={t("settings.autoMode.checks_label")}
            />
            <div>
              <div className="mb-[var(--space-2)] flex items-center gap-1">
                <span className="text-sm font-medium text-[var(--color-text-secondary)]">{t("settings.autoMode.priority_label")}</span>
                <HelpHint text={t("settings.autoMode.priority_help")} />
              </div>
              <PriorityList configs={orderedConfigs} locked={locked} />
            </div>
          </div>
        )}

        {/* Auto-connect on startup — D-01: honest LAST-USED wording (no fastest-server promise). */}
        <Toggle
          value={autoConnectOnLaunch}
          onChange={saved(setAutoConnectOnLaunch)}
          label={t("settings.autoMode.auto_connect_launch_label")}
          description={t("settings.autoMode.auto_connect_launch_desc")}
          labelExtra={<HelpHint text={t("settings.autoMode.auto_connect_launch_help")} />}
        />

        {/* Connection-event notifications toggle — GENERAL (every VPN state change). D-06: the per-state
            plashka render lands in Phase 13; here it only persists the real boolean (NOT a dead button). */}
        <Toggle
          value={notificationsOn}
          onChange={saved(setNotificationsOn)}
          label={t("settings.autoMode.notifications_label")}
          description={t("settings.autoMode.notifications_desc")}
          labelExtra={<HelpHint text={t("settings.autoMode.notifications_help")} />}
        />
      </div>
    </Card>
  );
}
