import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { ProcessFilterSection } from "./ProcessFilterSection";
import type { ProcessInfo } from "./useRoutingState";

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
    { name: "chrome.exe", path: "C:\\Program Files\\Chrome\\chrome.exe" },
    { name: "firefox.exe", path: "C:\\Program Files\\Firefox\\firefox.exe" },
    { name: "code.exe", path: "C:\\Program Files\\VSCode\\code.exe" },
  ];

  beforeEach(() => {
    i18n.changeLanguage("ru");
    onModeChange = vi.fn();
    onAdd = vi.fn();
    onRemove = vi.fn();
    onLoadProcesses = vi.fn().mockResolvedValue(undefined);
  });

  function renderSection(overrides: {
    processMode?: "exclude" | "only";
    processes?: string[];
  } = {}) {
    return render(
      <ProcessFilterSection
        processMode={overrides.processMode ?? "exclude"}
        processes={overrides.processes ?? defaultProcesses}
        processList={defaultProcessList}
        processListLoading={false}
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

  it("shows add process button", () => {
    renderSection();
    expect(screen.getByText("Добавить процесс")).toBeInTheDocument();
  });

  it("shows browse button", () => {
    renderSection();
    expect(screen.getByText("Обзор")).toBeInTheDocument();
  });

  it("calls onLoadProcesses and opens picker on add click", async () => {
    renderSection();
    const user = userEvent.setup();
    await user.click(screen.getByText("Добавить процесс"));
    expect(onLoadProcesses).toHaveBeenCalledTimes(1);
    // Picker modal opens via Modal portal (async); wait for the header.
    expect(await screen.findByText("Выберите процессы")).toBeInTheDocument();
  });

  it("remove button calls onRemove on hover and click", () => {
    renderSection();
    const removeButtons = screen.getAllByTitle("Удалить процесс");
    expect(removeButtons).toHaveLength(2);
    fireEvent.click(removeButtons[0]);
    expect(onRemove).toHaveBeenCalledWith("chrome.exe");
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
    const removeButtons = screen.getAllByTitle("Удалить процесс");
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
