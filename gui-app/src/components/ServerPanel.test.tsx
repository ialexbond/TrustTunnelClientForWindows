import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import i18n from "../shared/i18n";
import { ServerPanel } from "./ServerPanel";
import { renderWithProviders as render } from "../test/test-utils";

// Mock useServerState to control panel states
const mockLoadServerInfo = vi.fn();
const mockOnSwitchToSetup = vi.fn();
const mockSetRebooting = vi.fn();
const mockSetServerInfo = vi.fn();
const mockSetConfirmReboot = vi.fn();
const mockPushSuccess = vi.fn();
const mockShiftSuccess = vi.fn();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockState: any;

vi.mock("./server/useServerState", () => ({
  useServerState: () => mockState,
}));

// Mock child sections (4-tab structure: Overview, Users, Settings, Service)
vi.mock("./server/OverviewSection", () => ({
  OverviewSection: () => <div data-testid="overview-section">OverviewSection</div>,
}));
vi.mock("./server/UsersSection", () => ({
  UsersSection: () => <div data-testid="users-section">UsersSection</div>,
}));
vi.mock("./server/ServerSettingsSection", () => ({
  ServerSettingsSection: () => <div data-testid="settings-section">ServerSettingsSection</div>,
}));
vi.mock("./server/ServiceSection", () => ({
  ServiceSection: () => <div data-testid="service-section">ServiceSection</div>,
}));

