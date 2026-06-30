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

  // 12-07: the auto-connect toggle MOVED — GeneralSection must NOT render it anymore.
  it("does NOT render the auto-connect toggle (moved to «Авто-режим»)", () => {
    render(<GeneralSection {...defaultProps} />);
    expect(screen.queryByText("Подключаться автоматически")).not.toBeInTheDocument();
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
});
