import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { ProcessPickerModal } from "./ProcessPickerModal";
import type { ProcessInfo } from "./useRoutingState";

describe("ProcessPickerModal", () => {
  let onConfirm: any;
  let onClose: any;

  const processList: ProcessInfo[] = [
    { name: "chrome.exe", path: "C:\\Chrome\\chrome.exe" },
    { name: "firefox.exe", path: "C:\\Firefox\\firefox.exe" },
    { name: "code.exe", path: "C:\\VSCode\\code.exe" },
    { name: "node.exe", path: "C:\\node\\node.exe" },
  ];

  beforeEach(() => {
    i18n.changeLanguage("ru");
    onConfirm = vi.fn();
    onClose = vi.fn();
  });

  function renderModal(overrides: {
    open?: boolean;
    loading?: boolean;
    alreadyAdded?: string[];
    processes?: ProcessInfo[];
  } = {}) {
    return render(
      <ProcessPickerModal
        open={overrides.open ?? true}
        processes={overrides.processes ?? processList}
        loading={overrides.loading ?? false}
        alreadyAdded={overrides.alreadyAdded ?? []}
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );
  }

  it("renders nothing when closed", () => {
    renderModal({ open: false });
    expect(screen.queryByText("Выберите процессы")).not.toBeInTheDocument();
  });

  it("renders modal title when open", () => {
    renderModal();
    expect(screen.getByText("Выберите процессы")).toBeInTheDocument();
  });

  it("shows search input", () => {
    renderModal();
    expect(screen.getByPlaceholderText("Поиск по имени...")).toBeInTheDocument();
  });

  it("displays process list", () => {
    renderModal();
    expect(screen.getByText("chrome.exe")).toBeInTheDocument();
    expect(screen.getByText("firefox.exe")).toBeInTheDocument();
    expect(screen.getByText("code.exe")).toBeInTheDocument();
    expect(screen.getByText("node.exe")).toBeInTheDocument();
  });

  it("shows process paths", () => {
    renderModal();
    expect(screen.getByText("C:\\Chrome\\chrome.exe")).toBeInTheDocument();
  });

  it("filters processes by search query", async () => {
    renderModal();
    const input = screen.getByPlaceholderText("Поиск по имени...");
    await userEvent.type(input, "chrome");
    expect(screen.getByText("chrome.exe")).toBeInTheDocument();
    expect(screen.queryByText("firefox.exe")).not.toBeInTheDocument();
  });

  it("shows 'no processes found' when search has no matches", async () => {
    renderModal();
    const input = screen.getByPlaceholderText("Поиск по имени...");
    await userEvent.type(input, "nonexistent");
    expect(screen.getByText("Процессы не найдены")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    renderModal({ loading: true });
    // Loading spinner should be present, no process names
    expect(screen.queryByText("chrome.exe")).not.toBeInTheDocument();
  });

  it("marks already-added processes as disabled", () => {
    renderModal({ alreadyAdded: ["chrome.exe"] });
    // The button for chrome should be disabled
    const chromeBtn = screen.getByText("chrome.exe").closest("button");
    expect(chromeBtn).toBeDisabled();
    // Should show 'already added' label
    expect(screen.getByText("добавлен")).toBeInTheDocument();
  });

  it("confirm button is disabled when nothing selected", () => {
    renderModal();
    const confirmBtn = screen.getByText("Добавить");
    expect(confirmBtn.closest("button")).toBeDisabled();
  });

  it("selects a process and enables confirm", async () => {
    renderModal();
    const codeBtn = screen.getByText("code.exe").closest("button")!;
    await userEvent.click(codeBtn);
    // Confirm button should show count and be enabled
    expect(screen.getByText("Добавить (1)")).toBeInTheDocument();
    const confirmBtn = screen.getByText("Добавить (1)").closest("button");
    expect(confirmBtn).not.toBeDisabled();
  });

  it("calls onConfirm with selected processes", async () => {
    renderModal();
    await userEvent.click(screen.getByText("code.exe").closest("button")!);
    await userEvent.click(screen.getByText("node.exe").closest("button")!);
    await userEvent.click(screen.getByText("Добавить (2)"));
    expect(onConfirm).toHaveBeenCalledWith(expect.arrayContaining(["code.exe", "node.exe"]));
  });

  it("calls onClose when cancel button is clicked", async () => {
    renderModal();
    await userEvent.click(screen.getByText("Отмена"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("deselects a process on second click", async () => {
    renderModal();
    const codeBtn = screen.getByText("code.exe").closest("button")!;
    await userEvent.click(codeBtn);
    expect(screen.getByText("Добавить (1)")).toBeInTheDocument();
    await userEvent.click(codeBtn);
    // Back to disabled confirm with no count
    expect(screen.getByText("Добавить")).toBeInTheDocument();
  });

  it("deduplicates processes with same name", () => {
    const duped: ProcessInfo[] = [
      { name: "chrome.exe", path: "path1" },
      { name: "chrome.exe", path: "path2" },
      { name: "firefox.exe", path: "path3" },
    ];
    renderModal({ processes: duped });
    const chromeItems = screen.getAllByText("chrome.exe");
    expect(chromeItems).toHaveLength(1);
  });
});