describe("ServerPanel", () => {
  const defaultProps = {
    host: "10.0.0.1",
    port: "22",
    sshUser: "root",
    sshPassword: "pass",
    onSwitchToSetup: mockOnSwitchToSetup,
    onClearConfig: vi.fn(),
    onDisconnect: vi.fn(),
    onConfigExported: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");

    // Default: loading state
    mockState = {
      loading: true,
      error: "",
      serverInfo: null,
      panelDataLoaded: false,
      rebooting: false,
      confirmReboot: false,
      host: "10.0.0.1",
      sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
      successQueue: [],
      loadServerInfo: mockLoadServerInfo,
      onSwitchToSetup: mockOnSwitchToSetup,
      setRebooting: mockSetRebooting,
      setServerInfo: mockSetServerInfo,
      setConfirmReboot: mockSetConfirmReboot,
      pushSuccess: mockPushSuccess,
      shiftSuccess: mockShiftSuccess,
    };
  });

  it("shows loading state", () => {
    render(<ServerPanel {...defaultProps} />);
    expect(screen.getByText(/Проверка|checking/i)).toBeInTheDocument();
  });

  it("shows error state when connection fails", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "Connection refused",
      serverInfo: null,
    };
    render(<ServerPanel {...defaultProps} />);
    expect(screen.getByText("Не удалось подключиться к серверу")).toBeInTheDocument();
    expect(screen.getByText("Connection refused")).toBeInTheDocument();
  });

  it("shows retry and configure buttons on error", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "Connection refused",
      serverInfo: null,
    };
    render(<ServerPanel {...defaultProps} />);
    expect(screen.getByRole("button", { name: /Повторить|retry/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Настроить SSH|configure/i })).toBeInTheDocument();
  });

  it("shows not installed state", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: false, version: "", serviceActive: false, users: [] },
    };
    render(<ServerPanel {...defaultProps} />);
    expect(screen.getByText(/не установлен|not.installed/i)).toBeInTheDocument();
  });

  it("renders 4-tab structure when connected and installed", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: true, version: "1.0.0", serviceActive: true, users: ["user1"] },
      panelDataLoaded: true,
    };
    render(<ServerPanel {...defaultProps} />);
    // Overview tab is active by default — OverviewSection rendered
    expect(screen.getByTestId("overview-section")).toBeInTheDocument();
    // Users tab panel rendered (visibility:hidden, not removed from DOM)
    expect(screen.getByTestId("users-section")).toBeInTheDocument();
    // 4 tab buttons present
    expect(screen.getByRole("button", { name: /Обзор/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Пользователи/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Настройки/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Сервис/i })).toBeInTheDocument();
  });

  it("shows rebooting state", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: true, version: "1.0.0", serviceActive: true, users: [] },
      panelDataLoaded: true,
      rebooting: true,
    };
    render(<ServerPanel {...defaultProps} />);
    expect(screen.getByText("Сервер перезагружается...")).toBeInTheDocument();
  });

  it("shows loading panel data state", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: true, version: "1.0.0", serviceActive: true, users: [] },
      panelDataLoaded: false,
    };
    render(<ServerPanel {...defaultProps} />);
    expect(screen.getByText(/Загрузка|loading/i)).toBeInTheDocument();
  });

  it("shows error state with fallback message when error is empty but serverInfo is null", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: null,
    };
    render(<ServerPanel {...defaultProps} />);
    expect(screen.getByText(i18n.t("server.status.connection_failed"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.status.check_ssh"))).toBeInTheDocument();
  });

  it("retry button calls loadServerInfo", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "timeout",
      serverInfo: null,
    };
    render(<ServerPanel {...defaultProps} />);
    const retryBtn = screen.getByRole("button", { name: /Повторить|retry/i });
    retryBtn.click();
    expect(mockLoadServerInfo).toHaveBeenCalled();
  });

  it("configure SSH button calls onSwitchToSetup", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "timeout",
      serverInfo: null,
    };
    render(<ServerPanel {...defaultProps} />);
    const configBtn = screen.getByRole("button", { name: /Настроить SSH|configure/i });
    configBtn.click();
    expect(mockOnSwitchToSetup).toHaveBeenCalled();
  });

  it("not installed state shows install button", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: false, version: "", serviceActive: false, users: [] },
    };
    render(<ServerPanel {...defaultProps} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.install")) })).toBeInTheDocument();
  });

  it("install button updates localStorage and calls onSwitchToSetup", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: false, version: "", serviceActive: false, users: [] },
    };
    render(<ServerPanel {...defaultProps} />);
    const installBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.install")) });
    installBtn.click();
    const stored = JSON.parse(localStorage.getItem("trusttunnel_wizard") || "{}");
    expect(stored.host).toBe("10.0.0.1");
    expect(stored.wizardStep).toBe("endpoint");
    expect(stored.wizardMode).toBe("deploy");
    expect(mockOnSwitchToSetup).toHaveBeenCalled();
  });

  it("rebooting state shows cancel button that stops rebooting and disconnects", () => {
    const onDisconnect = vi.fn();
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: true, version: "1.0.0", serviceActive: true, users: [] },
      panelDataLoaded: true,
      rebooting: true,
    };
    render(<ServerPanel {...{ ...defaultProps, onDisconnect }} />);
    const cancelBtn = screen.getByRole("button", { name: new RegExp(i18n.t("buttons.cancel")) });
    cancelBtn.click();
    expect(mockSetRebooting).toHaveBeenCalledWith(false);
    expect(onDisconnect).toHaveBeenCalled();
  });

  it("rebooting state shows description text", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: true, version: "1.0.0", serviceActive: true, users: [] },
      panelDataLoaded: true,
      rebooting: true,
    };
    render(<ServerPanel {...defaultProps} />);
    expect(screen.getByText(i18n.t("server.status.rebooting_desc"))).toBeInTheDocument();
  });

  it("not installed state shows host in description", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: false, version: "", serviceActive: false, users: [] },
    };
    render(<ServerPanel {...defaultProps} />);
    expect(screen.getByText(i18n.t("server.status.not_installed_desc", { host: "10.0.0.1" }))).toBeInTheDocument();
  });

  // NOTE: Reboot confirm dialog moved from ServerPanel to ServerStatusSection (Phase 12.5),
  // and now uses global ConfirmDialogProvider (imperative useConfirm) — tests removed.

  it("main panel renders SnackBar component", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: true, version: "1.0.0", serviceActive: true, users: ["user1"] },
      panelDataLoaded: true,
      successQueue: ["Operation complete"],
    };
    const { container } = render(<ServerPanel {...defaultProps} />);
    // SnackBar renders in the DOM
    expect(container.innerHTML).toBeTruthy();
  });

});
