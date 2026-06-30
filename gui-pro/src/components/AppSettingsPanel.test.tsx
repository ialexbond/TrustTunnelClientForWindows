import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../shared/i18n";
import AppSettingsPanel from "./AppSettingsPanel";
import { renderWithProviders as render } from "../test/test-utils";

// Mock the autostart plugin
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: vi.fn().mockResolvedValue(false),
  enable: vi.fn().mockResolvedValue(undefined),
  disable: vi.fn().mockResolvedValue(undefined),
}));

// Mock useFeatureToggles
vi.mock("../shared/hooks/useFeatureToggles", () => ({
  useFeatureToggles: () => ({
    toggles: { blockRouting: false, processFilter: false },
    update: vi.fn(),
  }),
}));

describe("AppSettingsPanel", () => {
  // 12-07: AppSettingsPanel no longer takes `hasConfig` (that prop only fed the auto-connect toggle
  // that has since MOVED out of GeneralSection into «Авто-режим»).
  const defaultProps = {
    theme: "system" as const,
    onThemeChange: vi.fn(),
    language: "ru",
    onLanguageChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    localStorage.clear();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "get_start_minimized") return false;
      // 12-07: AutoModeSettings (now mounted here) reads the config manifest via list_configs.
      if (cmd === "list_configs") return [];
      return null;
    });
  });

  it("renders GeneralSection", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Основные")).toBeInTheDocument();
  });

  it("renders AppearanceSection", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Оформление")).toBeInTheDocument();
  });

  it("renders ExperimentalSection", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Экспериментальные функции")).toBeInTheDocument();
  });

  // 12-07: «Авто-режим» (AutoModeSettings) is now mounted in the Settings panel.
  it("renders AutoModeSettings («Авто-режим»)", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Авто-режим")).toBeInTheDocument();
  });

  it("renders all sections together", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Основные")).toBeInTheDocument();
    expect(screen.getByText("Авто-режим")).toBeInTheDocument();
    expect(screen.getByText("Оформление")).toBeInTheDocument();
    expect(screen.getByText("Экспериментальные функции")).toBeInTheDocument();
  });

  it("renders statusPanel when provided", () => {
    render(
      <AppSettingsPanel
        {...defaultProps}
        statusPanel={<div data-testid="status-panel">Status</div>}
      />
    );
    expect(screen.getByTestId("status-panel")).toBeInTheDocument();
  });

  it("renders appearance controls (theme and language)", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Тема оформления")).toBeInTheDocument();
    expect(screen.getByText("Язык интерфейса")).toBeInTheDocument();
  });

  it("renders general toggles (autostart, minimized) — NOT the moved auto-connect toggle", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Запускать вместе с системой")).toBeInTheDocument();
    expect(screen.getByText("Запускать в свёрнутом режиме")).toBeInTheDocument();
    // 12-07: the old GeneralSection auto-connect label is GONE (moved to «Авто-режим»).
    expect(screen.queryByText("Подключаться автоматически")).not.toBeInTheDocument();
  });

  // 12-07: the startup auto-connect toggle now lives in «Авто-режим» with its honest last-used label.
  it("renders the startup auto-connect toggle in «Авто-режим»", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Автоподключение при запуске")).toBeInTheDocument();
  });
});
