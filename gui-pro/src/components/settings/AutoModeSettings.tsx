import { useState, useRef, useEffect, useMemo, useId, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Wand2, ServerOff, Loader2, RotateCw } from "lucide-react";
import {
  Button,
  ErrorBanner,
  HelpHint,
  InsetPanel,
  PriorityRow,
  PrioritySkeletonRow,
  ReorderInstructions,
  RowToggle,
  SettingsCard,
  SettingsRow,
} from "../../shared/ui";
import { useAppSettings } from "../../shared/hooks/useAppSettings";
import { useConfigList, type ConfigSummary } from "../../shared/hooks/useConfigList";
import { applyQueueArrangement, visibleQueueConfigs } from "../../shared/utils/queueArrangement";

/**
 * «Авто-режим» — the failover card of the «Настройки» tab (Phase 28, plan 28-08).
 *
 * WHAT THIS CARD PROMISES NOW, and what it used to. Until 27 D-06 the master toggle offered
 * «автоподключение к лучшему серверу»: a frontend engine polled the active tunnel's latency and,
 * after N consecutive readings above a threshold, moved to a lower-ping candidate. Three numeric
 * preferences configured that engine. All of it is retired — the trigger lives in Rust now and fires
 * on a REAL LOSS of the tunnel (28-02), so the card promises exactly that and nothing about speed or
 * ping. 27 D-07 removed the three knobs with the engine they tuned; the card holds a permission and
 * a queue, and neither is a number.
 *
 * WHAT THE CARD DOES NOT PROMISE. There is no automatic return to the previous server once it
 * recovers, and the «?» on the master row says so: every automatic return is another few seconds
 * without a connection, and a «вернуться?» dialog is another window over the user's work. This is
 * the trade the owner accepted (28-CONTEXT D-02) — a server that reboots for 30 seconds displaces
 * the user until they switch back by hand.
 *
 * WHAT THE CARD OWNS versus what it merely displays: it owns the master permission
 * (`tt_auto_switch_enabled`, mirrored into the Rust-readable store) and the per-server participation
 * set (27 D-08, an EXCLUSION set so a newly added server is in the queue by default). The ORDER is
 * the config manifest's own order — the same one the «Подключение» tab shows — persisted through
 * `reorder_configs`. The card does not decide WHEN to switch; the connectivity layer does.
 *
 * The geometry is the Phase-27 design, assembled from the shared primitives promoted in 28-04/28-05
 * rather than redrawn here.
 */

interface AutoModeSettingsProps {
  /** Fired after any setting change persists — App wires it to the «Сохранено» snackbar, the
   *  SAME affordance the sibling sections (GeneralSection/AppearanceSection) use (12-07). */
  onSaved?: () => void;
  /**
   * WR-02: fired when a change did NOT reach the backend. Same slot as the confirmation (the
   * shared snackbar), because a change and its refusal are the same event to the user; the panel
   * renders a localized sentence and takes NO argument, so a backend string can never reach the
   * screen (T-28-20 / D-29).
   *
   * Why this section needs one at all, when 28-06 deliberately withheld it: «Авто-режим» now makes
   * a second backend call, `set_failover_settings`, and it is the one the whole feature depends
   * on. A refused reorder is cosmetic — the queue order is wrong until the next write. A refused
   * failover write is the feature being OFF in Rust while the card says ON, silently, for the rest
   * of the session.
   */
  onSaveFailed?: () => void;
  /**
   * Phase 14 (D-13): a seamless A→B switch is in flight (App-owned isSwitching, threaded down).
   * While true, the master toggle, every participation switch and the reorder are all HELD — a
   * mid-switch master-on arms the failover path and a reorder re-persists the queue it reads, either
   * of which could fire a COMPETING switch (Pitfall 5). Nothing is hidden and nothing new appears:
   * the controls stay exactly where they were and stop responding, and a status line above the panel
   * explains why. Re-enables atomically when the single App flag flips on settle.
   */
  locked?: boolean;
  /**
   * Path of the config the tunnel is actually running through, threaded from App.
   *
   * Needed because this list de-duplicates same-server twins exactly as «Подключение» does, and the
   * winner of a twin pair is the ACTIVE file when there is one. Without it the two tabs could pick
   * different twins and show different names for one server — a subtler version of the mismatch
   * that made them show different COUNTS.
   */
  activeConfigPath?: string;
}

