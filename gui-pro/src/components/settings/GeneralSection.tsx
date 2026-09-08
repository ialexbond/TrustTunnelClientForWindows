import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Settings, Power, EyeOff, FileText, FolderOpen, RefreshCw } from "lucide-react";
import { IconButton, RowToggle, SettingsCard, SettingsRow } from "../../shared/ui";
import { emitGeodataAutoUpdateChanged } from "../../shared/utils/geodataAutoUpdateSignal";

// Phase 12 (12-07): the «Автоподключение при запуске» toggle MOVED out of «Основные» into
// «Авто-режим» (AutoModeSettings). It reads/writes the SAME `tt_auto_connect` localStorage key
// via useAppSettings — exactly ONE control for that setting now lives in the app (no duplicate).
// The `hasConfig`/`onAutoConnectChange` props (which only fed that toggle's disabled/tooltip
// state + its change callback) were removed together with it. GeneralSection now holds only the
// app-startup-behavior toggles: autostart / start-minimized / logging.
interface Props {
  onSaved?: () => void;
  /**
   * 28-06: the other half of `onSaved`. Every write in this section goes to the backend and can
   * therefore refuse; until now each refusal was swallowed and the switch simply did not move,
   * which is indistinguishable from an unresponsive control. Takes no argument on purpose — the
   * panel renders a localized sentence and the backend's own words never reach the screen
   * (T-28-20).
   */
  onSaveFailed?: () => void;
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
export function GeneralSection({ onSaved, onSaveFailed }: Props) {
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

  const handleAutostartChange = async (value: boolean) => {
    // 28-07: the value is applied BEFORE the write, not after it. While the write runs the handle
    // must stay where the user moved it with an indicator turning inside it — a handle that only
    // moves once the disk answers looks like a control that ignored the press.
    const reported = autostart;
    touchedRows.current.add("autostart");
    markPending("autostart", true);
    setAutostart(value);
    try {
      await invoke("set_autostart", { enabled: value });
      onSaved?.();
    } catch {
      // The re-read is the same command as the mount read and carries the same third answer, so it
      // updates the same flag. Without this a refused write followed by an unreadable re-read would
      // put the switch back on the last value the app happened to report and present it as fact.
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
      onSaveFailed?.();
    } finally {
      markPending("autostart", false);
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
