import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import i18n from "../../shared/i18n";
import { ProcessFilterSection } from "./ProcessFilterSection";
import { resetProcessIconCache } from "./useProcessIcons";
import type { ProcessInfo } from "./useRoutingState";

// The OS file dialog is mocked globally in src/test/tauri-mock.ts; the tests below only route its
// return value per test, which is this project's existing two-layer idiom. No second mock is declared.
const dialogMock = vi.mocked(openFileDialog);

describe("ProcessFilterSection", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onModeChange: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onAdd: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onRemove: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onLoadProcesses: any;

  const defaultProcesses = ["chrome.exe", "firefox.exe"];
  const defaultProcessList: ProcessInfo[] = [
    { name: "chrome.exe" },
    { name: "firefox.exe" },
    { name: "code.exe" },
  ];

  beforeEach(() => {
    i18n.changeLanguage("ru");
    onModeChange = vi.fn();
    onAdd = vi.fn();
    onRemove = vi.fn();
    onLoadProcesses = vi.fn().mockResolvedValue(undefined);
    // Default: a cancelled dialog, so a test that never touches the file action stays inert.
    dialogMock.mockReset();
    dialogMock.mockResolvedValue(null);
    // The icon cache is module-level and lives for the whole app session, so it survives from one
    // test to the next; clearing it keeps each test's requests its own.
    resetProcessIconCache();
  });

  function renderSection(overrides: {
    processMode?: "exclude" | "only";
    processes?: string[];
    processListLoading?: boolean;
  } = {}) {
    return render(
      <ProcessFilterSection
        processMode={overrides.processMode ?? "exclude"}
        processes={overrides.processes ?? defaultProcesses}
        processList={defaultProcessList}
        processListLoading={overrides.processListLoading ?? false}
        onModeChange={onModeChange}
        onAdd={onAdd}
        onRemove={onRemove}
        onLoadProcesses={onLoadProcesses}
      />,
    );
  }

  it("renders without crashing", () => {
    renderSection();
    expect(screen.getByText("Фильтрация по процессам")).toBeInTheDocument();
  });

  it("shows description", () => {
    renderSection();
    expect(screen.getByText(/VPN-маршрутизацией/)).toBeInTheDocument();
  });

  it("displays process list", () => {
    renderSection();
    expect(screen.getByText("chrome.exe")).toBeInTheDocument();
    expect(screen.getByText("firefox.exe")).toBeInTheDocument();
  });

  it("shows 'exclude mode' label when processMode is exclude", () => {
    renderSection({ processMode: "exclude" });
    expect(screen.getByText("Исключить из VPN")).toBeInTheDocument();
  });

  it("shows 'only mode' label when processMode is only", () => {
    renderSection({ processMode: "only" });
    expect(screen.getByText("Только через VPN")).toBeInTheDocument();
  });

  // The mode row was rebuilt on SettingsRow + RowToggle so it matches the «Настройки» rows. That
  // swap must not cost the switch its name: RowToggle keeps its label in another cell by default
  // and therefore demands an explicit aria-label, so a careless port would leave the control
  // anonymous to a screen reader while still looking right. The name also has to FOLLOW the mode,
  // because the visible label does.
  it("names the mode switch with the visible label, in both modes", () => {
    const { unmount } = renderSection({ processMode: "exclude" });
    expect(screen.getByRole("switch", { name: "Исключить из VPN" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    unmount();

    renderSection({ processMode: "only" });
    expect(screen.getByRole("switch", { name: "Только через VPN" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("shows add process button", () => {
    renderSection();
    expect(screen.getByText("Добавить процесс")).toBeInTheDocument();
  });

  // ── Feedback for the enumeration wait (ME-04) ────────────────────────────────────────────────
  //
  // `list_running_processes` walks the whole process table. The button that starts it showed
  // nothing while it ran, and the picker's own loading branch was unreachable because the modal
  // only opened AFTER the await had already finished. Both halves are asserted here.

  it("disables the add button while the process list is being fetched", () => {
    renderSection({ processListLoading: true });

    // Acknowledges the click, and stops a second one launching a second full process-table walk.
    expect(screen.getByRole("button", { name: /добавить процесс/i })).toBeDisabled();
  });

  it("opens the picker BEFORE awaiting the list, so its loading state is the real feedback", async () => {
    // A load that does not settle: without opening first, the modal would not exist yet and the
    // user would be staring at an unchanged card.
    let releaseLoad: (() => void) | undefined;
    onLoadProcesses = vi.fn(
      () => new Promise<void>((resolve) => { releaseLoad = resolve; })
    );
    renderSection();
    const user = userEvent.setup();

    await user.click(screen.getByText("Добавить процесс"));

    expect(await screen.findByText("Выберите процессы")).toBeInTheDocument();
    expect(onLoadProcesses).toHaveBeenCalledTimes(1);
    releaseLoad?.();
  });

  // ── One door (D-04) ──────────────────────────────────────────────────────────────────────────
  //
  // The card used to carry a SECOND button beside the add button that opened the OS file dialog on
  // its own, with its own handler, its own duplicate check and its own silent failure. Two entry
  // points into the same list drift apart; adding a program from disk now lives inside the picker.
  // Asserted by a query returning null, not by eye — an absence nobody checks comes back.
  //
  // The label «Обзор» is NOT unique any more: the picker's file action carries it too (it kept the
  // name the card's button always had, because renaming a control the user already knows is its own
  // defect). So scope the absence to the card's own subtree rather than to the whole document —
  // an unscoped `queryByRole` here would pass today only because the picker happens to be closed,
  // and would flip to a false failure the moment someone opens it first.

  it("carries exactly one add control — no separate browse button survives on the card", () => {
    const { container } = renderSection();
    const card = within(container);
    expect(card.queryByRole("button", { name: /обзор/i })).toBeNull();
    expect(card.getAllByRole("button", { name: /добавить процесс/i })).toHaveLength(1);
  });

  it("adds a file picked from disk and a ticked running process in ONE confirmation", async () => {
    // One commit path: whatever the user assembled in the picker — files and running programs
    // alike — arrives through the same confirmation and the same add handler.
    dialogMock.mockResolvedValue("C:\\Tools\\MyApp\\myapp.exe");
    renderSection({ processes: [] });
    const user = userEvent.setup();

    await user.click(screen.getByText("Добавить процесс"));
    expect(await screen.findByText("Выберите процессы")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /обзор/i }));
    // The picked file is SELECTED, not committed: nothing has been added yet.
    expect(await screen.findByRole("checkbox", { name: "myapp.exe" })).toBeInTheDocument();
    expect(onAdd).not.toHaveBeenCalled();

    await user.click(screen.getByRole("checkbox", { name: "code.exe" }));
    await user.click(screen.getByText(/Добавить выбранные/));

    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(onAdd).toHaveBeenCalledWith("myapp.exe");
    expect(onAdd).toHaveBeenCalledWith("code.exe");
  });

  it("calls onLoadProcesses and opens picker on add click", async () => {
    renderSection();
    const user = userEvent.setup();
    await user.click(screen.getByText("Добавить процесс"));
    expect(onLoadProcesses).toHaveBeenCalledTimes(1);
    // Picker modal opens via Modal portal (async); wait for the header.
    expect(await screen.findByText("Выберите процессы")).toBeInTheDocument();
  });

  // The delete control's D-06 tests.
  //
  // Honest limitation, stated once for the three tests below: jsdom loads no Tailwind and does not
  // evaluate `:focus-visible`, so a `toBeVisible()` or computed-style assertion here would pass on
  // the OLD, defective hover-gated button too and would therefore prove nothing. What IS provable
  // in jsdom is the accessible name, keyboard reachability, and the absence of the zero-opacity
  // utility. The visual proof lives in the Storybook stories and in human UAT, and the repo-level
  // machine check is .planning/phases/24-*/scripts/hover-reveal-guard.sh.

  it("remove button calls onRemove when clicked", () => {
    renderSection();
    // Queried by ROLE + accessible name, not by title: that is the assertion. A `title` attribute
    // is an unreliable accessible name, so a role-based lookup only succeeds once the control
    // carries a real `aria-label`.
    const removeButtons = screen.getAllByRole("button", { name: "Удалить процесс" });
    expect(removeButtons).toHaveLength(2);
    fireEvent.click(removeButtons[0]);
    expect(onRemove).toHaveBeenCalledWith("chrome.exe");
  });

  it("remove button is reachable and operable by keyboard", async () => {
    renderSection();
    const user = userEvent.setup();
    const removeButton = screen.getAllByRole("button", { name: "Удалить процесс" })[0];

    // Tab until the control takes focus. A control the keyboard cannot reach cannot be operated
    // without a mouse — and under the old opacity gate it could not even be SEEN once focused.
    for (let i = 0; i < 12 && document.activeElement !== removeButton; i++) {
      await user.tab();
    }
    expect(removeButton).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onRemove).toHaveBeenCalledWith("chrome.exe");
  });

  it("remove button carries no zero-opacity hover gate", () => {
    renderSection();
    const removeButton = screen.getAllByRole("button", { name: "Удалить процесс" })[0];
    // The class-level twin of hover-reveal-guard.sh: the control must not start invisible.
    expect(removeButton.className).not.toContain("opacity-0");
    expect(removeButton.className).not.toContain("group-hover:opacity-100");
  });

  it("gives every saved process row an application-icon slot", () => {
    const { container } = renderSection();
    // One slot per row (D-01). Which of the three states it lands in is ProcessIcon's own test —
    // here the point is only that the row reserves the slot at all, so the list never reflows.
    expect(container.querySelectorAll("[data-process-icon]")).toHaveLength(2);
  });

  it("renders empty state without process list", () => {
    renderSection({ processes: [] });
    expect(screen.queryByText("chrome.exe")).not.toBeInTheDocument();
    // Buttons still present
    expect(screen.getByText("Добавить процесс")).toBeInTheDocument();
  });

  it("toggles mode from exclude to only when toggle is clicked", () => {
    renderSection({ processMode: "exclude" });
    // The Toggle component renders a switch role element
    const toggleButtons = screen.getAllByRole("switch");
    fireEvent.click(toggleButtons[0]);
    expect(onModeChange).toHaveBeenCalledWith("only");
  });

  it("toggles mode from only to exclude when toggle is clicked", () => {
    renderSection({ processMode: "only" });
    const toggleButtons = screen.getAllByRole("switch");
    fireEvent.click(toggleButtons[0]);
    expect(onModeChange).toHaveBeenCalledWith("exclude");
  });

  it("shows exclude mode description when processMode is exclude", () => {
    renderSection({ processMode: "exclude" });
    expect(screen.getByText(/без VPN/)).toBeInTheDocument();
  });

  it("shows only mode description when processMode is only", () => {
    renderSection({ processMode: "only" });
    expect(screen.getByText(/Только выбранные процессы будут использовать VPN/)).toBeInTheDocument();
  });

  it("removes second process when its remove button is clicked", () => {
    renderSection();
    const removeButtons = screen.getAllByRole("button", { name: "Удалить процесс" });
    fireEvent.click(removeButtons[1]);
    expect(onRemove).toHaveBeenCalledWith("firefox.exe");
  });

  it("does not render process list container when processes array is empty", () => {
    const { container } = renderSection({ processes: [] });
    // No process items should exist
    const processItems = container.querySelectorAll(".font-mono");
    expect(processItems).toHaveLength(0);
  });

  it("renders correct number of processes", () => {
    renderSection({ processes: ["a.exe", "b.exe", "c.exe"] });
    expect(screen.getByText("a.exe")).toBeInTheDocument();
    expect(screen.getByText("b.exe")).toBeInTheDocument();
    expect(screen.getByText("c.exe")).toBeInTheDocument();
  });

  it("picker modal opens and shows available processes", async () => {
    renderSection({ processes: [] });
    const user = userEvent.setup();
    // Open the picker
    await user.click(screen.getByText("Добавить процесс"));
    expect(await screen.findByText("Выберите процессы")).toBeInTheDocument();

    // The picker shows available processes (all 3 since none already added)
    expect(screen.getByText("chrome.exe")).toBeInTheDocument();
    expect(screen.getByText("firefox.exe")).toBeInTheDocument();
    expect(screen.getByText("code.exe")).toBeInTheDocument();
  });

  it("closes picker modal without adding when cancelled", async () => {
    renderSection({ processes: [] });
    const user = userEvent.setup();
    await user.click(screen.getByText("Добавить процесс"));
    expect(await screen.findByText("Выберите процессы")).toBeInTheDocument();

    // Close the modal
    const closeBtn = screen.getByText("Отмена");
    await user.click(closeBtn);

    expect(onAdd).not.toHaveBeenCalled();
  });
});
