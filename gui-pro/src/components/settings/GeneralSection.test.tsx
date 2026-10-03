import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import ru from "../../shared/i18n/locales/ru.json";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { GeneralSection } from "./GeneralSection";
import { GEODATA_AUTO_UPDATE_CHANGED } from "../../shared/utils/geodataAutoUpdateSignal";

// No `@tauri-apps/plugin-autostart` module mock anymore — and that absence is the point. The
// autostart row writes through plain Tauri commands (`get_autostart`/`set_autostart`) since the
// 2026-08-26 owner bug fix, so the row is mocked through `invoke` like every other row. The old
// module mock was the thing `restoreMocks: true` kept stripping (the 28-06 trap), which is why no
// test could ever drive a write through this switch.

/**
 * The row element a control belongs to, found WITHOUT naming a CSS class: walk up from the control
 * until the ancestor also carries the row's visible label. `SettingsRow` owns the markup, so a class
 * selector here would break the moment that primitive is restyled — and this file must be able to
 * say «these two things are in the SAME row» without knowing how a row is built.
 */
function rowOf(control: HTMLElement, label: string): HTMLElement {
  let node: HTMLElement | null = control.parentElement;
  while (node) {
    const holdsLabel = Array.from(node.querySelectorAll("*")).some(
      (child) => child.textContent === label
    );
    if (holdsLabel) return node;
    node = node.parentElement;
  }
  throw new Error(`No ancestor of the control carries the label «${label}»`);
}

