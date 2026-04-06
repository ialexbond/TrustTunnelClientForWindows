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
  const defaultProps = {
    theme: "system" as const,
    onThemeChange: vi.fn(),
    language: "ru",
    onLanguageChange: vi.fn(),
    hasConfig: true,
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

  it("renders all three sections together", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Основные")).toBeInTheDocument();
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

  it("renders general toggles (autostart, minimized, auto-connect)", () => {
    render(<AppSettingsPanel {...defaultProps} />);
    expect(screen.getByText("Запускать вместе с системой")).toBeInTheDocument();
    expect(screen.getByText("Запускать в свёрнутом режиме")).toBeInTheDocument();
    expect(screen.getByText("Подключаться автоматически")).toBeInTheDocument();
  });
});
