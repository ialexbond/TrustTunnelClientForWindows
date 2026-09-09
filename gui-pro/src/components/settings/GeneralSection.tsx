import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Settings, Power, EyeOff, FileText, FolderOpen, RefreshCw } from "lucide-react";
import { IconButton, RowToggle, SettingsCard, SettingsRow } from "../../shared/ui";
import { emitGeodataAutoUpdateChanged } from "../../shared/utils/geodataAutoUpdateSignal";
import { useActivityLog } from "../../shared/hooks/useActivityLog";

// Phase 12 (12-07): the «Автоподключение при запуске» toggle MOVED out of «Основные» into
// «Авто-режим» (AutoModeSettings). It reads/writes the SAME `tt_auto_connect` localStorage key
// via useAppSettings — exactly ONE control for that setting now lives in the app (no duplicate).
// The `hasConfig`/`onAutoConnectChange` props (which only fed that toggle's disabled/tooltip
// state + its change callback) were removed together with it. GeneralSection now holds only the
// app-startup-behavior toggles: autostart / start-minimized / logging.
interface Props {
  /**
   * Is the Settings tab the one currently on screen? App.tsx keeps every tab MOUNTED and swaps them
   * with position/opacity/visibility, so a mounted row cannot tell whether anybody is looking at it —
   * and the autostart row needs to know, because it mirrors an object (a logon scheduled task) that
   * changes outside this app. Defaults to `true` so a standalone render (tests, Storybook) behaves
   * as it always did.
   */
  active?: boolean;
  onSaved?: () => void;
  /**
   * 28-06: the other half of `onSaved`. Every write in this section goes to the backend and can
   * therefore refuse; until now each refusal was swallowed and the switch simply did not move,
   * which is indistinguishable from an unresponsive control. Takes no argument on purpose — the
   * panel renders a localized sentence and the backend's own words never reach the screen
   * (T-28-20).
   */
  onSaveFailed?: (messageKey?: string) => void;
}

/**
 * The four rows, in the order they are drawn.
 *
 * Declared here rather than imported from `components/_story/settingsDemos.tsx`, which names the
 * same union: the story tier never ships (it is excluded from the release branch), so a production
 * file importing from it would put Storybook-only code on the release path.
 */
type GeneralRowKey = "autostart" | "startMinimized" | "logging" | "geodata";

/**
 * Refusal code → the sentence the user actually reads.
 *
 * The owner, 2026-09-09, installed the program into a root-level folder, could not switch autostart
 * back on, and got «Не удалось сохранить настройку. Попробуйте ещё раз» — advice that cannot work,
 * because the folder's permissions are the same on every attempt. The backend knew exactly why and
 * even carried the remedy; the reason died in a `catch {}` that never read the error, and in an
 * `onSaveFailed` that had no argument to carry it.
 *
 * The fix keeps the project rule that backend prose never reaches the screen (T-28-20): Rust leads
 * its refusal with a stable CODE, and the mapping from code to a localized sentence lives here.
 * Same shape as `REASON_CODE_I18N` in `vpnEventHelpers.ts`, for the same reason.
 *
 * An unmapped failure falls back to the generic message — a refusal nobody anticipated is still
 * better shown as «could not save» than as a raw English string from a scheduler API.
 */
const AUTOSTART_FAILURE_I18N: Record<string, string> = {
  AUTOSTART_REFUSED_REPLACEABLE: "messages.settings_autostart_needs_program_files",
  AUTOSTART_REFUSED_ACL_UNKNOWN: "messages.settings_autostart_acl_unknown",
};

/** The code a refusal leads with, if it is one this screen knows how to explain. */
function autostartFailureKey(error: unknown): string | undefined {
  const text = typeof error === "string" ? error : String((error as Error)?.message ?? error ?? "");
  const code = text.split(":", 1)[0]?.trim();
  return code ? AUTOSTART_FAILURE_I18N[code] : undefined;
}

/**
 * Put a switch back after a refused write, on the value the APP reports.
 *
 * NOT the inverse of what was pressed: inverting locally assumes the write was the only thing that
 * could have changed the setting, and after a failure that assumption is exactly what is in doubt.
 * The FAB-05 re-read the geodata row already did is the pattern; this generalises it. If even the
 * re-read fails there is nothing to ask, so the switch falls back to the last value the app
 * reported — still a value it gave us, never one invented here.
 */
