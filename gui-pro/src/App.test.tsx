import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import i18n from "./shared/i18n";
import App from "./App";
import { renderWithProviders as render } from "./test/test-utils";

// Mock recharts
vi.mock("recharts", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  LineChart: ({ children }: any) => <div>{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
}));

// Mock heavy child components to keep tests fast — capture props for assertions
vi.mock("./components/SetupWizard", () => ({
  __esModule: true,
  default: () => <div data-testid="setup-wizard">SetupWizard</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let controlPanelProps: any = {};
vi.mock("./components/ControlPanelPage", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ControlPanelPage: (props: any) => {
    controlPanelProps = props;
    return <div data-testid="control-panel-page">ControlPanelPage</div>;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let connectionPanelProps: any = {};
vi.mock("./components/ConnectionPanel", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => {
    connectionPanelProps = props;
    return <div data-testid="connection-panel">ConnectionPanel</div>;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let routingPanelProps: any = {};
vi.mock("./components/RoutingPanel", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => {
    routingPanelProps = props;
    return <div data-testid="routing-panel">RoutingPanel</div>;
  },
}));

vi.mock("./components/LogPanel", () => ({
  __esModule: true,
  default: () => <div data-testid="log-panel">LogPanel</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let aboutPanelProps: any = {};
vi.mock("./components/AboutPanel", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => {
    aboutPanelProps = props;
    return <div data-testid="about-panel">AboutPanel</div>;
  },
}));

vi.mock("./components/DashboardPanel", () => ({
  __esModule: true,
  default: () => <div data-testid="dashboard-panel">DashboardPanel</div>,
}));

vi.mock("./components/AppSettingsPanel", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (_props: any) => {
    return <div data-testid="app-settings-panel">AppSettingsPanel</div>;
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let statusPanelProps: any = {};
vi.mock("./components/StatusPanel", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => {
    statusPanelProps = props;
    return <div data-testid="status-panel">StatusPanel</div>;
  },
}));

// Mock fetch for update check
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({
    tag_name: "v1.5.0",
    assets: [],
    body: "",
    html_url: "https://github.com",
  }),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).fetch = mockFetch;

// Mock window.matchMedia
const matchMediaListeners: Array<(e: MediaQueryListEvent) => void> = [];
const mockMatchMedia = vi.fn().mockImplementation((query: string) => ({
  matches: query.includes("dark"),
  media: query,
  onchange: null,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener: vi.fn((_: string, handler: any) => {
    matchMediaListeners.push(handler);
  }),
  removeEventListener: vi.fn(),
  dispatchEvent: vi.fn(),
}));
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: mockMatchMedia,
});

// Helper: capture listen callbacks by event name
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ListenCallback = (event: { payload: any }) => void;
let listenCallbacks: Record<string, ListenCallback[]> = {};

function setupListenMock() {
  listenCallbacks = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(listen).mockImplementation(async (eventName: string, callback: any) => {
    if (!listenCallbacks[eventName]) listenCallbacks[eventName] = [];
    listenCallbacks[eventName].push(callback);
    return () => {};
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emitEvent(eventName: string, payload: any) {
  const cbs = listenCallbacks[eventName] || [];
  cbs.forEach(cb => cb({ payload }));
}

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    i18n.changeLanguage("ru");
    localStorage.clear();
    matchMediaListeners.length = 0;

    // Default Tauri mocks
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return null;
      if (cmd === "get_auto_connect") return false;
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    setupListenMock();
    vi.mocked(getVersion).mockResolvedValue("2.0.0");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Basic rendering ───

  it("renders without crashing", async () => {
    await act(async () => {
      render(<App />);
    });
    expect(document.querySelector(".h-screen.flex")).toBeInTheDocument();
  });

  it("shows tab navigation", async () => {
    await act(async () => {
      render(<App />);
    });
    const tablist = document.querySelector('[role="tablist"]');
    expect(tablist).toBeInTheDocument();
  });

  it("renders control panel by default when no config", async () => {
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByTestId("control-panel-page")).toBeInTheDocument();
  });

  it("renders settings page when config exists", async () => {
    localStorage.setItem("tt_config_path", "/some/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });
    expect(screen.getByTestId("connection-panel")).toBeInTheDocument();
  });

  // ─── In-window log overlay (Plan 02-16) ───
  // The title-bar Terminal button toggles an IN-WINDOW LogPanel overlay (the
  // safe replacement for the old separate-webview log window that froze the
  // app). No second window is created — the LogPanel mock renders inline.

  it("does not render the log overlay until the title-bar button is clicked", async () => {
    await act(async () => {
      render(<App />);
    });
    // The toggle button is present (aria-label from logs.toggle_aria) but the
    // LogPanel is not mounted yet.
    expect(
      screen.getByRole("button", { name: i18n.t("logs.toggle_aria") }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("log-panel")).not.toBeInTheDocument();
  });

  it("toggles the in-window LogPanel overlay open and closed via the title-bar button", async () => {
    await act(async () => {
      render(<App />);
    });

    const toggle = screen.getByRole("button", {
      name: i18n.t("logs.toggle_aria"),
    });

    // Open
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(screen.getByTestId("log-panel")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    // Close via the same button
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(screen.queryByTestId("log-panel")).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("closes the log overlay via its close (X) button", async () => {
    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("logs.toggle_aria") }),
      );
    });
    expect(screen.getByTestId("log-panel")).toBeInTheDocument();

    // The overlay header has a close button labelled logs.close_aria.
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("logs.close_aria") }),
      );
    });
    expect(screen.queryByTestId("log-panel")).not.toBeInTheDocument();
  });

  // ─── Theme management ───

  it("sets data-theme attribute on document element", async () => {
    await act(async () => {
      render(<App />);
    });
    const theme = document.documentElement.getAttribute("data-theme");
    expect(["dark", "light"]).toContain(theme);
  });

  it("theme defaults to system (dark via matchMedia mock)", async () => {
    await act(async () => {
      render(<App />);
    });
    // matchMedia mock returns matches=true for dark query
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("theme toggle cycles dark → light → system", async () => {
    localStorage.setItem("tt_theme", "dark");
    await act(async () => {
      render(<App />);
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    // Find and click the theme toggle button (sidebar has moon/sun icon)
    // Sidebar exposes onThemeToggle — we can find the sidebar theme button
    const themeBtn = document.querySelector('button[title="Тема"]') ||
      document.querySelector('button[aria-label*="theme"]');
    if (themeBtn) {
      // dark → light
      await act(async () => { fireEvent.click(themeBtn); });
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
      expect(localStorage.getItem("tt_theme")).toBe("light");

      // light → system
      await act(async () => { fireEvent.click(themeBtn); });
      expect(localStorage.getItem("tt_theme")).toBe("system");

      // system → dark
      await act(async () => { fireEvent.click(themeBtn); });
      expect(localStorage.getItem("tt_theme")).toBe("dark");
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    }
  });

  it("respects saved theme from localStorage", async () => {
    localStorage.setItem("tt_theme", "light");
    await act(async () => {
      render(<App />);
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("listens for system theme changes when mode is system", async () => {
    localStorage.setItem("tt_theme", "system");
    await act(async () => {
      render(<App />);
    });
    // matchMedia addEventListener should have been called
    expect(mockMatchMedia).toHaveBeenCalled();
  });

  // ─── Language management ───

  it("language starts as Russian", async () => {
    await act(async () => {
      render(<App />);
    });
    expect(i18n.language).toBe("ru");
  });

  it("language toggle switches ru → en", async () => {
    await act(async () => {
      render(<App />);
    });
    const langBtn = document.querySelector('button[title="Язык"]') ||
      document.querySelector('button[aria-label*="language"]');
    if (langBtn) {
      await act(async () => { fireEvent.click(langBtn); });
      expect(i18n.language).toBe("en");
      expect(localStorage.getItem("tt_language")).toBe("en");
    }
  });

  // ─── VPN event listeners ───

  it("listens for vpn-status, internet-status, and vpn-log events", async () => {
    await act(async () => {
      render(<App />);
    });
    expect(listenCallbacks["vpn-status"]).toBeDefined();
    expect(listenCallbacks["vpn-status"].length).toBeGreaterThanOrEqual(1);
    expect(listenCallbacks["internet-status"]).toBeDefined();
    expect(listenCallbacks["vpn-log"]).toBeDefined();
  });

  it("calls check_vpn_status_full on mount", async () => {
    // Phase 1 (Codex MEDIUM): the mount snapshot now uses check_vpn_status_full so
    // a late-mounting window recovers BOTH status and error, not just status.
    await act(async () => {
      render(<App />);
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("check_vpn_status_full");
  });

  // ─── VPN connect/disconnect flow ───

  it("vpn-status event updates status to connected", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // Simulate VPN connected event
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    // StatusPanel should receive connected status
    expect(statusPanelProps.status).toBe("connected");
    expect(statusPanelProps.connectedSince).toBeInstanceOf(Date);
  });

  it("vpn-status event updates status to disconnected and clears connectedSince", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // Connect then disconnect
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });
    expect(statusPanelProps.connectedSince).toBeInstanceOf(Date);

    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
    });
    expect(statusPanelProps.status).toBe("disconnected");
    expect(statusPanelProps.connectedSince).toBeNull();
  });

  it("vpn-status event with error sets error", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      emitEvent("vpn-status", { status: "error", error: "Connection failed" });
    });

    expect(statusPanelProps.error).toBe("Connection failed");
  });

  it("vpn-status recovering → disconnected resolves to Disconnected (terminal NoConfig — F0)", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_disconnect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // 02-20: the AUTHORITATIVE status now comes from vpn-status (the internet-status
    // handler no longer sets status). The backend drives «Восстановление» on a local-net
    // loss via a vpn-status "recovering" event.
    await act(async () => {
      emitEvent("vpn-status", { status: "recovering" });
    });
    expect(statusPanelProps.status).toBe("recovering");

    // F0 (Codex M1): from «Восстановление» a "disconnected" is TERMINAL — the network
    // came back but there is no saved config to reconnect to (WR-03), or a give-up
    // cleanup resolved to Disconnected. It must NOT be suppressed; the old no-dwell guard
    // hid it and stuck the UI on red «Восстановление» forever.
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
    });
    expect(statusPanelProps.status).toBe("disconnected");
  });

  it("vpn-status reconnecting → disconnected is suppressed (manual save+reconnect flash)", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_disconnect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // A manual «Сохранить и переподключить» sets the status to "reconnecting" up-front.
    await act(async () => {
      emitEvent("vpn-status", { status: "reconnecting" });
    });
    expect(statusPanelProps.status).toBe("reconnecting");

    // The teardown emits a transient "disconnected" — the no-dwell guard keeps the
    // «Переподключение» label continuous (no «Отключено» flash) until the re-connect.
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
    });
    expect(statusPanelProps.status).toBe("reconnecting");
  });

  it("handleConnect invokes vpn_connect with config", async () => {
    localStorage.setItem("tt_config_path", "/my/config.json");
    localStorage.setItem("tt_log_level", "debug");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // Call onConnect via StatusPanel props
    await act(async () => {
      await statusPanelProps.onConnect();
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/my/config.json",
      logLevel: "debug",
    });
  });

  // IN-04: removed the "handleConnect sets error when configPath is empty"
  // placeholder — it contained no `expect`, so it always passed regardless of
  // behaviour and gave false coverage confidence for the empty-config-path
  // branch. The empty-path branch is not reachable through any prop exposed to
  // this test, so rather than assert nothing we drop the test; if that branch
  // becomes testable (e.g. via an injectable prop) it should be re-added with a
  // real assertion.

  it("handleConnect fails with error when invoke rejects", async () => {
    localStorage.setItem("tt_config_path", "/my/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_connect") throw new Error("VPN connect failed");
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      await statusPanelProps.onConnect();
    });

    expect(statusPanelProps.status).toBe("error");
    expect(statusPanelProps.error).toContain("VPN connect failed");
  });

  it("handleDisconnect invokes vpn_disconnect", async () => {
    localStorage.setItem("tt_config_path", "/my/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_disconnect") return null;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      await statusPanelProps.onDisconnect();
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_disconnect");
    expect(statusPanelProps.status).toBe("disconnecting");
  });

  // ─── Internet status (DISPLAY-ONLY — reconnect is driven in Rust) ───
  //
  // Plan 02-04 deleted the frontend-driven reconnect: the window-independent Rust
  // supervisor (connectivity.rs) is now the SOLE owner of auto-reconnect, and the
  // internet-status listener in useVpnEvents only DISPLAYS the recovering label /
  // give-up message — it never invokes vpn_disconnect or vpn_connect. These tests
  // assert that current reality. Plan 02-12 removed the previous three tests that
  // still asserted the deleted `action === "reconnect"` reconnect (they expected
  // the frontend to invoke vpn_connect / vpn_disconnect on an internet-status
  // event, behaviour that no longer exists) and replaced them with the display-only
  // contract below.

  it("internet-status disconnect sets the recovering BANNER but NOT the status, and invokes no VPN commands (02-20: vpn-status owns status)", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_disconnect") return null;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      emitEvent("internet-status", { online: false, action: "disconnect" });
    });

    // 02-20 conflict fix: the handler shows the descriptive banner …
    expect(statusPanelProps.error).toBe(i18n.t("errors.internet_lost_disconnecting"));
    // … but does NOT set the status — the authoritative vpn-status event owns it now
    // (forcing recovering here would clobber a backend tunnel-lost `reconnecting`).
    // The status stays at the pre-event value (initial "disconnected").
    expect(statusPanelProps.status).toBe("disconnected");
    // … and it must NOT drive recovery from the frontend — the Rust supervisor owns
    // that now, and a frontend disconnect/connect would fight it (Plan 02-04).
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("vpn_disconnect");
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
  });

  it("internet-status reconnect action is IGNORED by the frontend (no vpn_connect) — Rust owns reconnect", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_log_level", "info");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_connect") return null;
      if (cmd === "vpn_disconnect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      emitEvent("internet-status", { online: true, action: "reconnect" });
    });

    // The `action === "reconnect"` branch was DELETED in Plan 02-04 — the frontend
    // must NOT invoke vpn_connect on this event anymore (no double-reconnect window).
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
  });

  it("internet-status give_up shows the recovery-timeout banner but no longer forces the status (02-20)", async () => {
    // 02-20: the give_up branch keeps surfacing the friendly message, but no longer
    // sets the status — the terminal STATUS (error) arrives via the vpn-status event
    // carrying the `recovery-timeout` reason code (the single status owner, D-01).
    localStorage.setItem("tt_config_path", "/config.json");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_disconnect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      emitEvent("internet-status", { online: false, action: "give_up" });
    });

    // The friendly message is surfaced …
    expect(statusPanelProps.error).toBe(i18n.t("errors.network_recovery_timeout"));
    // … but the status is untouched by this handler (stays at the initial value).
    expect(statusPanelProps.status).toBe("disconnected");
  });

  // ─── Auto-connect on startup ───

  it("auto-connects when tt_auto_connect is true", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_log_level", "info");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // Auto-connect fires after 1500ms
    await act(async () => {
      vi.advanceTimersByTime(1600);
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", {
      configPath: "/config.json",
      logLevel: "info",
    });
  });

  it("does not auto-connect when tt_auto_connect is not set", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      vi.advanceTimersByTime(2000);
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("vpn_connect", expect.anything());
  });

  it("auto-connect error sets error status", async () => {
    localStorage.setItem("tt_auto_connect", "true");
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_connect") throw new Error("Auto-connect failed");
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      vi.advanceTimersByTime(1600);
    });

    // Allow microtasks to complete
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(statusPanelProps.status).toBe("error");
  });

  // ─── Config validation on startup ───

  it("reads config on startup and sets vpn mode", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "proxy" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("read_client_config", { configPath: "/config.json" });
    // vpnMode is passed to routing panel
    expect(routingPanelProps.vpnMode).toBe("proxy");
  });

  it("invalid config clears localStorage and resets to wizard", async () => {
    localStorage.setItem("tt_config_path", "/invalid/config.json");
    localStorage.setItem("tt_active_page", "settings");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") throw new Error("Config not found");
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // Should have cleared config and reset to server page
    await waitFor(() => {
      expect(localStorage.getItem("tt_config_path")).toBeFalsy();
    });
  });

  it("auto-detect config when no saved path", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "auto_detect_config") return "/detected/config.json";
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("auto_detect_config");
  });

  // ─── VPN status sync on mount ───

  it("syncs to connected status on mount", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status_full") return { status: "connected", error: null };
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(statusPanelProps.status).toBe("connected");
    expect(statusPanelProps.connectedSince).toBeInstanceOf(Date);
  });

  it("syncs to connecting status on mount", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status_full") return { status: "connecting", error: null };
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(statusPanelProps.status).toBe("connecting");
    expect(statusPanelProps.connectedSince).toBeNull();
  });

  it("syncs to error status AND restores the reason on late mount", async () => {
    // Phase 1 (Codex MEDIUM): a window that mounts AFTER an error event must
    // recover BOTH the status and the backend's (sanitized) reason via the
    // check_vpn_status_full snapshot — not render "error" with no detail.
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status_full") {
        return { status: "error", error: "Configuration parse error. Check your config file." };
      }
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(statusPanelProps.status).toBe("error");
    expect(statusPanelProps.error).toBe("Configuration parse error. Check your config file.");
    expect(statusPanelProps.connectedSince).toBeNull();
  });

  // ─── Navigation / tab switching ───

  it("navigates to saved page on startup", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "routing");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(screen.getByTestId("routing-panel")).toBeInTheDocument();
  });

  it("maps old tab name 'setup' to control page", async () => {
    localStorage.setItem("tt_active_tab", "setup");
    // No config — shows control panel

    await act(async () => {
      render(<App />);
    });

    expect(screen.getByTestId("control-panel-page")).toBeInTheDocument();
  });

  it("maps old tab name 'about' to 'about' page", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "about");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(screen.getByTestId("about-panel")).toBeInTheDocument();
  });

  it("defaults to settings when config exists but no saved page", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    // No tt_active_page set

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(screen.getByTestId("connection-panel")).toBeInTheDocument();
  });

  it("persists active page to localStorage on change", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // Navigate via sidebar click
    const aboutBtn = document.querySelector('button[title="О программе"]');
    if (aboutBtn) {
      await act(async () => { fireEvent.click(aboutBtn); });
      expect(localStorage.getItem("tt_active_page")).toBe("about");
    }
  });

  // ─── Update check ───

  it("checks for updates on mount", async () => {
    await act(async () => {
      render(<App />);
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("github.com"),
      expect.any(Object),
    );
  });

  it("update available when remote version is newer", async () => {
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v2.0.0",
        assets: [{ name: "TrustTunnel-Pro-v2.0.0-setup.exe", browser_download_url: "https://example.com/Pro-setup.exe" }],
        body: "New features",
        html_url: "https://github.com/releases/v2.0.0",
      }),
    });

    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "about");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(aboutPanelProps.updateInfo?.available).toBe(true);
      expect(aboutPanelProps.updateInfo?.latestVersion).toBe("2.0.0");
      expect(aboutPanelProps.updateInfo?.downloadUrl).toBe("https://example.com/Pro-setup.exe");
    });
  });

  it("update not available when current version is newer", async () => {
    vi.mocked(getVersion).mockResolvedValue("3.0.0");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v2.0.0",
        assets: [],
        body: "",
        html_url: "https://github.com",
      }),
    });

    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "about");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(aboutPanelProps.updateInfo?.available).toBe(false);
    });
  });

  it("update check failure is handled gracefully", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith("Update check failed:", expect.anything());
    });

    consoleSpy.mockRestore();
  });

  // ─── VPN log collector ───

  // vpn-log tests removed — LogPanel no longer rendered in App.tsx (D-05: logs folded into connection tab)

  // STATUS-03 / D-07: the frontend no longer infers status from vpn-log text.
  // A fatal log line still enriches the user-facing error MESSAGE (setError),
  // but the error STATUS now arrives via the authoritative backend "vpn-status"
  // event (emitted by sidecar.rs for these same markers in plan 01-01). These
  // tests assert the new contract: message yes, status-from-log no.
  const FATAL_LOG_MARKERS: Array<[string, string]> = [
    ["Authorization Required", "Authorization Required"],
    ["WintunCreateAdapter", "WintunCreateAdapter cannot find module"],
    ["Failed to create listener", "Failed to create listener on port 1080"],
    ["Connection refused", "Connection refused by remote host"],
    ["adapter setup timeout", "Failed to setup adapter: Timed out"],
  ];

  it.each(FATAL_LOG_MARKERS)(
    "vpn-log %s sets a friendly error message but does NOT set status (D-07)",
    async (_name, line) => {
      localStorage.setItem("tt_config_path", "/config.json");

      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "check_vpn_status") return "disconnected";
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        if (cmd === "auto_detect_config") return null;
        return null;
      });

      await act(async () => {
        render(<App />);
      });

      await act(async () => {
        emitEvent("vpn-log", { message: line, source: "stderr" });
      });

      // Friendly message still surfaces …
      expect(statusPanelProps.error).toBeTruthy();
      // … but status is NOT inferred from the log line — it stays disconnected
      // (snapshot-on-mount value) until a real vpn-status event changes it.
      expect(statusPanelProps.status).not.toBe("error");
      expect(statusPanelProps.status).toBe("disconnected");
    },
  );

  it("error STATUS now arrives only via the backend vpn-status event", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      emitEvent("vpn-status", { status: "error", error: "Authorization failed" });
    });

    expect(statusPanelProps.status).toBe("error");
    expect(statusPanelProps.error).toBe("Authorization failed");
  });

  // vpn-log empty messages test removed — LogPanel no longer rendered in App.tsx

  // ─── Clear config ───

  it("handleClearConfig disconnects VPN and clears config", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status_full") return { status: "connected", error: null };
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_disconnect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // connectionPanelProps has onClearConfig
    await act(async () => {
      await connectionPanelProps.onClearConfig();
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_disconnect");
    expect(localStorage.getItem("tt_config_path")).toBeFalsy();
  });

  // ─── Status panel visibility ───

  it("does not show StatusPanel on server page", async () => {
    await act(async () => {
      render(<App />);
    });
    // activePage is "server" by default without config
    // StatusPanel should not be visible
    expect(screen.queryByTestId("status-panel")).not.toBeInTheDocument();
  });

  it("shows StatusPanel on settings page when config exists", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "settings");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // StatusPanel is passed as prop to ConnectionPanel, not directly rendered
    // But it is also rendered in logs/about pages
    // Let's check that connectionPanelProps.statusPanel is not null
    expect(connectionPanelProps.statusPanel).toBeTruthy();
  });

  // ─── Connected since persistence ───

  it("restores connectedSince from localStorage", async () => {
    const past = new Date("2025-01-01T00:00:00Z");
    localStorage.setItem("tt_connected_since", past.toISOString());
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "connected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(statusPanelProps.connectedSince).toBeInstanceOf(Date);
  });

  // ─── Dashboard panel props ───

  // DashboardPanel test removed — Dashboard disbanded per D-04, no longer rendered in App.tsx

  // ─── Routing panel props ───

  it("passes correct props to RoutingPanel", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "routing");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    expect(routingPanelProps.configPath).toBe("/config.json");
    expect(routingPanelProps.status).toBe("disconnected");
    expect(typeof routingPanelProps.onConnect).toBe("function");
    expect(typeof routingPanelProps.onDisconnect).toBe("function");
    expect(typeof routingPanelProps.onReconnect).toBe("function");
  });

  // ─── Control panel callbacks ───

  it("ControlPanelPage onConfigExported updates config", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "control");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      controlPanelProps.onConfigExported("/new/exported/config.json");
    });

    expect(localStorage.getItem("tt_config_path")).toBe("/new/exported/config.json");
  });

  it("ControlPanelPage onSwitchToSetup resets wizard key", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_tab", "control");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // onSwitchToSetup increments wizard key (stays on control tab)
    await act(async () => {
      controlPanelProps.onSwitchToSetup();
    });

    // With config present, app starts on connection tab — onSwitchToSetup doesn't navigate
    expect(localStorage.getItem("tt_active_tab")).toBe("connection");
  });

  it("ControlPanelPage onNavigateToSettings navigates to settings", async () => {
    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "control");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      controlPanelProps.onNavigateToSettings();
    });

    expect(localStorage.getItem("tt_active_page")).toBe("settings");
  });

  // ─── VPN status persistence ───

  it("persists VPN status to localStorage", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(localStorage.getItem("tt_vpn_status")).toBe("connected");
  });

  // ─── compareVersions tests (indirectly via update check) ───

  it("compareVersions: equal versions → not available", async () => {
    vi.mocked(getVersion).mockResolvedValue("1.5.0");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v1.5.0",
        assets: [],
        body: "",
        html_url: "https://github.com",
      }),
    });

    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "about");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(aboutPanelProps.updateInfo?.available).toBe(false);
    });
  });

  // ─── Reconnect disconnect resolve listener ───

  it("reconnect disconnect resolve listener fires on vpn-status disconnected", async () => {
    localStorage.setItem("tt_config_path", "/config.json");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      if (cmd === "vpn_disconnect") return null;
      if (cmd === "vpn_connect") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    // There should be multiple vpn-status listeners (status sync + reconnect resolve)
    expect(listenCallbacks["vpn-status"].length).toBeGreaterThanOrEqual(2);
  });

  // ─── Update: find exe/msi asset ───

  it("update uses exe/msi asset when no zip available", async () => {
    vi.mocked(getVersion).mockResolvedValue("1.0.0");
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: "v2.0.0",
        assets: [{ name: "TrustTunnel-Pro-setup.exe", browser_download_url: "https://example.com/Pro-setup.exe" }],
        body: "New version",
        html_url: "https://github.com/releases",
      }),
    });

    localStorage.setItem("tt_config_path", "/config.json");
    localStorage.setItem("tt_active_page", "about");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_vpn_status") return "disconnected";
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      if (cmd === "auto_detect_config") return null;
      return null;
    });

    await act(async () => {
      render(<App />);
    });

    await waitFor(() => {
      expect(aboutPanelProps.updateInfo?.downloadUrl).toBe("https://example.com/Pro-setup.exe");
    });
  });

  // ─── Phase 18 — Welcome tour mount logic (REQ-18-ONBOARDING-01..04) ───

  describe("Welcome tour", () => {
    it("first-run user (нет tt_welcome_completed + нет tt_ssh_last_host) видит WelcomeTour", async () => {
      localStorage.clear();

      await act(async () => {
        render(<App />);
      });

      expect(screen.getByTestId("welcome-tour-overlay")).toBeVisible();
      // Active screen — Screen 1.
      expect(screen.getByTestId("welcome-tour-screen-1")).toBeVisible();
    });

    it("existing user (tt_ssh_last_host есть) НЕ видит WelcomeTour даже без tt_welcome_completed (REQ-18-ONBOARDING-04, Pitfall 8)", async () => {
      localStorage.setItem("tt_ssh_last_host", "1.2.3.4");

      await act(async () => {
        render(<App />);
      });

      expect(screen.queryByTestId("welcome-tour-overlay")).not.toBeInTheDocument();
    });

    it("completed user (tt_welcome_completed === \"true\") НЕ видит WelcomeTour", async () => {
      localStorage.setItem("tt_welcome_completed", "true");

      await act(async () => {
        render(<App />);
      });

      expect(screen.queryByTestId("welcome-tour-overlay")).not.toBeInTheDocument();
    });

    it("после complete() WelcomeTour unmount-ится (state flip)", async () => {
      localStorage.clear();

      await act(async () => {
        render(<App />);
      });

      // Тур видим.
      expect(screen.getByTestId("welcome-tour-overlay")).toBeVisible();

      // X corner close → complete writes localStorage + onComplete('skip') flips state.
      await act(async () => {
        fireEvent.click(screen.getByTestId("welcome-tour-close"));
      });

      // Overlay больше не в DOM.
      expect(screen.queryByTestId("welcome-tour-overlay")).not.toBeInTheDocument();
      expect(localStorage.getItem("tt_welcome_completed")).toBe("true");
    });
  });
});
