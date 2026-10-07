import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
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

// The status panel's «Подключить» is one of the window's connect initiators (it calls
// `handleConnectActive`), so the double exposes it as a button instead of swallowing the props.
vi.mock("./components/StatusPanel", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => (
    <div data-testid="status-panel">
      StatusPanel
      <button type="button" data-testid="status-panel-connect" onClick={() => void props.onConnect?.()}>
        connect
      </button>
    </div>
  ),
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

// G-03.1-5: the REAL spelling pair. Rust's tray door announces the canonical Windows
// extended-length form of the path while `list_configs` (and the card) hold the plain one.
// The synthetic CFG_A/CFG_B above share one string for both sides, which is why the
// mismatch stayed green; these two never do.
const WIN_A = "C:\\cfg\\a.toml";
const WIN_B = "C:\\cfg\\b.toml";
const WIN_B_VERBATIM = "\\\\?\\C:\\cfg\\b.toml";

function windowsSpelledInvoke() {
  return async (cmd: string) => {
    if (cmd === "read_client_config") return { vpn_mode: "general" };
    if (cmd === "auto_detect_config") return null;
    if (cmd === "get_auto_connect") return false;
    if (cmd === "list_configs")
      return [
        { id: "id-a", name: "A", host: "a.example.com", user: "u", path: WIN_A, order: 0, last_used: true },
        { id: "id-b", name: "B", host: "b.example.com", user: "u", path: WIN_B, order: 1, last_used: false },
      ];
    if (cmd === "ping_config_endpoint") return { status: "ok", ms: 30 };
    return null;
  };
}

/** Mount App with the Windows-spelled manifest; `pointer` is the stored tt_config_path. */
async function mountWindowsSpelled(pointer: string) {
  localStorage.setItem("tt_config_path", pointer);
  localStorage.setItem("tt_log_level", "info");
  vi.mocked(invoke).mockImplementation(windowsSpelledInvoke());
  await act(async () => {
    render(<App />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  refreshCalls.count = 0;
}

/**
 * Mount App with the two-config manifest (marker on A) and `pointer` as the active config.
 * The launch auto-connect is switched OFF unless a test asks for it: it would otherwise arm a
 * pending stamp 1.5 s after mount and make every other test in the file timing-dependent.
 */
async function mountWithPointer(pointer: string, opts: { autoConnect?: boolean } = {}) {
  localStorage.setItem("tt_config_path", pointer);
  localStorage.setItem("tt_log_level", "info");
  localStorage.setItem("tt_auto_connect", opts.autoConnect ? "true" : "false");
  vi.mocked(invoke).mockImplementation(twoConfigInvoke());
  await act(async () => {
    render(<App />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  refreshCalls.count = 0;
}

/** Mount App with the two-config manifest and A as the active pointer. */
async function mountWithActiveA() {
  await mountWithPointer(CFG_A);
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

  // WR-02 (03.1 review): the tray announces the connect BEFORE routing, spawn and handshake, so
  // the announcement is not proof that the server works. The window's own switch rule
  // (performSwitch) stamps «last used» only on the terminal `connected` edge — a failed connect
  // must not move the manifest marker, which drives the list order and the tray's choice after a
  // relaunch (the launch auto-connect follows the app-level pointer when one is set and usable,
  // so the marker does not govern it in that case). A tray connect follows the same rule; only
  // the failover origin (its candidate has already connected) stamps at once.

  it("WR-02: a TRAY connect does not stamp «last used» on the announcement", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "tray", configPath: CFG_B });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", expect.anything());
  });

  it("WR-02: a TRAY connect stamps «last used» once the terminal `connected` edge arrives", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "tray", configPath: CFG_B });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    // Only an id crosses (D-29); B is marked, never the abandoned A.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "id-b" });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-a" });
  });

  it("WR-02: a TRAY connect that ends in `error` leaves the previous marker untouched", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "tray", configPath: CFG_B });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "error", error: "connect-timeout" });
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", expect.anything());
  });

  it("WR-02: a failed tray connect is forgotten — a LATER connect of another config never stamps the dead one", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "tray", configPath: CFG_B });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "error", error: "connect-timeout" });
    });
    // A later, unrelated connect reaches `connected` (a reconnect, a window connect …).
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-b" });
  });

  it("WR-02: a tray connect cancelled back to `disconnected` never stamps", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "tray", configPath: CFG_B });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", expect.anything());
  });

  it("WR-02: a tray disconnect announcement drops the pending stamp", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "tray", configPath: CFG_B });
    });
    await act(async () => {
      emitEvent("vpn-flow", { action: "disconnect", origin: "tray" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", expect.anything());
  });

  // The `samePath(pending, active)` guard in the status effect is the only thing that stops a
  // pending stamp from marking a config the window has since left. Every test above announces a
  // tray connect, which itself moves the active pointer to that path, so the guard is always
  // true there; this one moves the pointer away before `connected` and fails if the guard goes.
  it("WR-02: a pending tray stamp is dropped when the window has moved to another config before `connected`", async () => {
    await mountWithActiveA();

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "tray", configPath: CFG_B });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    // A failover announcement adopts A: the active pointer leaves B while B's stamp is pending.
    // The failover origin stamps its own candidate at once, without touching B's pending stamp.
    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "failover", configPath: CFG_A });
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "id-a" });

    vi.mocked(invoke).mockClear();
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    // A is the active config at `connected`, so B, which did not become the live server, is
    // never marked.
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-b" });
  });

  // WR-02 (second round): the same rule for a FRESH connect started from the window (a card's
  // «Подключить» with no live tunnel). `vpn_connect` accepting the spawn proves nothing about the
  // server, so the window must not stamp «last used» there either: a failed connect would move the
  // manifest marker (list order, the tray's choice after a relaunch). It stamps on the terminal
  // `connected` edge through the same pending-stamp mechanism the tray connect uses. The launch
  // auto-connect follows the app-level pointer when one is set and usable (WR-05), so this edge-only
  // stamp does not decide it in that case.

  it("WR-02: a fresh window connect does not stamp «last used» when vpn_connect is accepted", async () => {
    await mountWithActiveA();

    await act(async () => {
      await connectionPanelProps.onSwitchTo(CFG_B);
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", expect.objectContaining({ configPath: CFG_B }));
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", expect.anything());
  });

  it("WR-02: a fresh window connect stamps «last used» once the terminal `connected` edge arrives", async () => {
    await mountWithActiveA();

    await act(async () => {
      await connectionPanelProps.onSwitchTo(CFG_B);
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "id-b" });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-a" });
  });

  it("WR-02: a fresh window connect stamps once, not again on a later reconnect", async () => {
    await mountWithActiveA();

    await act(async () => {
      await connectionPanelProps.onSwitchTo(CFG_B);
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });
    vi.mocked(invoke).mockClear();
    await act(async () => {
      emitEvent("vpn-status", { status: "reconnecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", expect.anything());
  });

  it("WR-02: a fresh window connect that ends in `error` leaves the previous marker untouched", async () => {
    await mountWithActiveA();

    await act(async () => {
      await connectionPanelProps.onSwitchTo(CFG_B);
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "error", error: "connect-timeout" });
    });
    // A later, unrelated connect reaches `connected`: the dead B must not be stamped by it.
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-b" });
  });

  it("WR-02: a fresh window connect whose spawn is refused never stamps, not even at a later `connected`", async () => {
    await mountWithActiveA();
    const base = twoConfigInvoke();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "vpn_connect") throw new Error("connect failed");
      return base(cmd);
    });

    await act(async () => {
      await connectionPanelProps.onSwitchTo(CFG_B);
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-b" });
  });

  // IN-02 (03.1): the explicit clear after a refused spawn is what covers the case where the batch
  // produces NO status edge. Starting from `disconnected`, the refused test above sees the
  // `disconnected` → `error` edge and the status effect clears the stamp on its own, so it would pass
  // without the explicit clear. Starting from `error` the refused connect goes `error` → `connecting`
  // → `error` inside one batch: no edge, the effect never runs, and only the explicit clear stops the
  // stamp from lingering until a later `connected`.
  it("IN-02: a refused spawn from `error` (no status edge) never stamps, not even at a later `connected`", async () => {
    await mountWithActiveA();
    await act(async () => {
      emitEvent("vpn-status", { status: "error", error: "connect-timeout" });
    });
    const base = twoConfigInvoke();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "vpn_connect") throw new Error("connect failed");
      return base(cmd);
    });

    await act(async () => {
      await connectionPanelProps.onSwitchTo(CFG_B);
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", expect.objectContaining({ configPath: CFG_B }));
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-b" });
  });

  it("WR-02: a fresh window connect superseded by a disconnect never stamps", async () => {
    await mountWithActiveA();
    const base = twoConfigInvoke();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "vpn_connect") return { spawned: false, reason: "superseded" };
      return base(cmd);
    });

    await act(async () => {
      await connectionPanelProps.onSwitchTo(CFG_B);
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-b" });
  });

  // WR-01 (03.1 round 3): ONE rule for every path in the window that starts a connect of config X:
  // arm `pendingLastUsedStampRef` with X and let the status effect settle it. The card's fresh
  // connect is covered above; these pin the rest — the status panel's «Подключить», Ctrl+Shift+C
  // (the same handler), save-and-reconnect, and the launch auto-connect.
  //
  // They start from the state a failed card connect leaves behind: the active pointer is B and
  // the manifest marker is still A. Before the fix none of these paths ever moved the marker, so
  // B stayed unmarked however many times it connected.

  it("WR-01: a status-panel connect stamps «last used» once `connected` arrives, not on accept", async () => {
    await mountWithPointer(CFG_B);
    // The status panel is mounted on the About tab.
    await act(async () => {
      fireEvent.keyDown(window, { key: "5", ctrlKey: true });
    });

    await act(async () => {
      screen.getByTestId("status-panel-connect").click();
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", expect.objectContaining({ configPath: CFG_B }));
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", expect.anything());

    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "id-b" });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-a" });
  });

  it("WR-01: Ctrl+Shift+C connects the active config through the same rule and stamps it on `connected`", async () => {
    await mountWithPointer(CFG_B);

    await act(async () => {
      fireEvent.keyDown(window, { code: "KeyC", ctrlKey: true, shiftKey: true });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", expect.objectContaining({ configPath: CFG_B }));
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "id-b" });
  });

  it("WR-01: a status-panel connect that ends in `error` leaves the previous marker untouched", async () => {
    await mountWithPointer(CFG_B);
    await act(async () => {
      fireEvent.keyDown(window, { key: "5", ctrlKey: true });
    });

    await act(async () => {
      screen.getByTestId("status-panel-connect").click();
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "error", error: "connect-timeout" });
    });
    // A later, unrelated connect reaches `connected`: the dead B must not be stamped by it.
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-b" });
  });

  // IN-01 (03.1 round 4): the retry «Подключить» after a failure starts from `error`. A rejected
  // `vpn_connect` then goes `error` → `connecting` → `error` inside one batch: no status edge, the
  // status effect never runs, and only an explicit drop in `handleConnect`'s catch stops the armed
  // stamp from lingering until a later `connected`.
  it("IN-01: a status-panel connect refused from `error` (no status edge) never stamps, not even at a later `connected`", async () => {
    await mountWithPointer(CFG_B);
    await act(async () => {
      emitEvent("vpn-status", { status: "error", error: "connect-timeout" });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "5", ctrlKey: true });
    });
    const base = twoConfigInvoke();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "vpn_connect") throw new Error("connect failed");
      return base(cmd);
    });

    await act(async () => {
      screen.getByTestId("status-panel-connect").click();
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", expect.objectContaining({ configPath: CFG_B }));
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-b" });
  });

  // The drop is bound to the config the rejected connect armed. A newer connect that armed another
  // config while the refusal was still in flight (here a tray connect of A) keeps its own stamp. The
  // whole exchange runs in ONE act so the refusal produces no status edge that would settle the
  // stamp on its own: only the drop's path check decides.
  it("IN-01: a refused connect never drops the stamp a newer connect of another config armed", async () => {
    await mountWithPointer(CFG_B);
    await act(async () => {
      emitEvent("vpn-status", { status: "error", error: "connect-timeout" });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "5", ctrlKey: true });
    });
    const base = twoConfigInvoke();
    let rejectConnect: ((e: Error) => void) | null = null;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "vpn_connect") {
        return new Promise((_resolve, reject) => {
          rejectConnect = reject;
        });
      }
      return base(cmd);
    });

    await act(async () => {
      screen.getByTestId("status-panel-connect").click();
      // Let B's connect reach `vpn_connect` (it awaits the ping push first).
      for (let i = 0; i < 50 && !rejectConnect; i += 1) await Promise.resolve();
      expect(rejectConnect).not.toBeNull();
      // While B's connect is still pending, the tray starts a connect of A and the window adopts it.
      emitEvent("vpn-flow", { action: "connect", origin: "tray", configPath: CFG_A });
      rejectConnect!(new Error("connect failed"));
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "id-a" });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-b" });
  });

  it("WR-01: save-and-reconnect stamps the config it reconnected once `connected` arrives", async () => {
    await mountWithPointer(CFG_B);
    // A live tunnel on B: nothing is pending, so reaching `connected` stamps nothing yet.
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", expect.anything());

    let reconnect: Promise<void> | undefined;
    await act(async () => {
      reconnect = connectionPanelProps.onReconnect();
    });
    // The teardown's `disconnected` releases the wait; the reconnect then calls vpn_connect.
    await act(async () => {
      emitEvent("vpn-status", { status: "disconnected" });
    });
    await act(async () => {
      await reconnect;
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", expect.objectContaining({ configPath: CFG_B }));
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", expect.anything());

    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "id-b" });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-a" });
  });

  it("WR-01: the launch auto-connect stamps the config it connected once `connected` arrives", async () => {
    // Pointer B, marker A: the auto-connect follows the pointer (WR-05), so it connects B.
    await mountWithPointer(CFG_B, { autoConnect: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("vpn_connect", expect.objectContaining({ configPath: CFG_B }));
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", expect.anything());

    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "id-b" });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-a" });
  });

  it("WR-01: a launch auto-connect that ends in `error` leaves the previous marker untouched", async () => {
    await mountWithPointer(CFG_B, { autoConnect: true });
    const base = twoConfigInvoke();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "vpn_connect") throw new Error("connect failed");
      return base(cmd);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    // A later, unrelated connect reaches `connected`: the dead B must not be stamped by it.
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-b" });
  });

  it("G-03.1-5: a tray connect announced in the verbatim spelling stamps the card that holds the plain spelling on `connected`", async () => {
    await mountWindowsSpelled(WIN_A);

    await act(async () => {
      emitEvent("vpn-flow", { action: "connect", origin: "tray", configPath: WIN_B_VERBATIM });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connecting" });
    });
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    // The id is resolved from the manifest by path; before the fix the `\\?\` string matched
    // no manifest entry, so the stamp was silently skipped.
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_last_used", { id: "id-b" });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_last_used", { id: "id-a" });
  });

  // ─── G-03.1-5: a pointer 3.0.0 persisted in the verbatim spelling is healed ───
  //
  // 3.0.0's tray door wrote the canonical `\\?\` form into tt_config_path. Comparisons already
  // treat it as the same file; the heal only stops the stale spelling travelling further (into
  // vpn_connect's stored pointer and back out through the tray). It touches ONLY the verbatim
  // spelling — separator/case differences are left as stored, because useAutoConnect passes the
  // app's own spelling to vpn_connect and that behaviour is pinned.

  it("G-03.1-5: rewrites a persisted `\\\\?\\` pointer to the manifest's own spelling once the list loads", async () => {
    await mountWindowsSpelled(WIN_B_VERBATIM);

    expect(connectionPanelProps.activeConfigPath).toBe(WIN_B);
    expect(localStorage.getItem("tt_config_path")).toBe(WIN_B);
  });

  it("G-03.1-5: leaves a pointer without the verbatim prefix byte-for-byte as stored", async () => {
    await mountWindowsSpelled("C:/cfg/b.toml");

    expect(connectionPanelProps.activeConfigPath).toBe("C:/cfg/b.toml");
    expect(localStorage.getItem("tt_config_path")).toBe("C:/cfg/b.toml");
  });

  it("G-03.1-5: leaves a verbatim pointer that matches no listed config as stored", async () => {
    const gone = "\\\\?\\C:\\cfg\\gone.toml";
    await mountWindowsSpelled(gone);

    expect(connectionPanelProps.activeConfigPath).toBe(gone);
    expect(localStorage.getItem("tt_config_path")).toBe(gone);
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
