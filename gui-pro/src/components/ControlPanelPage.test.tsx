import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../shared/i18n";
import { ControlPanelPage } from "./ControlPanelPage";
import { ServerTabs } from "./ServerTabs";
import { SnackBarProvider } from "../shared/ui/SnackBarContext";
import { renderWithProviders as renderE2E } from "../test/test-utils";
import { makeState } from "../test/fixtures";

// Phase 18 Plan 06 — ControlPanelPage uses useSnackBar() для update success
// notification. Wrap render в SnackBarProvider чтобы тесты не падали с
// «useSnackBar must be used within SnackBarProvider».
function renderWithProviders(ui: React.ReactNode) {
  return render(<SnackBarProvider>{ui}</SnackBarProvider>);
}

// Mock child components to isolate ControlPanelPage logic
vi.mock("./ServerPanel", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ServerPanel: (props: any) => {
    return (
      <div data-testid="server-panel">
        ServerPanel host={props.host}
        <span data-testid="mock-sidecar-available">{String(props.sidecarAvailable)}</span>
        <button
          data-testid="mock-emit-version"
          onClick={() => props.onServerInfoVersionChange?.("1.0.31")}
        >
          EmitVersion1031
        </button>
        <button
          data-testid="mock-emit-version-latest"
          onClick={() => props.onServerInfoVersionChange?.("1.0.33")}
        >
          EmitVersion1033
        </button>
        <button data-testid="mock-export-btn" onClick={() => props.onConfigExported("/exported/config.toml")}>Export</button>
        <button data-testid="mock-disconnect-btn" onClick={props.onDisconnect}>Disconnect</button>
        {/* Phase 3 gap-fill — let tests trigger ServerPanel's onPanelReady so the
            ControlPanelPage skeleton (isFirstConnect) dismissal path is exercised. */}
        <button data-testid="mock-panel-ready-btn" onClick={() => props.onPanelReady?.()}>PanelReady</button>
      </div>
    );
  },
}));

