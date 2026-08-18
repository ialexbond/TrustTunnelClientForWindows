import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { GeneralSection } from "./GeneralSection";
import { GEODATA_AUTO_UPDATE_CHANGED } from "../../shared/utils/geodataAutoUpdateSignal";

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
});
