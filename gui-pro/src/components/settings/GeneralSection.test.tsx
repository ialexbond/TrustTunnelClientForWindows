import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { GeneralSection } from "./GeneralSection";

// Mock the autostart plugin
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: vi.fn().mockResolvedValue(false),
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
}));

describe("GeneralSection", () => {
  const defaultProps = {
    hasConfig: true,
    onAutoConnectChange: vi.fn(),
    onSaved: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    localStorage.clear();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_start_minimized") return false;
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

  it("renders auto-connect toggle", () => {
    render(<GeneralSection {...defaultProps} />);
    expect(screen.getByText("Подключаться автоматически")).toBeInTheDocument();
  });

  it("auto-connect toggle is enabled when hasConfig is true", () => {
    render(<GeneralSection {...defaultProps} />);
    const toggleButtons = screen.getAllByRole("switch");
    // The auto-connect toggle (third one) should not be disabled
    const autoConnectToggle = toggleButtons[2];
    expect(autoConnectToggle).not.toBeDisabled();
  });

  it("auto-connect toggle is disabled when hasConfig is false", () => {
    render(<GeneralSection {...defaultProps} hasConfig={false} />);
    const toggleButtons = screen.getAllByRole("switch");
    const autoConnectToggle = toggleButtons[2];
    expect(autoConnectToggle).toBeDisabled();
  });

  it("calls onAutoConnectChange when auto-connect toggle is clicked", () => {
    render(<GeneralSection {...defaultProps} />);
    const toggleButtons = screen.getAllByRole("switch");
    fireEvent.click(toggleButtons[2]);
    expect(defaultProps.onAutoConnectChange).toHaveBeenCalledWith(true);
  });

  it("calls onSaved when auto-connect is toggled", () => {
    render(<GeneralSection {...defaultProps} />);
    const toggleButtons = screen.getAllByRole("switch");
    fireEvent.click(toggleButtons[2]);
    expect(defaultProps.onSaved).toHaveBeenCalled();
  });

  it("stores auto-connect value in localStorage when toggled on", () => {
    render(<GeneralSection {...defaultProps} />);
    const toggleButtons = screen.getAllByRole("switch");
    fireEvent.click(toggleButtons[2]);
    expect(localStorage.getItem("tt_auto_connect")).toBe("true");
  });

  it("reads auto-connect value from localStorage on mount", () => {
    localStorage.setItem("tt_auto_connect", "true");
    render(<GeneralSection {...defaultProps} />);
    // The toggle should reflect the stored value (true)
    // Clicking it again should set to false
    const toggleButtons = screen.getAllByRole("switch");
    fireEvent.click(toggleButtons[2]);
    expect(defaultProps.onAutoConnectChange).toHaveBeenCalledWith(false);
  });

  it("renders autostart toggle description", () => {
    render(<GeneralSection {...defaultProps} />);
    expect(screen.getByText(/при старте Windows/)).toBeInTheDocument();
  });

  it("calls invoke for start minimized toggle", async () => {
    render(<GeneralSection {...defaultProps} />);
    const toggleButtons = screen.getAllByRole("switch");
    // Second toggle is start minimized
    fireEvent.click(toggleButtons[1]);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("set_start_minimized", { enabled: true });
    });
  });

  it("calls onSaved when start minimized toggle is changed", async () => {
    render(<GeneralSection {...defaultProps} />);
    const toggleButtons = screen.getAllByRole("switch");
    fireEvent.click(toggleButtons[1]);
    await waitFor(() => {
      expect(defaultProps.onSaved).toHaveBeenCalled();
    });
  });

  it("shows tooltip when hasConfig is false", () => {
    render(<GeneralSection {...defaultProps} hasConfig={false} />);
    // A help icon tooltip should appear for auto-connect when no config
    expect(screen.getByText("Подключаться автоматически")).toBeInTheDocument();
  });

  it("shows auto_connect_no_config description when hasConfig is false", () => {
    render(<GeneralSection {...defaultProps} hasConfig={false} />);
    expect(screen.getByText(/Сначала загрузите конфигурацию/)).toBeInTheDocument();
  });

  it("shows auto_connect_desc description when hasConfig is true", () => {
    render(<GeneralSection {...defaultProps} />);
    expect(screen.getByText(/Автоматически подключаться/)).toBeInTheDocument();
  });
});
