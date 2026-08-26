import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import i18n from "./shared/i18n";
import App from "./App";
import { renderWithProviders as render } from "./test/test-utils";

// Phase 28 (28-03, OQ-1) — the active-config pointer seam.
//
// WHY A SEPARATE FILE: `App.test.tsx` is 3.7k lines of switch/status-machine coverage; this
// spec is a single narrow contract (which `vpn-flow` origins the window adopts a pointer
// from) and its harness needs nothing that file's fixtures provide. Keeping it apart means a
// failure here names the seam, not "App".
//
// THE CONTRACT: Rust owns the failover walk (28-02) but the ACTIVE-CONFIG POINTER is
// frontend-owned — only `performSwitch` and this listener write it. When the walk recovers on
// a candidate that is not the origin, Rust announces the switch on the `vpn-flow` event the
// tray connect already uses, and the window adopts the pointer from it. Without this, Rust is
// connected to B while every single-config surface (Routing, Settings, the status panel) still
// says A — the exact desync `App.tsx:790-803` documents.

// ─── Heavy children are mocked; only App's own wiring is under test ───

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

vi.mock("./components/SetupWizard", () => ({
  __esModule: true,
  default: () => <div data-testid="setup-wizard">SetupWizard</div>,
}));

vi.mock("./components/ControlPanelPage", () => ({
  ControlPanelPage: () => <div data-testid="control-panel-page">ControlPanelPage</div>,
}));

// The panel's `refresh()` is the third half of the adoption (the hero card must follow the
// pointer), so the double records the calls instead of no-oping them silently.
const refreshCalls = { count: 0 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let connectionPanelProps: any = {};
vi.mock("./components/connection/ConnectionPanel", async () => {
  const React = await import("react");
  return {
    __esModule: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ConnectionPanel: React.forwardRef((props: any, ref: any) => {
      // eslint-disable-next-line react-hooks/globals
      connectionPanelProps = props;
      React.useImperativeHandle(
        ref,
        () => ({ reload: () => {}, refresh: () => { refreshCalls.count += 1; } }),
        [],
      );
      return <div data-testid="connection-panel">ConnectionPanel</div>;
    }),
  };
});

vi.mock("./components/RoutingPanel", () => ({
  __esModule: true,
  default: () => <div data-testid="routing-panel">RoutingPanel</div>,
}));

vi.mock("./components/LogPanel", () => ({
  __esModule: true,
  default: () => <div data-testid="log-panel">LogPanel</div>,
}));

vi.mock("./components/AboutPanel", () => ({
  __esModule: true,
  default: () => <div data-testid="about-panel">AboutPanel</div>,
}));

vi.mock("./components/DashboardPanel", () => ({
  __esModule: true,
  default: () => <div data-testid="dashboard-panel">DashboardPanel</div>,
}));

vi.mock("./components/AppSettingsPanel", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => <div data-testid="app-settings-panel">{props.statusPanel}</div>,
}));

vi.mock("./components/StatusPanel", () => ({
  __esModule: true,
  default: () => <div data-testid="status-panel">StatusPanel</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ tag_name: "v1.5.0", assets: [], body: "", html_url: "https://github.com" }),
});

// ─── Event plumbing: capture the listen callbacks so a test can emit on a channel ───

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ListenCallback = (event: { payload: any }) => void;
let listenCallbacks: Record<string, ListenCallback[]> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function emitEvent(eventName: string, payload: any) {
  (listenCallbacks[eventName] || []).forEach((cb) => cb({ payload }));
}

const CFG_A = "/config-a.toml";
const CFG_B = "/config-b.toml";

function twoConfigInvoke() {
  return async (cmd: string) => {
    if (cmd === "read_client_config") return { vpn_mode: "general" };
    if (cmd === "auto_detect_config") return null;
    if (cmd === "get_auto_connect") return false;
    if (cmd === "list_configs")
      return [
        { id: "id-a", name: "A", host: "a.example.com", user: "u", path: CFG_A, order: 0, last_used: true },
        { id: "id-b", name: "B", host: "b.example.com", user: "u", path: CFG_B, order: 1, last_used: false },
      ];
    if (cmd === "ping_config_endpoint") return { status: "ok", ms: 30 };
    return null;
  };
}