async function revertTo(
  apply: (value: boolean) => void,
  lastReported: boolean,
  reread: () => Promise<boolean>
) {
  try {
    apply(await reread());
  } catch {
    apply(lastReported);
  }
}

/**
 * «Основные» — how the app behaves at startup and what it writes to disk.
 *
 * Phase 28 (28-07): rebuilt on `SettingsCard` / `SettingsRow` / `RowToggle`. The backend wiring
 * kept the pre-port shape — with ONE later exception: the autostart row's dynamic plugin import
 * was replaced by a plain `invoke` pair (`get_autostart`/`set_autostart`) for the 2026-08-26
 * owner bug — see the comment on that row. All four rows now write through `invoke`, with the
 * geodata seed, the post-success-only broadcast and the FAB-05 re-read intact. This card is the
 * tab's canonical «four independent Tauri-backed toggles» section, so a redesign that disturbed
 * one of them would be a regression dressed as a restyle.
 *
 * Four rows, top to bottom, in a fixed order: autostart, start minimized, logging, routing-database
 * updates. The order used to be pinned by a comment saying the tests addressed switches by their
 * place in the card; that stopped being true in this plan's first commit, and the comment was
 * deleted with it — the order is kept because it is the designed reading order, not because a
 * selector depends on it.
 *
 * `initial-read` has no skeleton and no spinner: the values arrive a moment after mount, and until
 * then the card stands on its defaults. A placeholder for a value that is already on its way is a
 * noisier way of showing the same card.
 */