// The props object carries NO `= {}` default. It used to, apparently harmlessly — every field is
// optional and React always passes an object anyway — but the defaulted destructure stopped the
// hooks compiler from tracking a prop used as a memo DEPENDENCY: adding `activeConfigPath` to the
// dependency list below cost the whole component its compilation («Existing memoization could not be
// preserved»), and dropping the default restored it. Verified by removing one thing at a time.
// `locked = false` keeps its own default — a per-field default is fine; it is the object-level one
// the analysis could not see through.
export function AutoModeSettings({
  onSaved,
  onSaveFailed,
  locked = false,
  activeConfigPath,
}: AutoModeSettingsProps) {
  const { t } = useTranslation();
  const {
    settings,
    setMasterOn,
    setAutoConnectOnLaunch,
    setNotificationsOn,
    setFailoverExcludedIds,
    reconcileFailoverFromRust,
  } = useAppSettings();
  const { configs, loading, error, reload } = useConfigList();

  const { masterOn, autoConnectOnLaunch, notificationsOn, failoverExcludedIds } = settings;

  /** «Подробнее: <подпись строки>» — the accessible name of a row's «?» trigger. */
  const helpLabel = (label: string) => t("settings.help_more_about", { label });

  // WR-02: list_configs always returns the list sorted last-used-first (manifest.rs sorts
  // `last_used DESC, order ASC`), but this list must show the user's SWITCH ORDER — the raw manifest
  // `order` — independent of the lead-card last-used sort. Sort by `order` ascending here so a
  // refresh never snaps the last-used config to slot 1 and clobbers the drag the user just performed.
  //
  // DE-DUPLICATED first, with the same helper and the same active-path tiebreak «Подключение» uses
  // (`ConnectionPanel`). The manifest can hold same-server twins — two `.toml` files with one
  // host+user, e.g. a legacy file beside a migrated one — and the Connection tab collapses them into
  // ONE card. This list did not, so the two tabs disagreed on how many servers exist: the owner
  // counted five on «Подключение» and six here (28-UAT). Whatever «Подключение» shows is what the
  // user thinks they have, and the queue must be a list of the same things.
  const orderedConfigs = useMemo(
    () => visibleQueueConfigs(configs, activeConfigPath),
    [configs, activeConfigPath],
  );

  // Wrap each setter so a change both persists (useAppSettings) AND flashes the «Настройки
  // сохранены» snackbar — matching GeneralSection/AppearanceSection, which call onSaved on every
  // change. A reorder and a participation change go through it too: they are settings like any
  // other, and answering them differently would make the tab inconsistent with itself.
  const saved =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      onSaved?.();
    };

  /**
   * WR-02: the two settings that must reach RUST, not just localStorage.
   *
   * `set_failover_settings` is what arms the connectivity monitor. A refusal used to be swallowed,
   * so the card could read ON while `app_settings.json` read OFF and failover was simply dead for
   * the session with nothing on screen saying so. Now the refusal reconciles the control back onto
   * the value Rust actually holds — the `revertTo()` shape from `GeneralSection`, a re-read rather
   * than a local inversion — and reports it in the shared snackbar.
   *
   * The confirmation is still optimistic (fired immediately, like every other row on this tab):
   * the write is a fire-and-forget IPC and holding «Настройки сохранены» behind it would make a
   * control that answers instantly today start lagging on the happy path.
   */
  const savedToRust =
    <T,>(setter: (v: T, onFailure?: () => void) => void) =>
    (v: T) => {
      setter(v, () => {
        void reconcileFailoverFromRust();
        onSaveFailed?.();
      });
      onSaved?.();
    };

  /* ---- the queue ---------------------------------------------------------------------------- */

  // ONLY the user's arrangement is state, and it holds IDS — the one thing the user decides here.
  // The rows themselves are derived from the manifest on every render, which is what makes a rename,
  // a deletion or an import appear with no refresh, no re-mount and no toggling the card off and on.
  //
  // This used to be the ROWS in state, seeded from the manifest and re-seeded only when the SET of
  // ids changed. That conflated two things that move independently — which servers exist and what
  // order to try them in — and quietly turned the copy into a snapshot of everything else: a rename
  // never reached this list, because the ids had not moved (owner, 28-UAT). It also forced a
  // setState-in-effect to keep the copy fed, which is the cascading-render shape the hooks compiler
  // rejects outright.
  //
  // Empty means «never rearranged» → the manifest's own order stands.
  const [arrangement, setArrangement] = useState<string[]>([]);
  const order = useMemo(
    () => applyQueueArrangement(arrangement, orderedConfigs),
    [arrangement, orderedConfigs],
  );
  // A mirror of the COMMITTED order, so `onDragEnd` can READ the latest order without abusing a
  // state updater as a getter (an updater is not a place side effects may live — see `moveBy`). A
  // drag ends in the same tick a `dragenter` may still be settling, so the handler's own render
  // closure is not guaranteed current; a ref is.
  //
  // Written in a LAYOUT effect, not during render. The assignment used to sit bare in the render
  // body, which is unsafe under concurrent rendering — a render React throws away would still have
  // mutated the ref. It went unreported for as long as it did because the old re-seed effect
  // violated the deps rule, and that made the hooks analyser bail on this component before reaching
  // this line; with the violation gone it is reported.
  //
  // Layout rather than passive: drag events are discrete, so React flushes the `dragenter` update —
  // and layout effects with it — before the browser dispatches `dragend`. A passive effect could
  // still be pending at that point, and `onDragEnd` would read a stale order.
  const orderRef = useRef(order);
  useLayoutEffect(() => {
    orderRef.current = order;
  }, [order]);
  const [dragId, setDragId] = useState<string | null>(null);
  // The single message the polite region pushes. It serves TWO events — see the region below.
  const [announce, setAnnounce] = useState("");
  // One id per list: every reorderable row points aria-describedby at it, so the ↑ ↓ gesture is
  // spoken when a row takes focus rather than only inside the hover-only «?».
  const instructionsId = useId();
  // After a keyboard move the focus must follow the row to its new slot; otherwise the second press
  // moves whatever row slid under the old focus and the list scrambles under the user.
  const rowRefs = useRef<Map<string, HTMLLIElement | null>>(new Map());
  const pendingFocusId = useRef<string | null>(null);

  const isExcluded = (id: string) => failoverExcludedIds.includes(id);

  // Ordinals count PARTICIPATING rows only, top to bottom. An excluded row gets no number at all: it
  // is not in the queue, so any number there would describe a position it does not hold.
  const ordinals = new Map<string, number>();
  let counted = 0;
  for (const cfg of order) {
    if (!isExcluded(cfg.id)) {
      counted += 1;
      ordinals.set(cfg.id, counted);
    }
  }
  const participatingTotal = counted;

  const noServers = !loading && !error && orderedConfigs.length === 0;
  // The queue panel, the «серверов нет» placeholder OR the read-failure surface — any one of them is
  // what earns the card its large gap above the two settings below. With the master off and nothing
  // to show, that gap would be a hole in the middle of the card, so it is spent only when something
  // stands in it. WR-10 added `error` to the list: the failure now stands there too.
  const insetShown = noServers || masterOn || error;
  // A one-row list has nothing to reorder, so it carries no grab affordance: a handle that cannot
  // move anything is a promise the list cannot keep.
  const reorderable = order.length > 1;
  // Excluding the only server would leave failover with nothing at all, so that one switch is held.
  // While a switch is in flight, every switch is held.
  const switchDisabled = locked || order.length === 1;

  // Item 9 (30.1 review): the arrangement as it stood BEFORE the current drag began. A drag mutates
  // the arrangement on every `dragenter`, so by the time a drop is refused the pre-drag order is no
  // longer anywhere in scope; captured at `dragstart`, it can be restored. A keyboard move needs no
  // ref — it reads the pre-move arrangement straight out of its own render closure.
  const arrangementBeforeDrag = useRef<string[]>([]);

  // Persist the current top-to-bottom id order to the manifest.
  //
  // The RENDER stays optimistic on purpose: the local order already reflects the move, so the row
  // does not snap back under the user's hand while the IPC is in flight.
  //
  // The CONFIRMATION is not optimistic any more (item 9, 30.1 review). This was a fire-and-forget
  // write with an empty catch, and both call sites fired `onSaved` — «Настройки сохранены» —
  // unconditionally right after it. A refused reorder therefore reported a success it never achieved
  // and left the user reading a queue order the failover engine does not use, silently, for the rest
  // of the session. Now the confirmation waits for the write, and a refusal reconciles the visible
  // order back to where it was and reports itself instead.
  //
  // This is deliberately the SAME reconcile-and-report pair `savedToRust` already applies to the
  // master toggle and the participation set (`reconcileFailoverFromRust` + `onSaveFailed`), not a
  // third shape: a refused reorder and a refused failover write are the same event to the user.
  // The difference is only where the truth is read back from — the reorder's pre-move arrangement is
  // known locally, so no extra round-trip to Rust is needed to restore it.
  //
  // `previous` is the arrangement BEFORE the gesture, including the empty array that means «never
  // rearranged» — restoring that correctly hands the list back to the manifest's own order.
  const persistOrder = (next: ConfigSummary[], previous: string[], moved: ConfigSummary) => {
    void invoke("reorder_configs", { ids: next.map((c) => c.id) })
      .then(() => {
        onSaved?.();
      })
      .catch(() => {
        setArrangement(previous);
        // Correct the live region too. It has just announced the row's NEW position, and leaving
        // that standing after the move was refused is the same false claim in the channel a screen
        // reader user hears — so it is re-announced against the order actually restored. No new copy
        // is minted for this: the honest sentence is the one that describes where the row really is.
        setAnnounce(movedMessage(applyQueueArrangement(previous, orderedConfigs), moved));
        onSaveFailed?.();
      });
  };

  /** The position a row holds among PARTICIPATING rows, or 0 when it is out of the queue. */
  const participatingPosition = (list: ConfigSummary[], id: string) => {
    let position = 0;
    let total = 0;
    for (const cfg of list) {
      if (isExcluded(cfg.id)) continue;
      total += 1;
      if (cfg.id === id) position = total;
    }
    return { position, total };
  };

  /** The live-region sentence for a moved row: its queue position, or the fact that it is out. */
  const movedMessage = (list: ConfigSummary[], cfg: ConfigSummary) => {
    const { position, total } = participatingPosition(list, cfg.id);
    return position > 0
      ? t("settings.autoMode.position_announce", { name: cfg.name, position, total })
      : t("settings.autoMode.participate_announce_off", { name: cfg.name });
  };

  // Move a row by ±1 via the keyboard arrows. Persists, announces, confirms, and returns focus to
  // the row so repeated presses keep moving the same one.
  //
  // WR-01 (Phase-28 review): the whole body used to run INSIDE a `setOrder` updater, which is not
  // a place side effects may live. React 19 double-invokes updaters under StrictMode
  // (`main.tsx:129` wraps the app in it), so every arrow press fired TWO `reorder_configs` writes,
  // two live-region pushes and two snackbars in dev; and `onSaved` resolves to
  // `AppSettingsPanel.showSaved` → `pushSnack`, i.e. a setState in `SnackBarProvider`, a DIFFERENT
  // component, from inside a render pass — the «Cannot update a component while rendering a
  // different component» violation. The updater was being abused as a getter for the latest
  // committed order; the effects now run once, outside it, against the order computed here.
  const moveBy = (id: string, dir: "up" | "down") => {
    // Phase 14 (D-13): a mid-switch reorder is a competing state change — it re-persists the queue
    // the failover path reads. While locked, swallow the move: no reorder_configs fires.
    if (locked) return;
    const from = order.findIndex((c) => c.id === id);
    if (from === -1) return;
    const to = dir === "up" ? from - 1 : from + 1;
    if (to < 0 || to >= order.length) return; // bounds
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    // Item 9: the pre-move arrangement, so a refused write can put the list back. Read from this
    // render's closure, which is the arrangement the move is being applied to.
    const previousArrangement = arrangement;
    setArrangement(next.map((c) => c.id));
    setAnnounce(movedMessage(next, moved));
    pendingFocusId.current = id;
    // Item 9: `onSaved` used to fire here, unconditionally, whether or not the write landed. The
    // confirmation now belongs to `persistOrder`, which fires it only when Rust accepted the order.
    persistOrder(next, previousArrangement, moved);
  };

  // After a keyboard move re-renders the new order, return focus to the moved row.
  useEffect(() => {
    const id = pendingFocusId.current;
    if (!id) return;
    pendingFocusId.current = null;
    // user-navigation: `pendingFocusId` is only ever set by a keyboard move, so focus is following
    // the row the user just moved. Chasing it is the point — losing focus mid-reorder is the defect.
    rowRefs.current.get(id)?.focus();
  }, [order]);

  // Live reorder while dragging: entering another row moves the dragged item into that slot, so the
  // list rearranges under the cursor. Plain state update — no View Transitions / flushSync, which
  // promoted rows into the browser top layer over the fixed tab bar (Phase 12 owner UAT).
  const reorderOver = (overId: string) => {
    if (locked) return; // D-13: no drag reorder while a switch is in flight
    if (!dragId || dragId === overId) return;
    // An UPDATER, so a burst of `dragenter` events in one batch each sees the move before it. Falls
    // back to the manifest order the first time, when the user has not rearranged anything yet.
    setArrangement((prev) => {
      const base = prev.length > 0 ? prev : orderedConfigs.map((c) => c.id);
      const from = base.indexOf(dragId);
      const to = base.indexOf(overId);
      if (from === -1 || to === -1) return prev;
      const next = [...base];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  // Excluding a server never reorders the list: the row keeps its place and simply leaves the queue.
  // Moving it would make the user hunt for a row they only meant to switch off.
  const toggleParticipation = (cfg: ConfigSummary, participates: boolean) => {
    // WR-11: derive the next set from an UPDATER, not from `failoverExcludedIds` in this render
    // closure. Two toggles dispatched in ONE React batch — rapid clicks, or Space held across two
    // rows — both read the same pre-batch array, so the second write dropped the first: the server
    // the user opted out of stayed in the real failover queue while its switch showed it excluded.
    // A silent divergence between what the user sees and what the tunnel will actually do is worse
    // than a visible refusal. `setFailoverExcludedIds` resolves the updater against localStorage at
    // call time, so each toggle sees the one before it even inside a single batch.
    //
    // WR-02: the exclusion set travels to Rust in the same write as the master switch, so a
    // refusal here is just as invisible — a server the user opted out of stays in the queue.
    savedToRust(setFailoverExcludedIds)((current) =>
      participates
        ? current.filter((x) => x !== cfg.id)
        : // Guard the add: a batch could deliver the same «exclude» twice (a re-render racing a
          // second press), and a duplicate id would make the set disagree with itself.
          current.includes(cfg.id)
          ? current
          : [...current, cfg.id],
    );
    // The SECOND message the polite region serves, and the reason it is not decorative: a screen
    // reader does not re-announce what a row MEANS when a switch embedded in it flips. Without this
    // line the user hears «включено» and still does not know which server left the queue.
    setAnnounce(
      participates
        ? t("settings.autoMode.participate_announce_on", { name: cfg.name })
        : t("settings.autoMode.participate_announce_off", { name: cfg.name }),
    );
  };

  // The note above the list. Derived from the data rather than passed in, so a state cannot be shown
  // with the wrong note attached to it.
  let note: { variant: "info" | "warning"; message: string } | null = null;
  if (!loading && !error && order.length > 0) {
    if (participatingTotal === 0) {
      // Nothing is auto-corrected and no switch is forced back on: the app states the consequence
      // and leaves the choice where the user put it.
      note = { variant: "warning", message: t("settings.autoMode.all_excluded_note") };
    } else if (order.length === 1 || participatingTotal === 1) {
      // «One server» and «several servers but one candidate» are the same situation for the user, so
      // they share one note rather than splitting into two near-identical sentences.
      note = { variant: "info", message: t("settings.autoMode.single_server_note") };
    }
  }

  /**
   * The read-failure surface, WR-10: hoisted OUT of `panelBody` so it can render whether or not the
   * master toggle is on.
   *
   * What was broken. This lived inside `panelBody`, which only ever renders inside the
   * master-gated block. `APP_SETTINGS_DEFAULTS.masterOn` is FALSE, so on the DEFAULT path a
   * `list_configs` failure produced: no error, no placeholder (`noServers` is false precisely
   * because `error` is true), nothing at all — the card showed the master row and a blank space
   * below it. That is the same silence over a failure that 27 D-15 overturned one layer up when it
   * gave `useConfigList` an error channel at all: the whole point was that «не удалось прочитать
   * список» and «серверов пока нет» stop being the same thing to the user.
   *
   * Why it belongs outside the gate. Whether the app can read the user's server list is a fact
   * about the app, not about failover: it is just as true, and just as worth saying, with
   * «Авто-режим» off. Only the QUEUE EDITOR is a master-gated privilege, and that stays gated —
   * arming an order for a list nobody could read is not a setting worth offering.
   */
  const loadFailedBody = (
    // Deliberately NOT the «серверов пока нет» placeholder: claiming there are no servers when
    // servers exist but could not be read would be a lie, and the user would go looking for a list
    // they never lost. D-05 / EW-02: `useConfigList.error` is a BOOLEAN, so the heading below is
    // the only thing that can reach the screen — the backend's own message has nowhere to go.
    <div className="flex flex-col items-start gap-[var(--space-2)]">
      <ErrorBanner
        variant="error"
        message={t("settings.autoMode.list_load_failed")}
        className="w-full"
      />
      <Button
        variant="secondary"
        size="sm"
        icon={<RotateCw className="h-3.5 w-3.5" />}
        onClick={() => void reload()}
      >
        {t("settings.autoMode.list_load_retry")}
      </Button>
    </div>
  );

  const panelBody = (() => {
    if (loading) {
      // The placeholder rows live in the SAME box and the same columns as the real ones, so nothing
      // reassembles on screen when the data lands.
      return (
        // `aria-hidden`: a screen reader is told nothing by three empty rows, and announcing them
        // as list items would claim the queue has three servers in it. That also puts the
        // placeholders outside the accessibility tree, so a test id is the only honest way to
        // address them — the same reasoning as PriorityRow's decorative grip.
        <ul
          className="flex flex-col gap-[var(--space-2)]"
          aria-hidden="true"
          data-testid="automode-skeleton"
        >
          <PrioritySkeletonRow />
          <PrioritySkeletonRow />
          <PrioritySkeletonRow />
        </ul>
      );
    }
    // WR-10: no `error` branch here any more. The failure surface is `loadFailedBody`, rendered by
    // the caller outside the master gate; the queue panel this body fills is never mounted while
    // `error` is true, so a branch here would be dead code that hid the real one.
    return (
      <div className="flex flex-col gap-[var(--space-2)]">
        {/* A standing explanation, not an urgent refusal: `assertive` would interrupt the user and
            collide with the polite region below, which announces reorders and participation. */}
        {note && (
          <ErrorBanner
            variant={note.variant}
            message={note.message}
            role="status"
            aria-live="polite"
          />
        )}
        <ul
          className="flex flex-col gap-[var(--space-2)]"
          aria-label={t("settings.autoMode.failover_list_aria")}
        >
          {order.map((cfg) => {
            const participating = !isExcluded(cfg.id);
            const ordinal = ordinals.get(cfg.id) ?? null;
            return (
              <PriorityRow
                key={cfg.id}
                ref={(el) => {
                  rowRefs.current.set(cfg.id, el);
                }}
                name={cfg.name}
                // The DISPLAY address (IP-preferring), never the raw `host`: for a bare-IP endpoint
                // carrying a fake TLS-SNI name, `host` shows the fake name. `host` stays the dedup
                // key and is not for display.
                host={cfg.display_host || cfg.host}
                ordinal={ordinal}
                participating={participating}
                dragging={cfg.id === dragId}
                reorderable={reorderable}
                locked={locked}
                switchDisabled={switchDisabled}
                switchLabel={t("settings.autoMode.participate_aria", { name: cfg.name })}
                roleDescription={t("settings.autoMode.reorder_row_roledescription")}
                instructionsId={instructionsId}
                rowLabel={
                  participating && ordinal !== null
                    ? t("settings.autoMode.position_announce", {
                        name: cfg.name,
                        position: ordinal,
                        total: participatingTotal,
                      })
                    : t("settings.autoMode.participate_announce_off", { name: cfg.name })
                }
                onParticipationChange={(value) => toggleParticipation(cfg, value)}
                onKeyDown={(event) => {
                  // preventDefault so the tab does not also scroll while the list is rearranged.
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    moveBy(cfg.id, "up");
                  } else if (event.key === "ArrowDown") {
                    event.preventDefault();
                    moveBy(cfg.id, "down");
                  }
                }}
                onDragStart={(event) => {
                  if (locked) {
                    event.preventDefault();
                    return;
                  }
                  // Item 9: snapshot the arrangement before this drag starts mutating it on every
                  // `dragenter`, so a refused drop can be put back where the user found it.
                  arrangementBeforeDrag.current = arrangement;
                  setDragId(cfg.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragEnter={() => reorderOver(cfg.id)}
                onDragOver={(event) => event.preventDefault()}
                onDragEnd={() => {
                  // Phase 14 (IN-01): if a switch STARTED while this drag was already underway,
                  // `locked` flipped true mid-drag. reorderOver already refuses NEW moves while
                  // locked, but the drag-end still reached persistOrder — persisting a competing
                  // queue order the failover path reads mid-switch. Bail out cleanly (drop the drag,
                  // persist nothing) so the lock is atomic against an in-flight drag too. The
                  // optimistic local order equals the pre-lock order, so nothing visible is lost.
                  if (locked) {
                    setDragId(null);
                    return;
                  }
                  // WR-03: persist and announce from the LATEST committed order, not the one
                  // captured by this row's render closure.
                  // WR-01 (Phase-28 review): read it from `orderRef`, not from a no-op `setOrder`
                  // updater. An updater must be pure and React 19 double-invokes it under
                  // StrictMode, so that shape fired two `reorder_configs` writes and two
                  // live-region pushes per drop in dev, and called `onSaved` (→ a setState in
                  // `SnackBarProvider`) from inside a render pass.
                  const current = orderRef.current;
                  setAnnounce(movedMessage(current, cfg));
                  setDragId(null);
                  // Item 9: a drag is a move too, so it confirms exactly like a keyboard move — and
                  // now that means the SAME deferral: `onSaved` used to fire here unconditionally,
                  // and it is `persistOrder` that owns it, on a write Rust actually accepted.
                  persistOrder(current, arrangementBeforeDrag.current, cfg);
                }}
                onDrop={() => setDragId(null)}
              />
            );
          })}
        </ul>
        {/* Visually hidden, polite, and shared by BOTH events — a move and a participation change.
            A static per-row aria-label is not re-announced when it changes, so without this region a
            keyboard reorder would be silent. The test id addresses it without depending on which
            other `role="status"` nodes the panel happens to render (the notes are polite too). */}
        <div
          className="sr-only"
          role="status"
          aria-live="polite"
          data-testid="automode-live-region"
        >
          {announce}
        </div>
        <ReorderInstructions
          id={instructionsId}
          text={t("settings.autoMode.reorder_instructions")}
        />
      </div>
    );
  })();

  return (
    <SettingsCard
      icon={<Wand2 className="h-4 w-4" />}
      title={t("settings.autoMode.title")}
      description={t("settings.autoMode.description")}
    >
      <div className={`flex flex-col ${insetShown ? "gap-[var(--space-6)]" : ""}`}>
        <div>
          <SettingsRow
            label={t("settings.autoMode.failover_label")}
            description={t("settings.autoMode.failover_desc")}
            labelExtra={
              <HelpHint
                text={t("settings.autoMode.failover_help")}
                label={helpLabel(t("settings.autoMode.failover_label"))}
              />
            }
            control={
              <RowToggle
                checked={masterOn}
                onChange={savedToRust(setMasterOn)}
                disabled={noServers || locked}
                aria-label={t("settings.autoMode.failover_label")}
              />
            }
          />

          {/* Arming a failover with nothing to fail over to is not a setting worth offering, so the
              panel is replaced by a placeholder that names the next step instead. */}
          {noServers && (
            <div className="mt-[var(--space-3)] flex flex-col items-center gap-[var(--space-1)] py-[var(--space-4)] text-center">
              <ServerOff
                className="h-5 w-5"
                style={{ color: "var(--color-text-muted)" }}
                aria-hidden="true"
              />
              <p className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
                {t("settings.autoMode.no_servers_title")}
              </p>
              <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                {t("settings.autoMode.no_servers_body")}
              </p>
            </div>
          )}

          {/* WR-10: the read failure stands on its OWN, before and outside the master gate. It gets
              the same InsetPanel fill+outline the queue panel gets, because it occupies the same
              slot and a failure that looks like loose text in the middle of a card reads as an
              accident. It carries no «Порядок переключения» heading: there is no order to show, and
              titling an unreadable list would promise a control the card cannot offer. */}
          {error && (
            <div className="mt-[var(--space-3)]">
              <InsetPanel>{loadFailedBody}</InsetPanel>
            </div>
          )}

          {/* Off means ABSENT, not disabled-but-visible: a panel of controls that cannot act is
              noise. The coloured left edge this block used to carry is gone — InsetPanel's fill and
              outline do the separating, and a left accent rail is a banned emphasis device.
              WR-10: `!error` too — the queue editor has nothing to edit while the list is unknown,
              and the failure above already occupies this slot. */}
          {!noServers && !error && masterOn && (
            <div className="mt-[var(--space-3)]">
              <InsetPanel>
                {/* The in-flight line is the FIRST child of the panel: it explains why everything
                    below it stopped responding, and an explanation that arrives after the symptom is
                    not an explanation. It names no server — this section is handed a boolean lock,
                    not a target, and inventing a name it cannot know would be worse than omitting
                    one. */}
                {locked && (
                  <div
                    role="status"
                    aria-live="polite"
                    className="mb-[var(--space-2)] flex items-center gap-[var(--space-2)]"
                  >
                    <Loader2
                      className="h-3.5 w-3.5 animate-spin"
                      style={{ color: "var(--color-accent-fg)" }}
                      aria-hidden="true"
                    />
                    <span className="text-caption" style={{ color: "var(--color-text-secondary)" }}>
                      {t("settings.autoMode.switching_status")}
                    </span>
                  </div>
                )}

                <div className="mb-[var(--space-2)] flex items-center justify-between gap-[var(--space-2)]">
                  <span
                    className="flex items-center gap-[var(--space-1)] text-sm font-medium"
                    style={{ color: "var(--color-text-primary)" }}
                  >
                    {t("settings.autoMode.order_label")}
                    <HelpHint
                      text={t("settings.autoMode.order_help")}
                      label={helpLabel(t("settings.autoMode.order_label"))}
                    />
                  </span>
                </div>

                {panelBody}
              </InsetPanel>
            </div>
          )}
        </div>

        <div>
          {/* D-01: honest LAST-USED wording — no fastest-server promise. */}
          <SettingsRow
            separated={!insetShown}
            label={t("settings.autoMode.auto_connect_launch_label")}
            description={t("settings.autoMode.auto_connect_launch_desc")}
            labelExtra={
              <HelpHint
                text={t("settings.autoMode.auto_connect_launch_help")}
                label={helpLabel(t("settings.autoMode.auto_connect_launch_label"))}
              />
            }
            control={
              <RowToggle
                checked={autoConnectOnLaunch}
                onChange={saved(setAutoConnectOnLaunch)}
                aria-label={t("settings.autoMode.auto_connect_launch_label")}
              />
            }
          />
          {/* D-06: the notifications toggle persists a real boolean the notification layer reads. */}
          <SettingsRow
            separated
            label={t("settings.autoMode.notifications_label")}
            description={t("settings.autoMode.notifications_desc")}
            labelExtra={
              <HelpHint
                text={t("settings.autoMode.notifications_help")}
                label={helpLabel(t("settings.autoMode.notifications_label"))}
              />
            }
            control={
              <RowToggle
                checked={notificationsOn}
                onChange={saved(setNotificationsOn)}
                aria-label={t("settings.autoMode.notifications_label")}
              />
            }
          />
        </div>
      </div>
    </SettingsCard>
  );
}