/** Mount App with the two-config manifest and A as the active pointer. */
async function mountWithActiveA() {
  localStorage.setItem("tt_config_path", CFG_A);
  localStorage.setItem("tt_log_level", "info");
  vi.mocked(invoke).mockImplementation(twoConfigInvoke());
  await act(async () => {
    render(<App />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  refreshCalls.count = 0;
}

describe("App — vpn-flow pointer adoption (28-03 / OQ-1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    i18n.changeLanguage("ru");
    localStorage.clear();
    listenCallbacks = {};
    refreshCalls.count = 0;
    connectionPanelProps = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(listen).mockImplementation(async (eventName: string, callback: any) => {
      if (!listenCallbacks[eventName]) listenCallbacks[eventName] = [];
      listenCallbacks[eventName].push(callback);
      return () => {};
    });
    vi.mocked(getVersion).mockResolvedValue("3.0.0");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("adopts the pointer from a failover connect: active config, tt_config_path, and a list refresh", async () => {
    await mountWithActiveA();
    expect(connectionPanelProps.activeConfigPath).toBe(CFG_A);

    // Rust walked the queue and recovered on candidate #2 — it announces the switch on the
    // channel the tray connect already uses, carrying the config PATH only (D-29, no secret).
    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "failover", configPath: CFG_B });
    });

    expect(connectionPanelProps.activeConfigPath).toBe(CFG_B);
    expect(localStorage.getItem("tt_config_path")).toBe(CFG_B);
    expect(refreshCalls.count).toBeGreaterThan(0);
  });

  it("ignores a failover connect that carries no config path", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "failover" });
    });

    // Nothing to adopt → nothing changes. A blanked pointer would unmount the hero card.
    expect(connectionPanelProps.activeConfigPath).toBe(CFG_A);
    expect(localStorage.getItem("tt_config_path")).toBe(CFG_A);
    expect(refreshCalls.count).toBe(0);
  });

  it("still adopts the pointer from a tray connect (the precedent must not regress)", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "tray", configPath: CFG_B });
    });

    expect(connectionPanelProps.activeConfigPath).toBe(CFG_B);
    expect(localStorage.getItem("tt_config_path")).toBe(CFG_B);
  });

  // ─── FB-02: the switch must be announced IN THE WINDOW too (D-04) ───
  //
  // The desktop notification is suppressed by `notify::maybe_fire` whenever the main window is
  // visible and not minimized, on the premise that an in-app surface already reports the
  // transition. For the failover switch that premise was false — the adoption branch pushed
  // nothing — so with the window open the hero card silently changed to a different server, i.e.
  // a different exit country, with no explanation anywhere. These pin the restored premise.

  it("announces a failover switch in the window, naming the server it moved to", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "failover", configPath: CFG_B });
    });

    expect(
      await screen.findByText(i18n.t("messages.auto_switched", { name: "B" })),
    ).toBeInTheDocument();
  });

  it("still announces the switch when the target is not in the list, without inventing a name", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "failover", configPath: "/gone.toml" });
    });

    expect(
      await screen.findByText(i18n.t("messages.auto_switched_unnamed")),
    ).toBeInTheDocument();
  });

  it("does not announce a TRAY connect — the user just did that by hand", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "tray", configPath: CFG_B });
    });

    expect(
      screen.queryByText(i18n.t("messages.auto_switched", { name: "B" })),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(i18n.t("messages.auto_switched_unnamed")),
    ).not.toBeInTheDocument();
  });

  // ─── WR-06: the adopted server must also become the PERSISTED last-used one ───
  //
  // The frontend sibling of blocker CR-01. CR-01 kept the BACKEND's own record of the live
  // config honest; this keeps the MANIFEST honest. The manifest marker is a file, so unlike the
  // in-session pointer it survives a restart — and `useAutoConnect` reads it to decide which
  // server to resume, while `list_configs` sorts `last_used DESC, order ASC`. Left un-moved, a
  // failover A→C leaves the dead A recorded as the last used server: it stays at the top of the
  // list, and a restart whose app-level pointer is unusable resumes A — the server that just
  // died — burning a fresh failover walk to get back to C.
  //
  // These fail on the pre-fix branch: the adoption body never called `markLastUsed`, so
  // `set_last_used` was simply never invoked for either origin.

  it("WR-06: moves the manifest last-used marker to the failover target", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "failover", configPath: CFG_B });
    });

    // The id is resolved from the manifest by path (set_last_used takes the id, not the path).
    // Only an id crosses — no config content, no password (D-29).
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "id-b" });
    // …and it is B that is marked, never the abandoned A.
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-a" });
  });

  it("WR-06: moves the marker for a TRAY connect too — the two origins share one branch", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "tray", configPath: CFG_B });
    });

    // Same branch, same stamp. A tray connect is just as much a "use" of that server, and
    // special-casing one origin here is exactly how the tray and failover paths would drift.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "id-b" });
  });

  it("WR-06: stamps nothing when there is no pointer to adopt", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "failover" });
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", expect.anything());
  });

  it("WR-06: stamps nothing for an unrecognised origin", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "something-else", configPath: CFG_B });
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", expect.anything());
  });

  it("ignores an unrecognised origin", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "something-else", configPath: CFG_B });
    });

    expect(connectionPanelProps.activeConfigPath).toBe(CFG_A);
    expect(localStorage.getItem("tt_config_path")).toBe(CFG_A);
  });
});
