import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import i18n from "../shared/i18n";
import { ServerPanel } from "./ServerPanel";
import { renderWithProviders as render } from "../test/test-utils";

// Mock useServerState to control panel states
const mockLoadServerInfo = vi.fn();
const mockOnSwitchToSetup = vi.fn();
const mockOnDisconnect = vi.fn();
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

// Mock child sections (5-tab structure: overview / users / configuration /
// security / service — Phase 19 renamed utilities → service per UI-SPEC §A).
vi.mock("./server/OverviewSection", () => ({
  OverviewSection: () => <div data-testid="overview-section">OverviewSection</div>,
}));
vi.mock("./server/UsersSection", () => ({
  UsersSection: () => <div data-testid="users-section">UsersSection</div>,
}));
vi.mock("./server/ServerSettingsSection", () => ({
  ServerSettingsSection: () => <div data-testid="settings-section">ServerSettingsSection</div>,
}));
vi.mock("./server/SecurityTabSection", () => ({
  SecurityTabSection: () => <div data-testid="security-section">SecurityTabSection</div>,
}));
vi.mock("./server/ServiceTabSection", () => ({
  ServiceTabSection: () => <div data-testid="service-section">ServiceTabSection</div>,
}));

describe("ServerPanel", () => {
  const defaultProps = {
    host: "10.0.0.1",
    port: "22",
    sshUser: "root",
    sshPassword: "pass",
    onSwitchToSetup: mockOnSwitchToSetup,
    onClearConfig: vi.fn(),
    onDisconnect: mockOnDisconnect,
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
      onDisconnect: mockOnDisconnect,
      setRebooting: mockSetRebooting,
      setServerInfo: mockSetServerInfo,
      setConfirmReboot: mockSetConfirmReboot,
      pushSuccess: mockPushSuccess,
      shiftSuccess: mockShiftSuccess,
    };
  });

  it("shows loading state", () => {
    render(<ServerPanel {...defaultProps} />);
    // Phase 3 false-green fix (RESEARCH §3 stream 6): was a dual-language regex
    // /Проверка|checking/i that passes under either locale even if the wrong
    // copy renders. Assert the exact i18n string so a green proves the real
    // `server.status.checking` label rendered.
    expect(screen.getByText(i18n.t("server.status.checking"))).toBeInTheDocument();
  });

  it("shows error state when connection fails", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "Connection refused",
      serverInfo: null,
    };
    render(<ServerPanel {...defaultProps} />);
    // Phase 3 false-green fix (RESEARCH §3 stream 6): was a hardcoded RU literal
    // that silently rots if the translation key changes. Assert via i18n.t so
    // the test tracks the real `server.status.connection_failed` value. The
    // backend error string ("Connection refused") is not translated — kept as-is.
    expect(screen.getByText(i18n.t("server.status.connection_failed"))).toBeInTheDocument();
    expect(screen.getByText("Connection refused")).toBeInTheDocument();
  });

  it("shows retry and disconnect buttons on error", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "Connection refused",
      serverInfo: null,
    };
    render(<ServerPanel {...defaultProps} />);
    expect(screen.getByRole("button", { name: /Повторить|retry/i })).toBeInTheDocument();
    // Phase 13.UAT G-04b: "Настроить SSH" replaced с "Отключиться" — чистый exit
    // на SshConnectForm вместо wizard. "Настроить SSH" вёл в setup wizard, но
    // юзер ожидал логин-экран.
    expect(screen.getByRole("button", { name: /Отключ|disconnect/i })).toBeInTheDocument();
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

  it("renders 5-tab structure when connected and installed", () => {
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
    // 5 tabs with role="tab" present (WAI-ARIA, Phase 12.5 manual activation)
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    expect(screen.getByRole("tab", { name: /Обзор/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Пользователи/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Конфигурация/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Безопасность/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Сервис/i })).toBeInTheDocument();
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
    // Phase 3 false-green fix (RESEARCH §3 stream 6): was a hardcoded RU literal
    // ("Сервер перезагружается...") — replaced with i18n.t so the assertion
    // follows the real `server.status.rebooting` translation.
    expect(screen.getByText(i18n.t("server.status.rebooting"))).toBeInTheDocument();
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
    // Phase 3 false-green fix (RESEARCH §3 stream 6): was a dual-language regex
    // /Загрузка|loading/i. Assert the exact i18n string so the green proves the
    // real `server.status.loading_panel` "wait for panel data" copy rendered.
    expect(screen.getByText(i18n.t("server.status.loading_panel"))).toBeInTheDocument();
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

  it("disconnect button on error screen calls onDisconnect (G-04b)", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "timeout",
      serverInfo: null,
    };
    render(<ServerPanel {...defaultProps} />);
    const disconnectBtn = screen.getByRole("button", { name: /Отключ|disconnect/i });
    disconnectBtn.click();
    expect(mockOnDisconnect).toHaveBeenCalled();
  });

  it("not installed state shows install button", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: false, version: "", serviceActive: false, users: [] },
    };
    render(<ServerPanel {...defaultProps} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("buttons.install")) })).toBeInTheDocument();
  });

  it("install button updates localStorage and calls onSwitchToSetup", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: false, version: "", serviceActive: false, users: [] },
    };
    render(<ServerPanel {...defaultProps} />);
    const installBtn = screen.getByRole("button", { name: new RegExp(i18n.t("buttons.install")) });
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

  it("renders main tabbed panel when connected, installed and panel data loaded", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: true, version: "1.0.0", serviceActive: true, users: ["user1"] },
      panelDataLoaded: true,
      successQueue: ["Operation complete"],
    };
    render(<ServerPanel {...defaultProps} />);
    // Phase 3 false-green fix (RESEARCH §3 stream 6): the old assertion was
    // `container.innerHTML).toBeTruthy()` — a tautology that passes for ANY
    // non-empty render (even an error screen). The mocked `useServerState`
    // means `successQueue` never reaches the provider-driven SnackBar, so there
    // is no real snackbar text to assert. Instead assert the actual main-panel
    // path was taken: ServerTabs mounts its WAI-ARIA tablist + the default
    // Overview tab content (OverviewSection is mocked in this file). This
    // genuinely proves the "connected + installed + panelDataLoaded" branch.
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByTestId("overview-section")).toBeInTheDocument();
  });

  it("Phase 19 cascade fix — onServerInfoVersionChange callback fires with current state.serverInfo.version on mount + every change", async () => {
    // First mount: serverInfo.version = "1.0.33"
    const cb1 = vi.fn();
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: true, version: "1.0.33", serviceActive: true, users: ["u1"] },
      panelDataLoaded: true,
    };
    const { unmount } = render(<ServerPanel {...defaultProps} onServerInfoVersionChange={cb1} />);
    await waitFor(() => {
      expect(cb1).toHaveBeenCalledWith("1.0.33");
    });
    unmount();

    // Second mount: serverInfo.version = "1.0.31" — callback fires with new value
    const cb2 = vi.fn();
    mockState = {
      ...mockState,
      serverInfo: { installed: true, version: "1.0.31", serviceActive: true, users: ["u1"] },
    };
    render(<ServerPanel {...defaultProps} onServerInfoVersionChange={cb2} />);
    await waitFor(() => {
      expect(cb2).toHaveBeenCalledWith("1.0.31");
    });
  });

  // ── Phase 3 gap-fill (RESEARCH §3 stream 6) ──

  it("does not call onPanelReady while panelDataLoaded is false", () => {
    const onPanelReady = vi.fn();
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: true, version: "1.0.0", serviceActive: true, users: ["u1"] },
      panelDataLoaded: false,
    };
    render(<ServerPanel {...defaultProps} onPanelReady={onPanelReady} />);
    // ServerPanel's useEffect only fires onPanelReady when panelDataLoaded flips
    // truthy — the skeleton-dismissal contract ControlPanelPage relies on.
    expect(onPanelReady).not.toHaveBeenCalled();
  });

  it("fires onPanelReady when panelDataLoaded is true (skeleton-dismissal signal)", async () => {
    const onPanelReady = vi.fn();
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: true, version: "1.0.0", serviceActive: true, users: ["u1"] },
      panelDataLoaded: true,
    };
    render(<ServerPanel {...defaultProps} onPanelReady={onPanelReady} />);
    // The useEffect keyed on state.panelDataLoaded calls onPanelReady — this is
    // how ControlPanelPage knows to hide ServerPanelSkeleton (isFirstConnect).
    await waitFor(() => {
      expect(onPanelReady).toHaveBeenCalled();
    });
  });

  it("forwards cascade props to ServerTabs — service-tab-update-dot appears when hasSidecarUpdate=true", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: true, version: "1.0.0", serviceActive: true, users: ["u1"] },
      panelDataLoaded: true,
    };
    // ServerPanel forwards hasSidecarUpdate to the real ServerTabs (only the 5
    // server SECTIONS are mocked in this file, ServerTabs itself is real). The
    // dot renders on the «Сервис» pill when an update exists AND the user is not
    // already on the service tab (default active tab is overview). Asserting the
    // user-visible testid proves the prop actually reached the chrome, not just
    // that a prop was passed (the render-through lesson — RESEARCH §4.4).
    render(<ServerPanel {...defaultProps} hasSidecarUpdate={true} />);
    expect(screen.getByTestId("service-tab-update-dot")).toBeInTheDocument();
  });

  it("does NOT render service-tab-update-dot when hasSidecarUpdate is false", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: true, version: "1.0.0", serviceActive: true, users: ["u1"] },
      panelDataLoaded: true,
    };
    render(<ServerPanel {...defaultProps} hasSidecarUpdate={false} />);
    expect(screen.queryByTestId("service-tab-update-dot")).not.toBeInTheDocument();
  });

});