// Phase 19 cascade-fix tests — pin latestFromGitHubCP = "1.0.33" deterministically
vi.mock("./server/useSidecarVersions", () => ({
  useSidecarVersions: () => ({
    versions: [
      {
        version: "1.0.33",
        tag: "v1.0.33",
        assetDownloadUrl: "",
        assetSizeBytes: 0,
        publishedAt: "",
      },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

// Phase 19 cascade-fix tests — stub useUpdateChecker to prevent real GitHub calls
vi.mock("../shared/hooks/useUpdateChecker", () => ({
  useUpdateChecker: () => ({
    checkSidecarForServer: vi.fn(),
    dismissSidecarUpdate: vi.fn(),
    updateInfo: {
      appAvailable: false,
      sidecarAvailable: false,
      sidecarCurrentVersion: "",
      sidecarLatestVersion: "",
      sidecarLatestTag: "",
      sidecarDownloadUrl: "",
      sidecarDismissed: false,
      sidecarChecking: false,
      lastChecked: null,
    },
  }),
}));

vi.mock("./server/SshConnectForm", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  SshConnectForm: ({ onConnect }: any) => (
    <div data-testid="ssh-connect-form">
      <button
        data-testid="mock-connect-btn"
        onClick={() =>
          onConnect({
            host: "1.2.3.4",
            port: "22",
            user: "root",
            password: "pass",
          })
        }
      >
        Connect
      </button>
    </div>
  ),
}));

// ─── In-panel E2E cascade test mocks (D-05 / RESEARCH §3 stream 6) ───
//
// The render-through E2E below mounts the REAL ServerTabs + REAL OverviewSection
// so the two IN-PANEL cascade indicators are asserted through the actual chrome
// (not a prop probe). The other four server sections are stubbed — they carry no
// cascade indicator in this tree (the badge lives in ServiceTabSection / stream 5,
// the control-sidecar-update-dot in TabNavigation / stream 7). Mocking them keeps
// the tree light per TESTING.md §Mocking heavy child components.
//
// IMPORTANT: OverviewSection is deliberately NOT mocked — its real Card #8 renders
// the `overview-protocol-update-arrow`. ServerTabs is NOT mocked either — its real
// «Сервис» pill renders the `service-tab-update-dot`.
vi.mock("./server/UsersSection", () => ({
  UsersSection: () => <div data-testid="users-section">UsersSection</div>,
}));
vi.mock("./server/ConfigurationTab", () => ({
  ConfigurationTab: () => <div data-testid="configuration-tab">ConfigurationTab</div>,
  configTabDirtyRef: { current: false },
}));
vi.mock("./server/SecurityTabSection", () => ({
  SecurityTabSection: () => <div data-testid="security-section">SecurityTabSection</div>,
}));
vi.mock("./server/ServiceTabSection", () => ({
  ServiceTabSection: () => <div data-testid="service-section">ServiceTabSection</div>,
}));

const mockInvoke = vi.mocked(invoke);

/** Helper: configure invoke mock to return given creds from load_ssh_credentials */
function mockCredsLoaded(creds: { host: string; port?: string; user?: string; password?: string; keyPath?: string } | null) {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "load_ssh_credentials") {
      if (!creds) return null;
      return {
        host: creds.host,
        port: creds.port || "22",
        user: creds.user || "root",
        password: creds.password || "",
        keyPath: creds.keyPath || "",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (cmd === "clear_ssh_credentials") return null as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (cmd === "save_ssh_credentials") return null as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return null as any;
  });
}

describe("ControlPanelPage", () => {
  const defaultProps = {
    onConfigExported: vi.fn(),
    onSwitchToSetup: vi.fn(),
    onNavigateToSettings: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    localStorage.clear();
    vi.useFakeTimers();
    // Default: no creds
    mockCredsLoaded(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders SSH connect form when no creds", async () => {
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
    expect(screen.queryByTestId("server-panel")).not.toBeInTheDocument();
  });

  it("renders ServerPanel when SSH creds exist", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      port: "22",
      user: "root",
      password: "secret",
    });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("ssh-connect-form")).not.toBeInTheDocument();
  });

  it("shows disconnect button when connected", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      port: "22",
      user: "root",
      password: "secret",
    });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    const btn = screen.getByTestId("mock-disconnect-btn");
    expect(btn).toBeInTheDocument();
  });

  it("disconnect button clears creds and shows SSH form", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      port: "22",
      user: "root",
      password: "secret",
    });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });

    const btn = screen.getByTestId("mock-disconnect-btn");
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("clear_ssh_credentials");
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });

  it("connecting via SshConnectForm shows ServerPanel", async () => {
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-connect-btn"));
    });

    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
    expect(screen.getByText(/host=1\.2\.3\.4/)).toBeInTheDocument();
  });

  // ── plaintext password from backend (keyring) ──

  it("loads plaintext password from backend", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      port: "22",
      user: "root",
      password: "pass123",
    });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
  });

  it("returns null when load_ssh_credentials throws", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_ssh_credentials") throw new Error("backend error");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return null as any;
    });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });

  it("returns null for creds missing host", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (cmd === "load_ssh_credentials") return { host: "", port: "22", user: "root", password: "pass", keyPath: "" } as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return null as any;
    });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });

  it("returns null for creds missing both password and keyPath", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (cmd === "load_ssh_credentials") return { host: "10.0.0.1", port: "22", user: "root", password: "", keyPath: "" } as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return null as any;
    });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });

  it("reads creds with keyPath instead of password", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      keyPath: "/home/.ssh/id_rsa",
    });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
  });

  it("uses default port and user when not specified", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      password: "secret",
    });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
  });

  // ── Disconnect clears refresh signal too ──

  it("disconnect also clears trusttunnel_control_refresh", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      password: "secret",
    });
    localStorage.setItem("trusttunnel_control_refresh", "12345");
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-disconnect-btn"));
    });

    expect(mockInvoke).toHaveBeenCalledWith("clear_ssh_credentials");
    expect(localStorage.getItem("trusttunnel_control_refresh")).toBeNull();
  });

  // ── Refresh signal polling ──

  it("picks up new creds when trusttunnel_control_refresh changes", async () => {
    vi.useRealTimers();
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();

    // Now mock that creds are available and set refresh signal
    mockCredsLoaded({ host: "5.5.5.5", password: "newpass" });
    localStorage.setItem("trusttunnel_control_refresh", Date.now().toString());

    // Wait for the polling interval to pick up the new creds
    await waitFor(() => {
      expect(screen.getByTestId("server-panel")).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it("shows SSH form when creds removed via refresh signal", async () => {
    vi.useRealTimers();
    mockCredsLoaded({
      host: "10.0.0.1",
      password: "secret",
    });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();

    // Simulate creds removal + refresh signal
    mockCredsLoaded(null);
    localStorage.setItem("trusttunnel_control_refresh", Date.now().toString());

    await waitFor(() => {
      expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  // ── Config export callback triggers onNavigateToSettings ──

  it("onConfigExported and onNavigateToSettings called on export", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      password: "secret",
    });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });

    fireEvent.click(screen.getByTestId("mock-export-btn"));

    expect(defaultProps.onConfigExported).toHaveBeenCalledWith("/exported/config.toml");
    expect(defaultProps.onNavigateToSettings).toHaveBeenCalled();
  });

  it("onConfigExported works without onNavigateToSettings prop", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      password: "secret",
    });
    const props = { onConfigExported: vi.fn(), onSwitchToSetup: vi.fn() };
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...props} />);
    });

    fireEvent.click(screen.getByTestId("mock-export-btn"));

    expect(props.onConfigExported).toHaveBeenCalledWith("/exported/config.toml");
  });

  // ── ServerPanel disconnect callback ──

  it("disconnect via ServerPanel callback clears creds", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      password: "secret",
    });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-disconnect-btn"));
    });

    expect(mockInvoke).toHaveBeenCalledWith("clear_ssh_credentials");
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });

  // ── Phase 3 gap-fill (RESEARCH §3 stream 6) ──

  it("calls onSidecarUpdateChange(false) initially when no update is available", async () => {
    const onSidecarUpdateChange = vi.fn();
    mockCredsLoaded({ host: "10.0.0.1", password: "secret" });
    await act(async () => {
      renderWithProviders(
        <ControlPanelPage {...defaultProps} onSidecarUpdateChange={onSidecarUpdateChange} />,
      );
    });
    // No serverInfoVersion lifted yet → localSidecarAvailable=false →
    // sidecarUpdateVisible=false. The lift-to-App callback must report false so
    // the bottom-tab «Панель управления» dot stays off.
    expect(onSidecarUpdateChange).toHaveBeenCalledWith(false);
  });

  it("calls onSidecarUpdateChange(true) when a sidecar update becomes available", async () => {
    vi.useRealTimers();
    const onSidecarUpdateChange = vi.fn();
    mockCredsLoaded({ host: "10.0.0.1", password: "secret" });
    await act(async () => {
      renderWithProviders(
        <ControlPanelPage {...defaultProps} onSidecarUpdateChange={onSidecarUpdateChange} />,
      );
    });

    // ServerPanel emits an outdated version (1.0.31 < latest 1.0.33) → the lifted
    // serverInfoVersion makes localSidecarAvailable true → sidecarUpdateVisible
    // true → onSidecarUpdateChange(true) for the bottom-tab dot.
    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-emit-version"));
    });
    await waitFor(() => {
      expect(onSidecarUpdateChange).toHaveBeenCalledWith(true);
    }, { timeout: 3000 });
  });

  it("isFirstConnect skeleton is shown on auto-reconnect and hidden on onPanelReady", async () => {
    mockCredsLoaded({ host: "10.0.0.1", password: "secret" });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });

    // On auto-reconnect (creds loaded from keyring) ControlPanelPage sets
    // isFirstConnect=true (BUG-01 skeleton instead of full-screen loader). While
    // the skeleton shows, the real ServerPanel wrapper is display:none.
    const wrapperWhileSkeleton = screen.getByTestId("server-panel").parentElement;
    expect(wrapperWhileSkeleton).toHaveStyle({ display: "none" });

    // ServerPanel signals data loaded → onPanelReady flips isFirstConnect off →
    // the panel wrapper becomes visible (skeleton dismissed).
    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-panel-ready-btn"));
    });
    const wrapperAfterReady = screen.getByTestId("server-panel").parentElement;
    expect(wrapperAfterReady).toHaveStyle({ display: "flex" });
  });

  it("persists tt_ssh_last_host/user/port to localStorage on connect via SshConnectForm", async () => {
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-connect-btn"));
    });

    // handleConnect writes the last-used SSH identity so the next visit restores
    // the form (the mock SshConnectForm connects with host=1.2.3.4 user=root port=22).
    expect(localStorage.getItem("tt_ssh_last_host")).toBe("1.2.3.4");
    expect(localStorage.getItem("tt_ssh_last_user")).toBe("root");
    expect(localStorage.getItem("tt_ssh_last_port")).toBe("22");
  });

  it("migrates legacy trusttunnel_control_ssh creds into the keyring and removes the legacy key", async () => {
    // Backend keyring empty → readStoredCredentials falls back to the legacy
    // localStorage blob, saves it via save_ssh_credentials, then removes it.
    const saved: Record<string, unknown>[] = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "load_ssh_credentials") return null as unknown as never;
      if (cmd === "save_ssh_credentials") {
        if (args) saved.push(args as Record<string, unknown>);
        return null as unknown as never;
      }
      return null as unknown as never;
    });
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({ host: "9.9.9.9", port: "2222", user: "admin", password: "legacypass" }),
    );

    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });

    // Legacy creds resolved → ServerPanel mounts.
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
    // Migration persisted the legacy blob into the keyring...
    expect(mockInvoke).toHaveBeenCalledWith(
      "save_ssh_credentials",
      expect.objectContaining({ host: "9.9.9.9", port: "2222", user: "admin", password: "legacypass" }),
    );
    // ...and removed the legacy localStorage key so it migrates exactly once.
    expect(localStorage.getItem("trusttunnel_control_ssh")).toBeNull();
  });

  // ── Phase 19 cascade fix — sidecarAvailable single source of truth ──

  it("Phase 19 cascade fix — sidecarAvailable flips false→true on serverInfo.version downgrade", async () => {
    // Use real timers — fake timers block waitFor's async state flush in this scenario
    vi.useRealTimers();
    mockCredsLoaded({ host: "10.0.0.1", password: "secret" });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    // ServerPanel must be mounted (creds loaded)
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();

    // Initially: no version known → sidecarAvailable=false
    expect(screen.getByTestId("mock-sidecar-available").textContent).toBe("false");

    // Simulate ServerPanel emitting latest version (same as latestFromGitHub=1.0.33)
    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-emit-version-latest"));
    });
    // 1.0.33 === latest → no update available
    expect(screen.getByTestId("mock-sidecar-available").textContent).toBe("false");

    // Simulate downgrade: ServerPanel emits "1.0.31" (below 1.0.33 → update available)
    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-emit-version"));
    });
    // After the callback fires, ControlPanelPage re-derives localSidecarAvailable
    // from the lifted serverInfoVersion — must now be true
    await waitFor(() => {
      expect(screen.getByTestId("mock-sidecar-available").textContent).toBe("true");
    }, { timeout: 3000 });
  });

  it("Phase 19 cascade fix — sidecarAvailable flips true→false on upgrade to latest (mirror direction)", async () => {
    // Use real timers — fake timers block waitFor's async state flush in this scenario
    vi.useRealTimers();
    mockCredsLoaded({ host: "10.0.0.1", password: "secret" });
    await act(async () => {
      renderWithProviders(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();

    // Set version to 1.0.31 → sidecarAvailable should be true (1.0.31 < 1.0.33)
    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-emit-version"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("mock-sidecar-available").textContent).toBe("true");
    }, { timeout: 3000 });

    // Upgrade to latest: emit "1.0.33" → sidecarAvailable should flip to false
    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-emit-version-latest"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("mock-sidecar-available").textContent).toBe("false");
    }, { timeout: 3000 });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// In-panel E2E render-through cascade (D-05 / RESEARCH §3 stream 6 / §4.4)
// ═══════════════════════════════════════════════════════════════════════
//
// The two cascade tests in the `ControlPanelPage` describe above (`mock-sidecar-
// available` prop probe) pin the sidecarAvailable DERIVATION but mock ServerPanel
// away, so they never prove the user-visible indicators actually appear — the
// known false green (RESEARCH §3 stream 6, §4.4). They are KEPT as auxiliary
// (they still pin the derivation logic), and this block ADDS the render-through:
// it mounts the REAL ServerTabs + REAL OverviewSection (the 4 other sections are
// stubbed at file level) and asserts the TWO IN-PANEL indicators APPEAR on
// update-available and RESET when flipped off.
//
// CROSS-TREE SCOPE (the four cascade indicators do NOT all mount in one tree):
//   - service-tab-update-dot       → ServerTabs «Сервис» pill   (THIS tree)
//   - overview-protocol-update-arrow → OverviewSection Card #8  (THIS tree)
//   - protocol-update-badge        → ServiceTabSection          (pinned in plan 06 / stream 5)
//   - control-sidecar-update-dot   → TabNavigation under App    (pinned in plan 07 / stream 7)
// Only the first two live under ServerPanel→ServerTabs(+OverviewSection), so this
// E2E asserts exactly those two. OverviewSection's invoke calls are stubbed null
// by the global tauri-mock, so no new infra is needed.
describe("in-panel cascade E2E (render-through: real ServerTabs + real OverviewSection)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    localStorage.clear();
    // D-07 (Plan 07-06): OverviewSection now gates its real grid behind an
    // all-cards-loaded check. The overview-protocol-update-arrow (Card #8) only
    // renders once every per-card signal SETTLES, so we resolve ping/stats/geo/
    // security here (success or failure both count as settled) to open the gate.
    // The cascade indicators still depend only on the forwarded props, not on any
    // invoke result — we just need the gate open so the loaded grid renders.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "ping_endpoint") return 42;
      if (cmd === "server_get_stats") return null;
      if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
      if (cmd === "server_get_uptime") return { uptime_seconds: 1 };
      if (cmd === "security_get_status") return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } };
      return null;
    });
  });

  /**
   * Mirrors ControlPanelPage's main-panel render of ServerTabs: `sidecarAvailable`
   * drives OverviewSection Card #8's arrow, while `hasSidecarUpdate` drives the
   * ServerTabs «Сервис» pill dot. ControlPanelPage passes
   * `sidecarAvailable={localSidecarAvailable}` and
   * `hasSidecarUpdate={sidecarUpdateVisible}` — both flip together off the same
   * derivation, so the E2E flips them together too.
   */
  function renderPanelChrome(updateAvailable: boolean) {
    return renderE2E(
      <ServerTabs
        state={makeState({ panelDataLoaded: true } as never)}
        hasSidecarUpdate={updateAvailable}
        sidecarAvailable={updateAvailable}
        currentVersion="1.0.20"
        latestVersion="1.0.33"
      />,
    );
  }

  it("both in-panel indicators (service-tab-update-dot + overview-protocol-update-arrow) APPEAR when an update is available — badge pinned in plan 06, control-sidecar-update-dot in plan 07", async () => {
    renderPanelChrome(true);
    // ServerTabs «Сервис» pill dot — visible because update available AND default
    // active tab is overview (dot hides only when the user is on the service tab).
    const dot = screen.getByTestId("service-tab-update-dot");
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveAttribute("aria-label", i18n.t("server.service.tab_update_available_aria"));
    // OverviewSection Card #8 ArrowUpCircle — the real render-through indicator.
    // D-07 (Plan 07-06): await the all-cards gate opening (the version card is
    // loaded-grid content) before asserting the arrow.
    const arrow = await screen.findByTestId("overview-protocol-update-arrow");
    expect(arrow).toBeInTheDocument();
    expect(arrow).toHaveAttribute("aria-label", i18n.t("server.service.protocol.update_available_badge"));
  });

  it("both in-panel indicators RESET (disappear) when the update flips off (version-change reset path)", async () => {
    // First render with update available — both present (await the gated arrow).
    const { unmount } = renderPanelChrome(true);
    expect(screen.getByTestId("service-tab-update-dot")).toBeInTheDocument();
    expect(await screen.findByTestId("overview-protocol-update-arrow")).toBeInTheDocument();
    unmount();

    // Re-render with the flag flipped false (mirrors an in-session upgrade-to-latest
    // where localSidecarAvailable derives back to false). The «Сервис» dot is
    // prop-driven (gone immediately); the arrow is loaded-grid content, so wait
    // for the gate to open and confirm it is absent once the grid renders.
    renderPanelChrome(false);
    expect(screen.queryByTestId("service-tab-update-dot")).not.toBeInTheDocument();
    await waitFor(() => {
      // The IP card's eye toggle marks the loaded grid; once present, the version
      // card has rendered and the arrow must be absent (sidecarAvailable=false).
      expect(screen.getByRole("button", { name: i18n.t("server.overview.ip.show") })).toBeInTheDocument();
    });
    expect(screen.queryByTestId("overview-protocol-update-arrow")).not.toBeInTheDocument();
  });
});