/** A promise the test resolves by hand, so a write can be held mid-flight and inspected there. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const AUTOSTART = "Запускать вместе с системой";
const START_MINIMIZED = "Запускать в свёрнутом режиме";
const LOGGING = "Собирать логи";
const GEODATA = "Обновлять базу маршрутов автоматически";

describe("GeneralSection", () => {
  // Phase 12 (12-07): the «Автоподключение при запуске» toggle MOVED to «Авто-режим»
  // (AutoModeSettings). GeneralSection now only holds autostart / start-minimized / logging —
  // so the old hasConfig/onAutoConnectChange props (which only fed that toggle) are gone, and
  // the auto-connect assertions live in AutoModeSettings.test.tsx now.
  const defaultProps = {
    onSaved: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    localStorage.clear();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") return false;
      if (cmd === "get_start_minimized") return false;
      // Phase 23: the geodata auto-update setting is persisted Rust-side and defaults ON.
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });
  });

  it("renders general section title", async () => {
    render(<GeneralSection {...defaultProps} />);
    expect(screen.getByText("Основные")).toBeInTheDocument();
  });

  it("renders description", () => {
    render(<GeneralSection {...defaultProps} />);
    expect(screen.getByText("Поведение при запуске приложения")).toBeInTheDocument();
  });

  it("renders autostart toggle", () => {
    render(<GeneralSection {...defaultProps} />);
    expect(screen.getByText("Запускать вместе с системой")).toBeInTheDocument();
  });

  it("renders start minimized toggle", () => {
    render(<GeneralSection {...defaultProps} />);
    expect(screen.getByText("Запускать в свёрнутом режиме")).toBeInTheDocument();
  });

  // 12-07: the auto-connect toggle MOVED — GeneralSection must NOT render it anymore.
  it("does NOT render the auto-connect toggle (moved to «Авто-режим»)", () => {
    render(<GeneralSection {...defaultProps} />);
    expect(screen.queryByText("Подключаться автоматически")).not.toBeInTheDocument();
  });

  it("renders autostart toggle description", () => {
    render(<GeneralSection {...defaultProps} />);
    expect(screen.getByText(/при старте Windows/)).toBeInTheDocument();
  });

  // 28-07 Task 1: these two used to reach the control by its INDEX among the card's switches, which
  // made the row ORDER part of the test's meaning — an assertion that says «the second switch» passes
  // just as happily against the wrong switch once a row moves. The redesign reorders nothing, but
  // it rebuilds every row, so the positional form was retired FIRST, on the unmodified component,
  // where a red result can only mean the migration is wrong. `Toggle` forwards its visible `label`
  // to the switch accessible name (D-03.2), so the name is the stable handle.
  it("calls invoke for start minimized toggle", async () => {
    render(<GeneralSection {...defaultProps} />);
    fireEvent.click(screen.getByRole("switch", { name: "Запускать в свёрнутом режиме" }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("set_start_minimized", { enabled: true });
    });
  });

  it("calls onSaved when start minimized toggle is changed", async () => {
    render(<GeneralSection {...defaultProps} />);
    fireEvent.click(screen.getByRole("switch", { name: "Запускать в свёрнутом режиме" }));
    await waitFor(() => {
      expect(defaultProps.onSaved).toHaveBeenCalled();
    });
  });

  /**
   * The guard that keeps the migration from being undone by habit: no assertion in this file may
   * reach a switch by its place in the card again.
   */
  it("addresses every switch by its accessible name, never by row index", () => {
    render(<GeneralSection {...defaultProps} />);
    for (const name of [
      "Запускать вместе с системой",
      "Запускать в свёрнутом режиме",
      "Собирать логи",
      "Обновлять базу маршрутов автоматически",
    ]) {
      expect(screen.getByRole("switch", { name })).toBeInTheDocument();
    }
  });

  // ─── Owner bug 2026-08-26: the autostart row writes through Tauri commands ───
  //
  // These are the regression tests for «Запуск вместе с системой не работает». On the pre-fix
  // tree they FAIL: the row wrote through a dynamically imported plugin module, so `invoke` was
  // never called with an autostart command — and (the deeper half of the bug) the choice lived
  // only in the registry value the installer deletes on upgrade/uninstall-first installs. The
  // Rust side of the fix (persisted choice + startup re-assert) is covered in autostart.rs and
  // app_settings.rs; what THIS file pins is the contract that makes it reachable: the switch
  // drives `get_autostart`/`set_autostart`.

  it("reads the autostart state through the backend command on mount", async () => {
    render(<GeneralSection {...defaultProps} />);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("get_autostart");
    });
  });

  it("writes the autostart change through `set_autostart` when flipped on", async () => {
    render(<GeneralSection {...defaultProps} />);
    fireEvent.click(screen.getByRole("switch", { name: AUTOSTART }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("set_autostart", { enabled: true });
    });
    await waitFor(() => expect(defaultProps.onSaved).toHaveBeenCalledTimes(1));
  });

  /**
   * The write contract the other rows already honour, now testable for THIS row too (the module
   * mock that `restoreMocks` kept stripping is gone): a refused write reverts to the value the
   * backend reports and says so once.
   */
  it("returns the autostart switch to the backend value and reports the failure once", async () => {
    const onSaveFailed = vi.fn();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") return false;
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      if (cmd === "set_autostart") throw new Error("registry write refused");
      return null;
    });

    render(<GeneralSection {...defaultProps} onSaveFailed={onSaveFailed} />);
    const target = screen.getByRole("switch", { name: AUTOSTART });
    fireEvent.click(target);

    await waitFor(() => expect(onSaveFailed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(target).toHaveAttribute("aria-checked", "false"));
    expect(target).not.toHaveAttribute("aria-busy");
    expect(defaultProps.onSaved).not.toHaveBeenCalled();
    // The backend's own words never reach the screen (T-28-23).
    expect(screen.queryByText(/registry/)).toBeNull();
  });

  /**
   * The read now has three answers, and the row must not render the third one as the second.
   *
   * `get_autostart` returns `Err` when the scheduler could not be asked at all — the service
   * stopped by policy or a tuner, an apartment refused, this process's identity unreadable. The
   * row used to `.catch(() => {})` that and stay on its `false` default, so a user whose task is
   * registered and firing at every logon reads a confident OFF. They then either switch it on
   * again or conclude the setting is broken.
   */
  it("does not render «could not read» as OFF on the autostart row", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") throw new Error("ITaskService::Connect failed");
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });

    render(<GeneralSection {...defaultProps} />);

    const target = screen.getByRole("switch", { name: AUTOSTART });
    await waitFor(() => expect(target).toBeDisabled());
    // The sentence is read out of the shipped bundle, not retyped: a test carrying its own copy
    // of the copy agrees with itself while the product drifts.
    expect(
      screen.getByText(ru.settings.app.autostart_unknown)
    ).toBeInTheDocument();
    // And the ordinary description must be gone — leaving it would be the row claiming two things.
    expect(screen.queryByText(ru.settings.app.autostart_desc)).toBeNull();
    // The backend's own words never reach the screen.
    expect(screen.queryByText(/ITaskService/)).toBeNull();
  });

  it("leaves the autostart row alone when the state reads honestly", async () => {
    render(<GeneralSection {...defaultProps} />);

    const target = screen.getByRole("switch", { name: AUTOSTART });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_autostart"));
    // The control for the test above. `Ok(false)` — absent or disabled — is a confident answer and
    // must look exactly as it always did: an operable switch with its normal description.
    expect(target).not.toBeDisabled();
    expect(screen.getByText(ru.settings.app.autostart_desc)).toBeInTheDocument();
    expect(screen.queryByText(ru.settings.app.autostart_unknown)).toBeNull();
  });

  // ─── G-32-14: a refusal the app can explain must not arrive as «try again» ───
  //
  // The owner installed into a root-level folder on 2026-09-09 and could not switch autostart back
  // on. The backend refused for a good reason and said so in full; the screen said «Не удалось
  // сохранить настройку. Попробуйте ещё раз» — advice that cannot work, because the folder's
  // permissions are identical on every attempt. Rust now leads its refusal with a stable code and
  // this row maps the code to a sentence of its own; the backend's words still never reach the UI.

  it("turns the «folder anyone can write to» refusal into its own message, not «try again»", async () => {
    const onSaveFailed = vi.fn();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") return false;
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      if (cmd === "set_autostart")
        throw new Error(
          "AUTOSTART_REFUSED_REPLACEABLE: the install folder is writable by an account that is not an administrator (its directory: S-1-5-11). Reinstall into Program Files."
        );
      return null;
    });

    render(<GeneralSection {...defaultProps} onSaveFailed={onSaveFailed} />);
    fireEvent.click(screen.getByRole("switch", { name: AUTOSTART }));

    await waitFor(() =>
      expect(onSaveFailed).toHaveBeenCalledWith("messages.settings_autostart_needs_program_files")
    );
    // The backend's own sentence stays in app.log where it belongs (T-28-20).
    expect(screen.queryByText(/S-1-5-11|writable|administrator/)).toBeNull();
  });

  it("maps the «could not check the folder» refusal to its own message too", async () => {
    const onSaveFailed = vi.fn();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") return false;
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      if (cmd === "set_autostart")
        throw new Error("AUTOSTART_REFUSED_ACL_UNKNOWN: the folder could not be checked (CR-01)");
      return null;
    });

    render(<GeneralSection {...defaultProps} onSaveFailed={onSaveFailed} />);
    fireEvent.click(screen.getByRole("switch", { name: AUTOSTART }));

    await waitFor(() =>
      expect(onSaveFailed).toHaveBeenCalledWith("messages.settings_autostart_acl_unknown")
    );
  });

  // ─── G-32-15: a stopped «Планировщик задач» must be NAMED, not met with «try again» ───
  //
  // Measured 2026-09-09: the Task Scheduler service stopped, rebooted, and pressing this
  // switch six times in 33 seconds against «Не удалось сохранить настройку. Попробуйте ещё раз».
  // Pressing a switch again cannot start a stopped service, so the advice was unfollowable by
  // construction. Rust now asks the Service Control Manager and leads its refusal with a code.

  it("names the stopped Task Scheduler service instead of saying «try again»", async () => {
    const onSaveFailed = vi.fn();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") return false;
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      if (cmd === "set_autostart")
        throw new Error(
          "AUTOSTART_REFUSED_SCHEDULER_UNAVAILABLE: the Windows Task Scheduler service is not running. RegisterTaskDefinition: The system cannot find the path specified. (0x80070003)"
        );
      return null;
    });

    render(<GeneralSection {...defaultProps} onSaveFailed={onSaveFailed} />);
    fireEvent.click(screen.getByRole("switch", { name: AUTOSTART }));

    await waitFor(() =>
      expect(onSaveFailed).toHaveBeenCalledWith(
        "messages.settings_autostart_scheduler_unavailable"
      )
    );
    // T-28-20: the backend's own prose — and the HRESULT — stay in app.log.
    expect(screen.queryByText(/RegisterTaskDefinition|0x80070003/)).toBeNull();
  });

  it("calls the service by the name Windows itself shows in the services list", () => {
    // The owner reads «Планировщик задач» in services.msc. A sentence naming «Планировщик заданий»
    // sends him looking for something that is not in the list — the sort of near-miss that makes a
    // remedy unfollowable while looking perfectly helpful.
    expect(ru.messages.settings_autostart_scheduler_unavailable).toContain("Планировщик задач");
    expect(ru.messages.settings_autostart_scheduler_unavailable).not.toContain(
      "Планировщик заданий"
    );
    // The same slip lives in the row's own «could not read» sentence, which is the OTHER surface
    // this defect shows on — the dim row the read path produces.
    expect(ru.settings.app.autostart_unknown).not.toContain("Планировщик заданий");
  });

  it("records a failed MOUNT read in the activity log, not only a failed refresh", async () => {
    // The instrument gap G-32-15 turned up. `refresh` has logged `settings.autostart.read_failed`
    // since G-32-13; the mount read swallowed its failure with a bare `.catch`, so the very first
    // read of a session — the one that runs before any window focus — left no trace at all. The
    // activity.log for 17:08–17:09 is silent for exactly that reason.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") throw new Error("ITaskService::Connect failed");
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });

    render(<GeneralSection {...defaultProps} />);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "write_activity_log",
        expect.objectContaining({
          message: expect.stringContaining("settings.autostart.read_failed trigger=mount"),
        })
      )
    );
  });

  // ─── G-32-18: the READ path knows the reason too, and must say it ───
  //
  // Measured 2026-09-10, build `x4nb7d`, with the service really stopped. `app.log` carried
  // «AUTOSTART_REFUSED_SCHEDULER_UNAVAILABLE: the Windows Task Scheduler service («Schedule») is not
  // running…» while `activity.log` carried a bare `settings.autostart.read_failed trigger=tab-poll`
  // every five seconds — and the ROW showed the generic «Не удалось прочитать состояние». The
  // classification existed, crossed the Rust boundary, and died in a `.catch` that took no argument.
  //
  // These assert on what RENDERS, not on an internal flag: the defect was invisible to every flag —
  // `autostartUnreadable` was perfectly correct the whole time — and visible only on screen.

  /** What `task_is_enabled` really rejects with once `explain_scheduler_failure` has classified it. */
  const SCHEDULER_DOWN =
    "AUTOSTART_REFUSED_SCHEDULER_UNAVAILABLE: the Windows Task Scheduler service («Schedule») is " +
    "not running, so no logon task can be registered, read or removed until it is started. " +
    "ITaskFolder::GetFolder: The system cannot find the path specified. (0x80070003)";

  it("names the stopped Task Scheduler service on the ROW, not only in the save message", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      // A bare string, not an `Error`: that is what a Tauri command declared `Result<_, String>`
      // actually rejects with, and the row has to read the code out of that shape.
      if (cmd === "get_autostart") return Promise.reject(SCHEDULER_DOWN);
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });

    // `active={false}` ISOLATES THE MOUNT READ, and it is here because a mutation said so: with the
    // default `active`, the tab-active refresh fires immediately after mount and its own failure
    // sets the same key — so a mount handler that dropped the reason (which is exactly the defect
    // this round repaired) was covered up within the same tick and this assertion still passed. A
    // test that cannot see the defect it was written for is a test that would have shipped it. The
    // refresh path is not left untested by this: it has its own case, immediately below.
    render(<GeneralSection {...defaultProps} active={false} />);

    const target = screen.getByRole("switch", { name: AUTOSTART });
    await waitFor(() => expect(target).toBeDisabled());
    // The sentence is read out of the shipped bundle, never retyped here.
    await waitFor(() =>
      expect(
        screen.getByText(ru.settings.app.autostart_scheduler_unavailable)
      ).toBeInTheDocument()
    );
    // The generic sentence is what the owner actually read, and it must be gone when the program
    // knows better.
    expect(screen.queryByText(ru.settings.app.autostart_unknown)).toBeNull();
    expect(screen.queryByText(ru.settings.app.autostart_desc)).toBeNull();
    // T-28-20: only the CODE crosses the boundary. The backend's prose, the interface name and the
    // HRESULT stay in app.log.
    expect(screen.queryByText(/AUTOSTART_REFUSED|GetFolder|0x80070003|Schedule/)).toBeNull();
  });

  it("names the service when the scheduler stops while the user is sitting on the tab", async () => {
    // The other half of the same contract, on the path a real log shows firing every five
    // seconds: the first read succeeds, the service stops, and the refresh must carry the reason
    // through exactly as the mount read does.
    let readable = true;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") {
        if (!readable) return Promise.reject(SCHEDULER_DOWN);
        return true;
      }
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });

    render(<GeneralSection {...defaultProps} />);
    const target = screen.getByRole("switch", { name: AUTOSTART });
    await waitFor(() => expect(target).toHaveAttribute("aria-checked", "true"));

    readable = false;
    fireEvent.focus(window);

    await waitFor(() =>
      expect(
        screen.getByText(ru.settings.app.autostart_scheduler_unavailable)
      ).toBeInTheDocument()
    );
    expect(target).toBeDisabled();
  });

  it("puts the code in the read_failed log line, so the next diagnosis is one grep", async () => {
    // `settings.autostart.read_failed trigger=tab-poll` on its own is what two minutes of the
    // activity.log says, twenty-four times, about a cause the program had already named in
    // the other file. The line now carries the code, so the two files can be read as one.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") return Promise.reject(SCHEDULER_DOWN);
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });

    render(<GeneralSection {...defaultProps} />);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "write_activity_log",
        expect.objectContaining({
          message:
            "settings.autostart.read_failed trigger=mount code=AUTOSTART_REFUSED_SCHEDULER_UNAVAILABLE",
        })
      )
    );
  });

  it("logs code=UNCODED rather than a slice of the backend's own sentence", async () => {
    // The `sshErrorCode` vocabulary, for the same reason it exists there: the field is whitelisted
    // by SHAPE, so nothing a backend happens to put in front of the first colon can ride into the
    // user's log inside a field labelled `code=`.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart")
        return Promise.reject(new Error("ITaskService::Connect failed: 0x800706ba"));
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });

    render(<GeneralSection {...defaultProps} />);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "write_activity_log",
        expect.objectContaining({
          message: "settings.autostart.read_failed trigger=mount code=UNCODED",
        })
      )
    );
  });

  it("keeps the generic sentence for a read that failed for a reason nobody classified", async () => {
    // The control for the two above, and it is not decoration: a mapping that answered «the
    // scheduler is stopped» to every failed read would send people to a service that was running
    // all along — the «левая ошибка» the owner asked to be protected from in G-32-15.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart")
        return Promise.reject(new Error("ITaskService::Connect failed"));
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });

    render(<GeneralSection {...defaultProps} />);

    await waitFor(() =>
      expect(screen.getByText(ru.settings.app.autostart_unknown)).toBeInTheDocument()
    );
    expect(screen.queryByText(ru.settings.app.autostart_scheduler_unavailable)).toBeNull();
  });

  it("calls the service by its services.msc name on the ROW's sentence as well", () => {
    // The same near-miss guarded for the save message: «Планировщик заданий» is not in the list the
    // owner opens, so a remedy naming it is unfollowable while looking perfectly helpful.
    expect(ru.settings.app.autostart_scheduler_unavailable).toContain("Планировщик задач");
    expect(ru.settings.app.autostart_scheduler_unavailable).not.toContain("Планировщик заданий");
    // And it must not end in advice the row cannot take: the switch is disabled while unreadable,
    // so there is nothing here to «попробовать снова».
    expect(ru.settings.app.autostart_scheduler_unavailable).not.toContain("попробуйте снова");
  });

  it("falls back to the generic message for a refusal it has no sentence for", async () => {
    // A failure nobody anticipated is still better shown as «could not save» than as a raw string
    // from a scheduler API — the fallback is the safety net, not a bug.
    const onSaveFailed = vi.fn();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") return false;
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      if (cmd === "set_autostart") throw new Error("0x80070005 access denied");
      return null;
    });

    render(<GeneralSection {...defaultProps} onSaveFailed={onSaveFailed} />);
    fireEvent.click(screen.getByRole("switch", { name: AUTOSTART }));

    await waitFor(() => expect(onSaveFailed).toHaveBeenCalledWith(undefined));
  });

  // ─── G-32-13: the row re-reads when the window comes back ───
  //
  // Owner bug, 2026-09-09, build `k9tzr4`: he disabled the logon task in Task Scheduler, returned
  // to the app, and the switch still read ON. The read was never the problem — `get_autostart`
  // reports the task's live state — but it happened exactly once per app LAUNCH, because this panel
  // is never unmounted (App.tsx keeps every tab mounted and hides them with opacity/visibility), so
  // `useEffect(…, [])` could not fire again. The answer on screen was hours old.
  //
  // These tests pin the CONTRACT, not the mechanism: after the user has been away — which is the
  // only window in which an outside change can happen — the row shows what the operating system
  // says now. `window.focus` and `visibilitychange` are how that is detected today.

  it("re-reads the autostart state when the window regains focus, and redraws what the OS now says", async () => {
    let taskEnabled = true;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") return taskEnabled;
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });

    render(<GeneralSection {...defaultProps} />);
    const target = screen.getByRole("switch", { name: AUTOSTART });
    await waitFor(() => expect(target).toHaveAttribute("aria-checked", "true"));

    // The user leaves for Task Scheduler and disables the task there. Nothing in the app is touched.
    taskEnabled = false;
    fireEvent.focus(window);

    await waitFor(() => expect(target).toHaveAttribute("aria-checked", "false"));
  });

  it("re-reads on the native window focus event too, not only the DOM one", async () => {
    // Two triggers on purpose (2026-09-09): `window`'s DOM focus is the document's notion of focus
    // and the webview can hold it while Windows does not consider the window active; `tauri://focus`
    // is the OS-level answer. This test pins the second one by driving the listener the component
    // registers through the mocked window bridge.
    let taskEnabled = true;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") return taskEnabled;
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });
    const listen = vi.mocked(getCurrentWindow()).listen;
    listen.mockClear();

    render(<GeneralSection {...defaultProps} />);
    const target = screen.getByRole("switch", { name: AUTOSTART });
    await waitFor(() => expect(target).toHaveAttribute("aria-checked", "true"));

    const call = listen.mock.calls.find(([event]) => event === "tauri://focus");
    expect(call).toBeTruthy();
    const handler = call![1] as () => void;

    taskEnabled = false;
    handler();

    await waitFor(() => expect(target).toHaveAttribute("aria-checked", "false"));
  });

  it("writes the moment the switch and the OS stop agreeing, with the trigger that caught it", async () => {
    // The instrument itself is under test: when the switch and the Task Scheduler disagree on a real
    // machine, the answer has to come from a file rather than from anybody's memory. It logs the
    // DISAGREEMENT, not every read — see the companion test below.
    let taskEnabled = true;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") return taskEnabled;
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });

    render(<GeneralSection {...defaultProps} />);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: AUTOSTART })).toHaveAttribute("aria-checked", "true")
    );

    taskEnabled = false;
    fireEvent.focus(window);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("write_activity_log", {
        tag: "STATE",
        message: "settings.autostart.changed from=true to=false trigger=dom-focus",
        details: "GeneralSection",
      })
    );
  });

  it("logs the disagreement even when the read lands before React flushes its effects", async () => {
    // Root cause of the 2026-09-10 full-suite flake, pinned so it cannot come back silently.
    //
    // Change detection compares the backend's answer against `autostartRef` — «what is on screen
    // right now». That mirror used to be written by a passive effect, and the two clocks involved
    // are not the same one: a read resolves on a MICROTASK, React flushes passive effects in a
    // SCHEDULED task after it. A read landing in that gap compares the operating system's new
    // answer against a mirror still holding the row's mount default, finds no disagreement, and
    // says nothing at all — the instrument goes silent exactly when it has something to report.
    //
    // Alone, this file always won that race and the test above passed 53/53; under the full suite
    // (253 files) the flush lost it and the same test failed twice in a row, with a later `tab-poll`
    // line in the log where the `dom-focus` one should have been. That is what a load-sensitive
    // green looks like: not a slow test, a MISSED observation.
    //
    // Nothing here waits and nothing here is timed. The gap is entered on purpose: the mount read's
    // promise chain is drained with bare microtasks, which gives React no scheduled task to flush
    // in, and the focus arrives inside it. The `act(...)` warnings this prints are the point — the
    // component is deliberately observed between a state update and its flush, which is precisely
    // the state a loaded machine leaves it in.
    let taskEnabled = true;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") return taskEnabled;
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });

    render(<GeneralSection {...defaultProps} />);
    // Let the mount read settle — microtasks only, no timers, no act flush.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // The user disabled the task elsewhere and comes back to the window.
    taskEnabled = false;
    fireEvent.focus(window);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("write_activity_log", {
        tag: "STATE",
        message: "settings.autostart.changed from=true to=false trigger=dom-focus",
        details: "GeneralSection",
      })
    );
  });

  it("stays quiet in the log while nothing changes", async () => {
    // A line per return-to-window would bury the user's own log under noise nobody reads, and this
    // row is re-read on a timer while its tab is open.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") return true;
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });

    render(<GeneralSection {...defaultProps} />);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: AUTOSTART })).toHaveAttribute("aria-checked", "true")
    );

    fireEvent.focus(window);
    fireEvent.focus(window);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_autostart"));

    const logged = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "write_activity_log");
    expect(logged).toHaveLength(0);
  });

  it("re-reads while its tab is the visible one, without waiting for the window to be clicked", async () => {
    // The recorded reading of the log, and the case every focus trigger misses: Settings and Task
    // Scheduler side by side, both visible, neither clicked. Looking at a window is not focusing it.
    vi.useFakeTimers();
    try {
      let taskEnabled = true;
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "get_autostart") return taskEnabled;
        if (cmd === "get_start_minimized") return false;
        if (cmd === "get_geodata_auto_update") return true;
        return null;
      });

      render(<GeneralSection {...defaultProps} active />);
      const target = screen.getByRole("switch", { name: AUTOSTART });
      await vi.waitFor(() => expect(target).toHaveAttribute("aria-checked", "true"));

      taskEnabled = false;
      await vi.advanceTimersByTimeAsync(5000);

      await vi.waitFor(() => expect(target).toHaveAttribute("aria-checked", "false"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll while its tab is hidden", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "get_autostart") return true;
        if (cmd === "get_start_minimized") return false;
        if (cmd === "get_geodata_auto_update") return true;
        return null;
      });

      render(<GeneralSection {...defaultProps} active={false} />);
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("get_autostart"));
      const readsAfterMount = vi
        .mocked(invoke)
        .mock.calls.filter(([cmd]) => cmd === "get_autostart").length;

      await vi.advanceTimersByTimeAsync(30_000);

      const readsLater = vi
        .mocked(invoke)
        .mock.calls.filter(([cmd]) => cmd === "get_autostart").length;
      expect(readsLater).toBe(readsAfterMount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads when the window becomes visible again", async () => {
    let taskEnabled = true;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") return taskEnabled;
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });

    render(<GeneralSection {...defaultProps} />);
    const target = screen.getByRole("switch", { name: AUTOSTART });
    await waitFor(() => expect(target).toHaveAttribute("aria-checked", "true"));

    taskEnabled = false;
    // The window was hidden (minimised to tray) and comes back. jsdom keeps `visibilityState` on
    // the document object, so the value is stubbed for the length of the event.
    const restore = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    fireEvent(document, new Event("visibilitychange"));

    await waitFor(() => expect(target).toHaveAttribute("aria-checked", "false"));

    if (restore) Object.defineProperty(document, "visibilityState", restore);
  });

  it("does not read across a write in flight — the handle stays where the user moved it", async () => {
    const write = deferred<null>();
    let reads = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") {
        reads += 1;
        // The stale answer a refresh would redraw if it were allowed to run mid-write.
        return false;
      }
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      if (cmd === "set_autostart") return write.promise;
      return null;
    });

    render(<GeneralSection {...defaultProps} />);
    const target = screen.getByRole("switch", { name: AUTOSTART });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_autostart"));
    const readsBefore = reads;

    fireEvent.click(target);
    await waitFor(() => expect(target).toHaveAttribute("aria-checked", "true"));

    // Focus arrives while the write is still going — Windows raises it when the elevation prompt
    // or any other window closes over the app.
    fireEvent.focus(window);
    expect(reads).toBe(readsBefore);
    expect(target).toHaveAttribute("aria-checked", "true");

    write.resolve(null);
    await waitFor(() => expect(defaultProps.onSaved).toHaveBeenCalledTimes(1));
  });

  it("says «could not read» when the refresh itself cannot ask the scheduler", async () => {
    let readable = true;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_autostart") {
        if (!readable) throw new Error("ITaskService::Connect failed");
        return true;
      }
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });

    render(<GeneralSection {...defaultProps} />);
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: AUTOSTART })).toHaveAttribute("aria-checked", "true")
    );
    expect(screen.queryByText(ru.settings.app.autostart_unknown)).toBeNull();

    // The Task Scheduler service is stopped while the user is away.
    readable = false;
    fireEvent.focus(window);

    await waitFor(() =>
      expect(screen.getByText(ru.settings.app.autostart_unknown)).toBeInTheDocument()
    );
    // Not silently drawn as OFF: an unknown state is a disabled control with words, exactly as on
    // the mount path.
    expect(screen.getByRole("switch", { name: AUTOSTART })).toBeDisabled();
  });

  // ─── Phase 23: geodata auto-update row (D-12/D-13) ───

  it("renders the geodata auto-update toggle", () => {
    render(<GeneralSection {...defaultProps} />);
    expect(screen.getByText("Обновлять базу маршрутов автоматически")).toBeInTheDocument();
  });

  it("reads the persisted geodata auto-update setting on mount", async () => {
    render(<GeneralSection {...defaultProps} />);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("get_geodata_auto_update");
    });
  });

  it("writes the geodata auto-update setting through when flipped off", async () => {
    render(<GeneralSection {...defaultProps} />);
    // Addressed by accessible name, not by index: the label is forwarded to the switch a11y name
    // (Toggle D-03.2), so a future row appended above cannot silently retarget this assertion.
    const geodataSwitch = await screen.findByRole("switch", {
      name: "Обновлять базу маршрутов автоматически",
    });
    await waitFor(() => expect(geodataSwitch).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(geodataSwitch);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("set_geodata_auto_update", { enabled: false });
    });
  });

  /**
   * CR-03: the Routing card reads this same setting but is never unmounted, so it only learns
   * about a change if this writer announces it. The broadcast is the contract between the two —
   * asserted here (emitted, and only after a successful write) and consumed in
   * GeoDataStatus.test.tsx.
   */
  it("broadcasts the change so the never-unmounted Routing card re-reads it", async () => {
    const onChanged = vi.fn();
    window.addEventListener(GEODATA_AUTO_UPDATE_CHANGED, onChanged);

    render(<GeneralSection {...defaultProps} />);
    const geodataSwitch = await screen.findByRole("switch", {
      name: "Обновлять базу маршрутов автоматически",
    });
    await waitFor(() => expect(geodataSwitch).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(geodataSwitch);

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    window.removeEventListener(GEODATA_AUTO_UPDATE_CHANGED, onChanged);
  });

  // ─── Phase 28 (28-07): the Phase-27 design ───

  /**
   * The card's rows are `SettingsRow`s now, so «which row is this» is a question about the
   * accessible names IN ORDER — the order itself is the claim, unlike an assertion that reaches a
   * single control by its index.
   */
  it("renders the four rows in the fixed order: autostart, start minimized, logging, geodata", () => {
    render(<GeneralSection {...defaultProps} />);
    expect(screen.getAllByRole("switch").map((el) => el.getAttribute("aria-label"))).toEqual([
      "Запускать вместе с системой",
      "Запускать в свёрнутом режиме",
      "Собирать логи",
      "Обновлять базу маршрутов автоматически",
    ]);
  });

  /**
   * Every row keeps its explanation — the description is the second, quieter line of the row.
   *
   * The logging description is read from the locale rather than retyped here: since 32-FIX-08 it
   * carries the two-folder sentence, and a copy of that long string in this file would be a second
   * place to keep in step. What this test claims is «every row HAS its description», and the
   * logging one's CONTENT has a test of its own further down.
   */
  it("renders each row's description beneath its label", () => {
    render(<GeneralSection {...defaultProps} />);
    for (const description of [
      "Запускать TrustTunnel при старте Windows",
      "Скрывать окно при запуске, показывать только в трее",
      ru.settings.app.logging_desc,
      "Базы GeoIP/GeoSite и списки групп обновляются в фоне раз в сутки",
    ]) {
      expect(screen.getByText(description)).toBeInTheDocument();
    }
  });

  /**
   * The header glyph sits in a tinted tile — the tab's main «this was redesigned» signal, and the
   * accent counterpart of `SettingsCard`'s warning tile. Asserted on the token pair rather than on
   * a class.
   *
   * (The warning tile had exactly one wearer, «Экспериментальные функции», and that card was
   * removed on 2026-09-03 with the site-blocking feature. The accent side is unchanged.)
   */
  it("paints the header tile from the ACCENT tint/fg pair", () => {
    const { container } = render(<GeneralSection {...defaultProps} />);
    const tile = container.querySelector<HTMLElement>(
      '[style*="--color-accent-tint-10"]'
    );
    expect(tile).not.toBeNull();
    expect(tile!.getAttribute("style")).toContain("--color-accent-fg");
  });

  it("shows no «Показать в папке» affordance while the log is off", () => {
    render(<GeneralSection {...defaultProps} />);
    expect(screen.queryByRole("button", { name: "Показать в папке" })).toBeNull();
  });

  /**
   * The affordance is an ICON with a tooltip inside the logging row's right-hand group — not a
   * bordered labelled button on a line of its own. jsdom has no layout, so «the card's height does
   * not change» is asserted structurally: the icon joins an EXISTING row (it shares that row with
   * the logging switch and appears in no other row) and adds no row of its own.
   */
  it("puts «Показать в папке» inside the logging row, adding no row of its own", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_logging_enabled") return true;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });
    render(<GeneralSection {...defaultProps} />);

    const folder = await screen.findByRole("button", { name: "Показать в папке" });
    const loggingSwitch = screen.getByRole("switch", { name: "Собирать логи" });
    const autostartSwitch = screen.getByRole("switch", { name: "Запускать вместе с системой" });

    // An ICON with a tooltip: the name comes from `aria-label`, and the button carries no visible
    // caption of its own. The bordered labelled button this replaces was rejected on owner review.
    expect(folder.textContent?.trim()).toBe("");
    expect(folder).toHaveAttribute("aria-label", "Показать в папке");

    const loggingRow = rowOf(loggingSwitch, "Собирать логи");
    expect(loggingRow.contains(folder)).toBe(true);
    // Not the whole card: the row that holds the icon must not also hold another setting.
    expect(loggingRow.contains(autostartSwitch)).toBe(false);
    // The card still reads as four rows — the icon widened a right-hand group, it did not add one.
    expect(screen.getAllByRole("switch")).toHaveLength(4);
  });

  it("asks the app to open the log folder when the icon is pressed", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_logging_enabled") return true;
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });
    render(<GeneralSection {...defaultProps} />);
    fireEvent.click(await screen.findByRole("button", { name: "Показать в папке" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_logs_folder"));
  });

  // ─── Phase 32 (32-FIX-08, gap G-32-2d): where the two folders are ───

  /**
   * `initial-read`: the values are still on their way and the card stands on its defaults. No
   * skeleton and no spinner — a placeholder for a value that arrives in a moment is a longer,
   * noisier way of showing the same card.
   */
  it("shows neither skeleton nor spinner while the values are still on their way", () => {
    const { container } = render(<GeneralSection {...defaultProps} />);
    expect(container.querySelector(".animate-spin")).toBeNull();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  /** A `false` seed would flash a wrong OFF on every mount, because the real read is async. */
  it("seeds the geodata switch ON before the persisted value arrives", () => {
    render(<GeneralSection {...defaultProps} />);
    expect(
      screen.getByRole("switch", { name: "Обновлять базу маршрутов автоматически" })
    ).toHaveAttribute("aria-checked", "true");
  });

  /** A failed write must not announce a change that did not happen. */
  it("does NOT broadcast when the backend write fails", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      if (cmd === "set_geodata_auto_update") throw new Error("disk full");
      return null;
    });
    const onChanged = vi.fn();
    window.addEventListener(GEODATA_AUTO_UPDATE_CHANGED, onChanged);

    render(<GeneralSection {...defaultProps} />);
    const geodataSwitch = await screen.findByRole("switch", {
      name: "Обновлять базу маршрутов автоматически",
    });
    await waitFor(() => expect(geodataSwitch).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(geodataSwitch);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("set_geodata_auto_update", { enabled: false });
    });
    expect(onChanged).not.toHaveBeenCalled();
    window.removeEventListener(GEODATA_AUTO_UPDATE_CHANGED, onChanged);
  });

  // ─── Phase 28 (28-07) Task 3: `saving` and `write-failed` ───
  //
  // Historical note (28-06, retired 2026-08-26): these used to avoid the autostart switch, because
  // its write went through a dynamically imported plugin module and `restoreMocks: true` stripped
  // that module mock's resolved values before every test — a write driven through it silently
  // never completed. The 2026-08-26 owner-bug fix moved the row onto plain `invoke` commands, so
  // the constraint is gone; the autostart write contract is now asserted in its own block above.

  it("marks ONLY the row being written as busy, and leaves the other three operable", async () => {
    const write = deferred<null>();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      if (cmd === "set_start_minimized") return write.promise;
      return null;
    });
    render(<GeneralSection {...defaultProps} />);

    const target = screen.getByRole("switch", { name: START_MINIMIZED });
    fireEvent.click(target);

    await waitFor(() => expect(target).toHaveAttribute("aria-busy", "true"));
    // The knob stays where the user just moved it — the write is running, not refused.
    expect(target).toHaveAttribute("aria-checked", "true");

    // A section-wide flag would have frozen all four. Only this one is occupied.
    for (const name of [AUTOSTART, LOGGING, GEODATA]) {
      const other = screen.getByRole("switch", { name });
      expect(other).not.toHaveAttribute("aria-busy");
      expect(other).toBeEnabled();
    }

    write.resolve(null);
    await waitFor(() => expect(target).not.toHaveAttribute("aria-busy"));
  });

  /**
   * A dimmed row says «сюда нельзя»; here you can, the app is simply writing. And the control must
   * not be swapped for a standalone spinner: a control that disappears and comes back reads as a
   * second, unrelated thing going wrong.
   */
  it("neither dims the busy row nor removes or adds a control while the write runs", async () => {
    const write = deferred<null>();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      if (cmd === "set_start_minimized") return write.promise;
      return null;
    });
    render(<GeneralSection {...defaultProps} />);

    const target = screen.getByRole("switch", { name: START_MINIMIZED });
    const row = rowOf(target, START_MINIMIZED);
    const controlsBefore = row.querySelectorAll("button").length;

    fireEvent.click(target);
    await waitFor(() => expect(target).toHaveAttribute("aria-busy", "true"));

    expect(row.outerHTML).not.toContain("--opacity-disabled");
    expect(row.querySelectorAll("button")).toHaveLength(controlsBefore);
    expect(screen.getAllByRole("switch")).toHaveLength(4);

    write.resolve(null);
    await waitFor(() => expect(target).not.toHaveAttribute("aria-busy"));
  });

  it("leaves the toggle at the new value and reports the saved outcome once", async () => {
    render(<GeneralSection {...defaultProps} />);
    const target = screen.getByRole("switch", { name: START_MINIMIZED });
    fireEvent.click(target);

    await waitFor(() => expect(defaultProps.onSaved).toHaveBeenCalledTimes(1));
    expect(target).toHaveAttribute("aria-checked", "true");
  });

  /**
   * The honest value after a refusal is the one the APP reports, not the inverse of what was
   * pressed. The mock makes the two differ: the log reads OFF at mount, the user turns it ON, the
   * write refuses, and the re-read now answers ON. Inverting locally would land on OFF.
   */
  it("returns the toggle to the value the backend reports, not to the inverse of the press", async () => {
    const onSaveFailed = vi.fn();
    let readsSoFar = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      if (cmd === "get_logging_enabled") {
        readsSoFar += 1;
        return readsSoFar > 1; // mount says OFF; the re-read after the refusal says ON
      }
      if (cmd === "set_logging_enabled") throw new Error("disk is read-only");
      return null;
    });

    render(<GeneralSection {...defaultProps} onSaveFailed={onSaveFailed} />);
    const target = screen.getByRole("switch", { name: LOGGING });
    await waitFor(() => expect(target).toHaveAttribute("aria-checked", "false"));

    fireEvent.click(target);

    await waitFor(() => expect(onSaveFailed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(target).toHaveAttribute("aria-checked", "true"));
    expect(target).not.toHaveAttribute("aria-busy");
    expect(defaultProps.onSaved).not.toHaveBeenCalled();
    // The backend's own words never reach the screen (T-28-23).
    expect(screen.queryByText(/read-only/)).toBeNull();
  });

  /** The geodata row's own refusal keeps its FAB-05 re-read AND now says why the switch moved back. */
  it("reports the failed outcome once for the geodata row and puts it back on the backend value", async () => {
    const onSaveFailed = vi.fn();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_start_minimized") return false;
      if (cmd === "get_geodata_auto_update") return true;
      if (cmd === "set_geodata_auto_update") throw new Error("disk full");
      return null;
    });

    render(<GeneralSection {...defaultProps} onSaveFailed={onSaveFailed} />);
    const target = screen.getByRole("switch", { name: GEODATA });
    fireEvent.click(target);

    await waitFor(() => expect(onSaveFailed).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(target).toHaveAttribute("aria-checked", "true"));
  });
});
