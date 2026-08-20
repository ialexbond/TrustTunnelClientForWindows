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

  // E-11 (Plan 09-13) INTENTIONAL D-05 characterization update: the error branch
  // used to render the raw `state.error` string + a `server.status.connection_failed`
  // heading. D-05/EW-02 replaces it with the calm ServerUnavailablePlate — the raw
  // SSH error must NOT show (it reads as stale/technical and lies to a non-techie
  // user). These assertions now track the plate's i18n copy. Deliberate net
  // maintenance for a user-approved behavior change, NOT silent drift.
  it("shows the calm unavailable plate (not the raw error) when connection fails", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "Connection refused",
      serverInfo: null,
    };
    render(<ServerPanel {...defaultProps} />);
    expect(
      screen.getByRole("heading", { name: i18n.t("server.unavailable.heading") }),
    ).toBeInTheDocument();
    // The raw backend error string must NOT surface (D-05/EW-02).
    expect(screen.queryByText("Connection refused")).toBeNull();
  });

  it("shows retry and disconnect buttons on error", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "Connection refused",
      serverInfo: null,
    };
    render(<ServerPanel {...defaultProps} />);
    // «Повторить» is now the plate's `server.unavailable.retry`.
    expect(
      screen.getByRole("button", { name: i18n.t("server.unavailable.retry") }),
    ).toBeInTheDocument();
    // Phase 13.UAT G-04b: Disconnect stays as the secondary exit (chistый exit
    // на SshConnectForm вместо wizard).
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

  it("shows the calm unavailable plate when error is empty but serverInfo is null", () => {
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: null,
    };
    render(<ServerPanel {...defaultProps} />);
    // E-11: the !serverInfo path also routes to the calm plate (same branch).
    expect(
      screen.getByRole("heading", { name: i18n.t("server.unavailable.heading") }),
    ).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.unavailable.body"))).toBeInTheDocument();
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
    // CANONICAL `step` (persist.ts reads `step`, not the legacy `wizardStep`) + the
    // one-shot install-entry marker so the wizard opens straight on Settings, no probe.
    expect(stored.step).toBe("endpoint");
    expect(stored.wizardStep).toBeUndefined();
    expect(stored.installEntry).toBe(true);
    expect(stored.wizardMode).toBe("deploy");
    expect(mockOnSwitchToSetup).toHaveBeenCalled();
  });

  // UAT (06-uat fix 3): a fresh install must NOT carry over the previous install's
  // endpoint fields — including ADVANCED settings (metrics/socks5/reverse-proxy/...).
  // The «Установить» seed runs clearEndpointForm, which drops the FULL endpoint+advanced
  // key set and resets certType, so the EndpointStep opens blank instead of showing
  // stale values (e.g. metrics still ON) from a prior install on the same server.
  it("install button clears ALL stale endpoint + advanced fields from a prior install", () => {
    // Pre-seed the blob as if a PREVIOUS install left endpoint + advanced values behind.
    localStorage.setItem(
      "trusttunnel_wizard",
      JSON.stringify({
        domain: "old.example.com",
        email: "old@example.com",
        vpnUsername: "old-user",
        certChainPath: "/etc/ssl/old-cert.pem",
        certKeyPath: "/etc/ssl/old-key.pem",
        certType: "provided",
        // Advanced settings that were leaking forward before fix 3. 06-uat install-wizard
        // slimming removed the Metrics/SOCKS5/Allow-private/ICMP keys from the wizard, and
        // the reverse-proxy / camouflage keys were dropped when that feature was removed
        // entirely, so only the kept advanced setting (407/405) is cleared now.
        authFailureStatusCode: 405,
      }),
    );
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: false, version: "", serviceActive: false, users: [] },
    };
    render(<ServerPanel {...defaultProps} />);
    screen.getByRole("button", { name: new RegExp(i18n.t("buttons.install")) }).click();
    const stored = JSON.parse(localStorage.getItem("trusttunnel_wizard") || "{}");
    // The stale endpoint fields are gone — the wizard's seed regenerates vpnUsername
    // and leaves domain/email blank.
    expect(stored.domain).toBeUndefined();
    expect(stored.email).toBeUndefined();
    expect(stored.vpnUsername).toBeUndefined();
    expect(stored.certChainPath).toBeUndefined();
    expect(stored.certKeyPath).toBeUndefined();
    // The kept ADVANCED key is ALSO cleared (the core of fix 3) — it falls back to
    // its useWizardState default on the fresh mount instead of staying ON.
    expect(stored.authFailureStatusCode).toBeUndefined();
    // certType is reset to the default; host/port/sshUser were (re)seeded from the panel.
    expect(stored.certType).toBe("letsencrypt");
    expect(stored.host).toBe("10.0.0.1");
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

  // NOTE: Reboot confirm dialog moved from ServerPanel to OverviewSection,
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

  // ── E-11: unreachable server → calm plate (not the raw SSH error) ──────────
  //
  // Plan 09-13: ServerPanel had its OWN early-return error screen that surfaced
  // the raw `state.error` string (e.g. "Connection refused") and fired BEFORE
  // ServerTabs' calm ServerUnavailablePlate could ever show. D-05/EW-02: a
  // non-technical user must NOT see the raw SSH/russh error. The error branch now
  // routes to the same calm ServerUnavailablePlate ServerTabs uses, keeping
  // «Повторить» (→ onPanelRetry + loadServerInfo) and Disconnect, and the retry
  // must NEVER clear creds (D-05/D-06 — clearing lives only in handleDisconnect).
  describe("E-11: unreachable → calm plate", () => {
    it("renders the calm «Сервер недоступен» plate and does NOT surface the raw error string", () => {
      mockState = {
        ...mockState,
        loading: false,
        error: "Connection refused: SSH_CHANNEL_FAILURE",
        serverInfo: null,
      };
      render(<ServerPanel {...defaultProps} />);
      expect(
        screen.getByRole("heading", {
          name: i18n.t("server.unavailable.heading"),
        }),
      ).toBeInTheDocument();
      // The raw SSH error must be absent from the DOM (information-exposure-lite).
      expect(
        screen.queryByText(/Connection refused|SSH_CHANNEL_FAILURE/),
      ).toBeNull();
    });

    it("«Повторить» calls loadServerInfo + onPanelRetry and does NOT clear creds", () => {
      const onPanelRetry = vi.fn();
      mockState = {
        ...mockState,
        loading: false,
        error: "timeout",
        serverInfo: null,
      };
      render(<ServerPanel {...defaultProps} onPanelRetry={onPanelRetry} />);
      const retry = screen.getByRole("button", {
        name: i18n.t("server.unavailable.retry"),
      });
      retry.click();
      expect(mockLoadServerInfo).toHaveBeenCalled();
      expect(onPanelRetry).toHaveBeenCalled();
      // D-05/D-06: retry must NOT disconnect / wipe creds.
      expect(mockOnDisconnect).not.toHaveBeenCalled();
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

  // ── H-05: skeleton re-shows on error-then-retry (audit 06 H-05) ──

  it("H-05: retry button fires onPanelRetry so the parent re-arms the skeleton", () => {
    const onPanelRetry = vi.fn();
    mockState = {
      ...mockState,
      loading: false,
      error: "timeout",
      serverInfo: null,
      panelDataLoaded: true, // error path already set this true (the latch source)
    };
    render(<ServerPanel {...defaultProps} onPanelRetry={onPanelRetry} />);
    screen.getByRole("button", { name: /Повторить|retry/i }).click();
    expect(onPanelRetry).toHaveBeenCalled();
    expect(mockLoadServerInfo).toHaveBeenCalled();
  });

  it("H-05: onPanelReady fires AGAIN after an error → retry → reload cycle (resettable, not a one-shot latch)", async () => {
    const onPanelReady = vi.fn();
    // 1. First successful load — onPanelReady fires once (skeleton dismissed).
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: true, version: "1.0.0", serviceActive: true, users: ["u1"] },
      panelDataLoaded: true,
    };
    const { rerender } = render(<ServerPanel {...defaultProps} onPanelReady={onPanelReady} />);
    await waitFor(() => expect(onPanelReady).toHaveBeenCalledTimes(1));

    // 2. Connection drops into an error. NB: loadServerInfo does NOT flip
    //    panelDataLoaded back to false — it stays true (the error path set it).
    mockState = {
      ...mockState,
      loading: false,
      error: "timeout",
      serverInfo: null,
      panelDataLoaded: true,
    };
    rerender(<ServerPanel {...defaultProps} onPanelReady={onPanelReady} />);

    // 3. User clicks retry → a fresh load runs (loading=true). This must RE-ARM
    //    onPanelReady even though panelDataLoaded never went false.
    mockState = {
      ...mockState,
      loading: true,
      error: "",
      serverInfo: null,
      panelDataLoaded: true,
    };
    rerender(<ServerPanel {...defaultProps} onPanelReady={onPanelReady} />);

    // 4. Retry settles successfully.
    mockState = {
      ...mockState,
      loading: false,
      error: "",
      serverInfo: { installed: true, version: "1.0.0", serviceActive: true, users: ["u1"] },
      panelDataLoaded: true,
    };
    rerender(<ServerPanel {...defaultProps} onPanelReady={onPanelReady} />);

    // Pre-fix (effect keyed only on the panelDataLoaded edge) this would stay at
    // 1 because panelDataLoaded never toggled false→true again. The resettable
    // effect fires once more so the re-shown skeleton can be dismissed.
    await waitFor(() => expect(onPanelReady).toHaveBeenCalledTimes(2));
  });

});