export function GeneralSection({ onSaved, onSaveFailed, active = true }: Props) {
  const { t } = useTranslation();

  // ─── Which writes are in flight ───
  // A SET of row keys, not one section-wide boolean. A single flag would occupy all four switches
  // for one write, which is the «everything freezes» reading the design rules out: while one
  // setting is being written the other three rows stay usable. A set also survives two writes
  // overlapping — nothing prevents the user from flipping a second row while the first is still
  // going, and a scalar would then clear the busy mark of a write that has not finished.
  const [pendingRows, setPendingRows] = useState<ReadonlySet<GeneralRowKey>>(new Set());

  // Rows the user has already acted on.
  //
  // Every row seeds itself from an ASYNC read on mount, and `initial-read` states in as many words
  // that the card stands on its defaults until those reads land. Flip a switch before its read
  // comes back and the late answer would overwrite the value the user just chose — the handle
  // silently springs back with no failure anywhere, which is the exact «unresponsive control»
  // reading the write contract exists to prevent. It became reproducible once the value started
  // being applied BEFORE the write instead of after it. A ref, not state: nothing renders from it,
  // and it must be readable by a callback created in an earlier render.
  const touchedRows = useRef<Set<GeneralRowKey>>(new Set());

  /** Apply an initial read only while the row is still showing its default. */
  const seedIfUntouched =
    (key: GeneralRowKey, apply: (value: boolean) => void) => (value: boolean) => {
      if (!touchedRows.current.has(key)) apply(value);
    };

  const markPending = (key: GeneralRowKey, active: boolean) =>
    setPendingRows((prev) => {
      const next = new Set(prev);
      if (active) {
        next.add(key);
      } else {
        next.delete(key);
      }
      return next;
    });

  // ─── Autostart (Rust-side commands, autostart.rs) ───
  //
  // Owner bug (2026-08-26): «Запуск вместе с системой» silently stopped working. Root cause: the
  // write used to go through the JS plugin (`import("@tauri-apps/plugin-autostart")`), so the ONLY
  // record of the choice was the HKCU Run registry value — which Tauri's NSIS uninstaller deletes
  // on upgrade / uninstall-first installs. The choice evaporated with it and nothing re-asserted
  // it. The write now goes through `set_autostart`, which changes the registry AND persists the
  // choice in app_settings.json; Rust re-asserts a wiped entry at startup (autostart.rs).
  //
  // Side effect this row was owed: the dynamic plugin import was the reason no test could drive a
  // write through this switch (the 28-06 `restoreMocks` module-mock trap). With a plain `invoke`
  // pair the row is mockable exactly like «Запускать в свёрнутом режиме», and the trap is gone.
  const [autostart, setAutostart] = useState(false);

  // Whether the app could find out at all.
  //
  // `get_autostart` has THREE answers, not two: the task is on, the task is off (absent or
  // disabled), or the Task Scheduler could not be asked — its service stopped by policy or by a
  // third-party tuner, an apartment refused, this process's own identity unreadable. This row used
  // to swallow the third with `.catch(() => {})` and stay on its `false` default, so somebody whose
  // logon task is registered and firing at every logon read a confident OFF. That is this feature's
  // own defect class pointed the other way — the switch claiming a state the operating system
  // contradicts — and it is the reading that makes a person switch it on again, or stop trusting
  // the setting.
  //
  // A `false` handle is not an honest way to draw «unknown», so the row says so in words and the
  // control is disabled: reading and writing go through the same three COM acquisitions, so a read
  // that could not be made is a write that cannot be made either, and a switch that can be moved
  // implies the app knows where it stands now. The remedy is in the sentence.
  const [autostartUnreadable, setAutostartUnreadable] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_autostart")
      .then((value) => {
        setAutostartUnreadable(false);
        seedIfUntouched("autostart", setAutostart)(value);
      })
      .catch(() => setAutostartUnreadable(true));
  }, []);

  // A write in flight owns the handle. The refresh below must not read across it: the value the
  // user just moved is applied BEFORE the write (see `handleAutostartChange`), so a re-read landing
  // mid-write would redraw the pre-write state and look like the switch springing back. A ref, not
  // `pendingRows` state, because the listener that consults it is created once and would otherwise
  // close over the first render's empty set.
  const autostartWritePending = useRef(false);

  // ─── The row re-reads when the window comes back (G-32-13) ───
  //
  // The mount read above used to be the ONLY read this row ever did, and the panel it lives in is
  // never unmounted: App.tsx keeps every tab mounted and switches them with `position` / `opacity`
  // / `visibility`, so `useEffect(…, [])` fires once per app LAUNCH — not once per visit to the
  // Settings tab. Owner bug, 2026-09-09, build `k9tzr4`: he disabled the logon task in Task
  // Scheduler, came back to the app, and read a switch still saying ON. Nothing was wrong with the
  // read itself — `get_autostart` reports the task's real state (present AND enabled), never a
  // stored preference — the answer on screen was simply hours old.
  //
  // A control that mirrors an object OUTSIDE the app has to re-ask whenever the user has had the
  // chance to change that object elsewhere, and the honest moment to do it is the one where they
  // come back to this window. Hence focus + visibilitychange rather than a poll: no timer, no work
  // while the window is away, and it fires exactly on the trip back from Task Scheduler.
  //
  // Deliberately NOT `seedIfUntouched`: that guard protects a row from a LATE MOUNT READ clobbering
  // a value the user just chose. Here the operating system is the authority, and a value the user
  // set has already been written into it — a refresh returns the same answer. The only case that
  // must be skipped is a write still in flight, which is what the ref above is for.
  //
  // Scoped to this row on purpose. «Запускать в свёрнутом режиме» and the logging flag are files
  // only this app writes, so they cannot drift behind its back the way a Task Scheduler entry can.
  // ─── The instrument, added 2026-09-09 after the first fix did not hold on hardware ───
  //
  // Build v4t9qc shipped the refresh below and the owner tested it in the one order that separates
  // the possible causes: with the app RUNNING he deleted the task (switch stayed ON — wrong), then
  // deleted the whole folder (switch went OFF — right). Both cases reach `task_is_enabled` through
  // the same `is_absent` branch, and a probe on this machine confirmed both a missing task inside an
  // existing folder and a missing folder answer with the same 0x80070002 — so the backend cannot be
  // what tells them apart. Something between the event and the answer differs, and no amount of
  // reasoning from the source settled it. So the row now says out loud, into activity.log, WHICH
  // trigger fired and WHAT the backend answered; the next run reads the file instead of memory.
  // The line is one per return-to-window and carries no user data.
  const { log: activityLog } = useActivityLog();

  // What is on screen right now, readable from a callback created in an earlier render. Only the
  // change-detection above uses it; nothing renders from it.
  const autostartRef = useRef(autostart);
  useEffect(() => {
    autostartRef.current = autostart;
  }, [autostart]);

  // Has a re-read ever landed? The row mounts on its `false` default and the first answer moves it
  // to whatever the task says — that is a SEED, not a disagreement, and logging it would put a line
  // in every user's log on every launch. Only from the second read on does a differing answer mean
  // the switch and the operating system have actually drifted apart.
  const autostartSeeded = useRef(false);

  const refresh = useCallback(
    (trigger: string) => {
      if (autostartWritePending.current) {
        activityLog("STATE", `settings.autostart.read_skipped trigger=${trigger} reason=write_in_flight`, "GeneralSection");
        return;
      }
      invoke<boolean>("get_autostart")
        .then((value) => {
          // Logged on CHANGE, not on every return to the window. The instrument earned its keep on
          // 2026-09-09 — it is what turned «странно, не выключается» into four timed lines — but a
          // line per focus would bury a user's own log under noise nobody reads. What is worth
          // keeping forever is the moment the switch and the operating system STOPPED agreeing,
          // which is exactly the read whose answer differs from what is on screen.
          if (autostartSeeded.current && value !== autostartRef.current) {
            activityLog(
              "STATE",
              `settings.autostart.changed from=${autostartRef.current} to=${value} trigger=${trigger}`,
              "GeneralSection"
            );
          }
          autostartSeeded.current = true;
          setAutostartUnreadable(false);
          setAutostart(value);
        })
        .catch(() => {
          activityLog("STATE", `settings.autostart.read_failed trigger=${trigger}`, "GeneralSection");
          setAutostartUnreadable(true);
        });
    },
    [activityLog]
  );

  useEffect(() => {
    const onDomFocus = () => refresh("dom-focus");
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh("visibility");
    };
    window.addEventListener("focus", onDomFocus);
    document.addEventListener("visibilitychange", onVisibility);

    // THE SECOND TRIGGER, and the reason there are two. `window`'s DOM focus event is what App.tsx
    // has used since IN-25 to refresh the Connection list, so it is not a suspect on its own — but
    // it is the DOCUMENT's notion of focus, and the webview can hold that while the native window
    // is not the one Windows considers active. `tauri://focus` is the OS-level answer, the same
    // event the tray menu already listens to (tray-menu.tsx). If the two disagree, the log above
    // says which one arrived. The late-resolving-listener guard is lifted from that same file: an
    // unlisten that resolves after teardown must fire at once or the handler outlives the effect.
    let cancelled = false;
    let resolvedUnlisten: (() => void) | null = null;
    void getCurrentWindow()
      .listen("tauri://focus", () => refresh("tauri-focus"))
      .then((fn) => {
        if (cancelled) fn();
        else resolvedUnlisten = fn;
      })
      .catch(() => {
        // No window bridge (tests, or a webview without the API) — the DOM listeners still stand.
      });

    return () => {
      window.removeEventListener("focus", onDomFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      cancelled = true;
      resolvedUnlisten?.();
    };
  }, [refresh]);

  // ─── While this tab is the one on screen, keep the row honest without waiting for a click ───
  //
  // The recorded reading of the 2026-09-09 log, and it is right: «прост обновляется когда окно в
  // фокусе находится». Every trigger above needs the window to be ACTIVATED. Put the Settings tab
  // and Task Scheduler side by side — which is exactly what somebody comparing the two does — and
  // the switch can sit there stale while both windows are visible, because merely LOOKING at a
  // window is not focusing it. That is not a testing artefact: this switch is the only surface a
  // user has for autostart (the entry is invisible in Windows' own startup lists, D32-18), so it
  // showing yesterday's answer while the truth is on screen next to it is the defect, not the demo.
  //
  // So: re-read the moment the tab becomes the visible one, then keep a slow poll going for as long
  // as it stays visible. Bounded on purpose — it runs ONLY while this tab is shown AND the window is
  // not hidden, so a minimised app and every other tab cost nothing. Five seconds is chosen to be
  // faster than a person can switch windows and read, and slow enough that the COM round-trip is
  // invisible. The write-in-flight guard inside `refresh` still holds.
  useEffect(() => {
    if (!active) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    refresh("tab-active");
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh("tab-poll");
    }, 5000);
    return () => window.clearInterval(id);
  }, [active, refresh]);

  const handleAutostartChange = async (value: boolean) => {
    // 28-07: the value is applied BEFORE the write, not after it. While the write runs the handle
    // must stay where the user moved it with an indicator turning inside it — a handle that only
    // moves once the disk answers looks like a control that ignored the press.
    const reported = autostart;
    touchedRows.current.add("autostart");
    markPending("autostart", true);
    // Same mark, second reader: `markPending` drives the spinner, this ref stops the focus refresh
    // from reading across the write (see the refresh effect above).
    autostartWritePending.current = true;
    setAutostart(value);
    try {
      await invoke("set_autostart", { enabled: value });
      onSaved?.();
    } catch (e) {
      // The re-read is the same command as the mount read and carries the same third answer, so it
      // updates the same flag. Without this a refused write followed by an unreadable re-read would
      // put the switch back on the last value the app happened to report and present it as fact.
      const failureKey = autostartFailureKey(e);
      await revertTo(setAutostart, reported, async () => {
        try {
          const value = await invoke<boolean>("get_autostart");
          setAutostartUnreadable(false);
          return value;
        } catch (e) {
          setAutostartUnreadable(true);
          throw e;
        }
      });
      onSaveFailed?.(failureKey);
    } finally {
      markPending("autostart", false);
      autostartWritePending.current = false;
    }
  };

  // ─── Start minimized (file flag via Tauri) ───
  const [startMinimized, setStartMinimized] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_start_minimized")
      .then(seedIfUntouched("startMinimized", setStartMinimized))
      .catch(() => {});
  }, []);

  const handleStartMinimized = async (value: boolean) => {
    const reported = startMinimized;
    touchedRows.current.add("startMinimized");
    markPending("startMinimized", true);
    setStartMinimized(value);
    try {
      await invoke("set_start_minimized", { enabled: value });
      onSaved?.();
    } catch {
      await revertTo(setStartMinimized, reported, () =>
        invoke<boolean>("get_start_minimized")
      );
      onSaveFailed?.();
    } finally {
      markPending("startMinimized", false);
    }
  };

  // ─── Logging (flag file via Tauri) ───
  const [loggingEnabled, setLoggingEnabled] = useState(false);

  useEffect(() => {
    invoke<boolean>("get_logging_enabled")
      .then(seedIfUntouched("logging", setLoggingEnabled))
      .catch(() => {});
  }, []);

  const handleLoggingChange = async (value: boolean) => {
    const reported = loggingEnabled;
    touchedRows.current.add("logging");
    markPending("logging", true);
    setLoggingEnabled(value);
    try {
      await invoke("set_logging_enabled", { enabled: value });
      onSaved?.();
    } catch {
      await revertTo(setLoggingEnabled, reported, () =>
        invoke<boolean>("get_logging_enabled")
      );
      onSaveFailed?.();
    } finally {
      markPending("logging", false);
    }
  };

  // ─── Geodata auto-update (persisted Rust-side in app_settings.json) ───
  // Phase 23 (D-12/D-13): this setting used to be a session-local switch on the Routing card that
  // only drove a 30-min timer while that tab was mounted — so the databases never actually updated
  // by themselves. The cadence now lives in a Rust background scheduler, which cannot read
  // localStorage; hence the two Tauri commands instead of a window-local switch. (That comparison
  // used to name `useFeatureToggles`, the app's localStorage toggle store. It was deleted on
  // 2026-09-03 with its only key, «Блокировка сайтов» — pointing at it now would send a reader
  // looking for a file that is not there.)
  // Initialised `true`, not `false`: the read is async and the setting defaults ON, so a `false`
  // seed would flash a wrong OFF state on every mount.
  const [geodataAutoUpdate, setGeodataAutoUpdate] = useState(true);

  useEffect(() => {
    invoke<boolean>("get_geodata_auto_update")
      .then(seedIfUntouched("geodata", setGeodataAutoUpdate))
      .catch(() => {});
  }, []);

  const handleGeodataAutoUpdate = async (value: boolean) => {
    const reported = geodataAutoUpdate;
    touchedRows.current.add("geodata");
    markPending("geodata", true);
    setGeodataAutoUpdate(value);
    try {
      await invoke("set_geodata_auto_update", { enabled: value });
      // CR-03: announce the change so the Routing card re-reads it. That card is never unmounted
      // (App.tsx hides inactive panels instead of unmounting them), so without this its own copy of
      // the setting stays at whatever it was at app launch and the D-05 badge silently stops
      // working. Emitted only AFTER the backend write succeeded — a failed write must not make
      // other components believe the setting changed.
      emitGeodataAutoUpdateChanged();
      onSaved?.();
    } catch {
      // FAB-05: a failed write used to be swallowed. The switch then simply did not move, with no
      // explanation — indistinguishable from an unresponsive control, and the user's next move is to
      // click it again. Re-reading the persisted value puts the switch back where the BACKEND says it
      // is, so the UI stops claiming a change that did not happen.
      //
      // 28-06: putting the switch back is necessary but silent — the user sees it snap back with no
      // stated reason. The tab now has a slot for that sentence, so say it as well.
      //
      // 28-07: the re-read is AWAITED now (it used to be fire-and-forget) so the switch is already
      // on the app's value by the time the busy indicator stops turning. Otherwise the handle would
      // settle on the pressed value for a frame and then jump — two moves for one refusal.
      await revertTo(setGeodataAutoUpdate, reported, () =>
        invoke<boolean>("get_geodata_auto_update")
      );
      onSaveFailed?.();
    } finally {
      markPending("geodata", false);
    }
  };

  const handleOpenLogs = async () => {
    try {
      await invoke("open_logs_folder");
    } catch {
      // ignore
    }
  };

  const autostartLabel = t("settings.app.autostart");
  const startMinimizedLabel = t("settings.app.start_minimized");
  const loggingLabel = t("settings.app.logging");
  const geodataLabel = t("settings.app.geodata_auto_update");
  const showFolderLabel = t("settings.app.logging_show_folder");

  return (
    <SettingsCard
      icon={<Settings className="h-4 w-4" />}
      title={t("settings.app.general_title")}
      description={t("settings.app.general_description")}
    >
      <div>
        <SettingsRow
          icon={<Power className="h-3.5 w-3.5" />}
          label={autostartLabel}
          // The row's own description slot carries the bad news — no new device, no badge, no
          // second card. It replaces the ordinary line rather than joining it: a row stating both
          // what the setting does and that it cannot be read would be claiming two things at once.
          description={
            autostartUnreadable
              ? t("settings.app.autostart_unknown")
              : t("settings.app.autostart_desc")
          }
          control={
            <RowToggle
              checked={autostart}
              onChange={handleAutostartChange}
              // `disabled`, not `busy`: nothing is in flight here, the setting is unavailable —
              // which is the distinction those two props exist to keep apart.
              disabled={autostartUnreadable}
              busy={pendingRows.has("autostart")}
              aria-label={autostartLabel}
            />
          }
        />
        <SettingsRow
          separated
          icon={<EyeOff className="h-3.5 w-3.5" />}
          label={startMinimizedLabel}
          description={t("settings.app.start_minimized_desc")}
          control={
            <RowToggle
              checked={startMinimized}
              onChange={handleStartMinimized}
              busy={pendingRows.has("startMinimized")}
              aria-label={startMinimizedLabel}
            />
          }
        />

        {/* «Показать в папке» is the same device the app already uses in «Подключение» for the
            config file path (ConfigEditView): a folder glyph with a tooltip, right next to the
            thing it acts on. It replaces a self-built bordered button with a caption, which was a
            sixth kind of button invented for one action — and, sitting on a line of its own below
            the row, it was the one control on this tab that made a card grow taller when it
            appeared. Inside the row's right-hand group only the group's WIDTH changes. The icon is
            present only while the log is being collected, because until then there is no folder to
            open. */}
        <SettingsRow
          separated
          icon={<FileText className="h-3.5 w-3.5" />}
          label={loggingLabel}
          description={t("settings.app.logging_desc")}
          control={
            <span className="flex items-center gap-[var(--space-2)]">
              {loggingEnabled && (
                <IconButton
                  icon={<FolderOpen className="h-4 w-4" />}
                  aria-label={showFolderLabel}
                  tooltip={showFolderLabel}
                  className="shrink-0"
                  onClick={handleOpenLogs}
                />
              )}
              <RowToggle
                checked={loggingEnabled}
                onChange={handleLoggingChange}
                busy={pendingRows.has("logging")}
                aria-label={loggingLabel}
              />
            </span>
          }
        />

        <SettingsRow
          separated
          icon={<RefreshCw className="h-3.5 w-3.5" />}
          label={geodataLabel}
          description={t("settings.app.geodata_auto_update_desc")}
          control={
            <RowToggle
              checked={geodataAutoUpdate}
              onChange={handleGeodataAutoUpdate}
              busy={pendingRows.has("geodata")}
              aria-label={geodataLabel}
            />
          }
        />
      </div>
    </SettingsCard>
  );
}
