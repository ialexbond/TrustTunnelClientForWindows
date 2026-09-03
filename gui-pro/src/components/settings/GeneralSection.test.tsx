import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
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

  /** Every row keeps its explanation — the description is the second, quieter line of the row. */
  it("renders each row's description beneath its label", () => {
    render(<GeneralSection {...defaultProps} />);
    for (const description of [
      "Запускать TrustTunnel при старте Windows",
      "Скрывать окно при запуске, показывать только в трее",
      "Сохранять журнал событий и вывод VPN-ядра в файлы",
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
