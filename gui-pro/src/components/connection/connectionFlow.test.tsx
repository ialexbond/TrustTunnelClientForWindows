import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import i18n from "../../shared/i18n";
import App from "../../App";
import { renderWithProviders as render } from "../../test/test-utils";
import type { ConfigSummary } from "../../shared/hooks/useConfigList";

// ─── TA-2: the ONE end-to-end connect→disconnect flow test through the REAL wiring ───
//
// Every OTHER connection test proves a single leg in isolation with mocked neighbours:
//   - ConnectionPanel.production.test.tsx mocks onConnect/onSwitchTo/onDisconnect (callback routing);
//   - App.test.tsx proves App.handleConnect→vpn_connect / handleDisconnect→vpn_disconnect, but it
//     MOCKS ConnectionPanel to a stub <div>, so the card→panel wiring is never exercised.
// A regression in the seam «card click → ConfigList → ConnectionPanel callback → App handler →
// useVpnActions → invoke» would pass all of those. This test closes that gap: it renders the REAL
// App with the REAL ConnectionPanel/ConfigList/ConfigCard (only the heavy NON-connection siblings are
// stubbed, exactly as App.test.tsx stubs them), clicks «Подключить» on a real card, and asserts the
// invoke reaches `vpn_connect` with that card's path; then, after a `connected` status event, clicks
// the lead card's «Отключить» and asserts `vpn_disconnect`.

// Heavy non-connection children — stubbed to keep the render light (same stubs App.test.tsx uses).
// ConnectionPanel is deliberately NOT mocked here — it is the component under test.
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
vi.mock("../SetupWizard", () => ({ __esModule: true, default: () => <div>SetupWizard</div> }));
vi.mock("../ControlPanelPage", () => ({
  ControlPanelPage: () => <div data-testid="control-panel-page">ControlPanelPage</div>,
}));
vi.mock("../RoutingPanel", () => ({ __esModule: true, default: () => <div>RoutingPanel</div> }));
vi.mock("../LogPanel", () => ({ __esModule: true, default: () => <div>LogPanel</div> }));
vi.mock("../AboutPanel", () => ({ __esModule: true, default: () => <div>AboutPanel</div> }));
vi.mock("../DashboardPanel", () => ({ __esModule: true, default: () => <div>DashboardPanel</div> }));
vi.mock("../AppSettingsPanel", () => ({
  __esModule: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: (props: any) => <div>AppSettingsPanel{props.statusPanel}</div>,
}));
vi.mock("../StatusPanel", () => ({ __esModule: true, default: () => <div>StatusPanel</div> }));

// Mock fetch (App runs an update check on mount).
const mockFetch = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ tag_name: "v1.5.0", assets: [], body: "", html_url: "https://github.com" }),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).fetch = mockFetch;

// matchMedia (theme).
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: query.includes("dark"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Capture listen callbacks so we can emit vpn-status like the backend would.
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
  (listenCallbacks[eventName] || []).forEach((cb) => cb({ payload }));
}

const CONFIG_PATH = "C:/app/TrustTunnel_swift-fox.toml";
const CONFIGS: ConfigSummary[] = [
  {
    id: "cfg-de-abc12345",
    name: "Германия — Frankfurt",
    host: "de1.example.com",
    display_host: "de1.example.com",
    user: "swift-fox",
    path: CONFIG_PATH,
    order: 0,
    last_used: true,
  },
];

describe("Connection flow (real wiring) — TA-2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    localStorage.clear();
    // A saved config makes App start on the «Подключение» tab (App.tsx activeTab initializer).
    localStorage.setItem("tt_config_path", CONFIG_PATH);
    localStorage.setItem("tt_log_level", "info");

    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      switch (cmd) {
        case "list_configs":
          return CONFIGS;
        case "read_client_config":
          return { vpn_mode: "general" };
        case "get_auto_connect":
          return false;
        case "auto_detect_config":
          return null;
        case "ping_config_endpoint":
          return { status: "no-data" };
        // The connect/disconnect commands the flow drives + the pre-connect plate pushes.
        case "vpn_connect":
          return { spawned: true, reason: null };
        case "vpn_disconnect":
          return null;
        case "set_pending_connect_ping":
        case "set_pending_connect_origin":
        case "mark_config_last_used":
          return null;
        default:
          return null;
      }
    });
    setupListenMock();
    vi.mocked(getVersion).mockResolvedValue("3.0.0");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("clicking «Подключить» → vpn_connect(path); a connected event → «Отключить» → vpn_disconnect", async () => {
    await act(async () => {
      render(<App />);
    });

    // The REAL ConnectionPanel renders the real card for our config (App defaults to the
    // «Подключение» tab because tt_config_path is set).
    const card = await screen.findByTestId("config-card");
    expect(within(card).getByText("Германия — Frankfurt")).toBeInTheDocument();

    // ── Connect leg ── click the card's «Подключить» (nothing is connected yet).
    const connectBtn = await within(card).findByRole("button", {
      name: i18n.t("connection.card.connect"),
    });
    await act(async () => {
      fireEvent.click(connectBtn);
    });

    // The click reached the real App handler → useVpnActions → invoke("vpn_connect", { configPath }).
    await waitFor(() => {
      expect(
        vi.mocked(invoke).mock.calls.some(
          (c) => c[0] === "vpn_connect" && (c[1] as { configPath?: string })?.configPath === CONFIG_PATH,
        ),
      ).toBe(true);
    });

    // ── Backend confirms the tunnel ── emit the vpn-status connected edge the sidecar would send.
    await act(async () => {
      emitEvent("vpn-status", { status: "connected" });
    });

    // The lead card now offers «Отключить». Re-query the card (the lead may have re-rendered).
    const disconnectBtn = await screen.findByRole("button", {
      name: i18n.t("connection.card.disconnect"),
    });

    // ── Disconnect leg ── click «Отключить» → App handler → useVpnActions → invoke("vpn_disconnect").
    await act(async () => {
      fireEvent.click(disconnectBtn);
    });
    await waitFor(() => {
      expect(vi.mocked(invoke).mock.calls.some((c) => c[0] === "vpn_disconnect")).toBe(true);
    });
  });
});
