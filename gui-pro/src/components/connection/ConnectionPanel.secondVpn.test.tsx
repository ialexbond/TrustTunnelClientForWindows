import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { renderWithProviders } from "../../test/test-utils";
import { ConnectionPanel } from "./ConnectionPanel";
import { listen } from "@tauri-apps/api/event";
import type { ConfigSummary } from "../../shared/hooks/useConfigList";

// ─── Phase 16 (plan 16-01 RED → 16-02 GREEN): the T-34 second-VPN conflict banner ───
//
// GREEN (T-34, delivered by 16-02) — a running SECOND VPN client (Amnezia / WireGuard) surfaces a
// `vpn-adapter-conflict` backend event. `useVpnEvents` still LOGS it (useVpnEvents.ts:474-485) and
// now also lifts the payload into state; ConnectionPanel additionally subscribes to the same event
// and renders a reused `ErrorBanner variant="warning"` (role="alert") atop the panel body, above the
// config list, carrying the interpolated adapter name — with a per-adapter dismiss that persists.
//
// Test A asserts the no-event baseline (green from the start); Tests B and C were RED under 16-01 and
// turn GREEN here in 16-02 (mirrors the 14-01 → 14-02/03/04 RED→GREEN handoff). The banner is the
// REUSED `ErrorBanner variant="warning"` — NO new `SecondVpnBanner` component (LOCKED per
// 10-04-SUMMARY.md); this test references only `ErrorBanner` semantics (role="alert" + the warning
// copy), never a bespoke component.

// invoke drives the config list (list_configs) + harmless ping.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// listen is captured so a `vpn-adapter-conflict` handler can be fired imperatively.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Capture listen callbacks by event name (mirrors App.test.tsx's setupListenMock pattern).
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

async function emitConflict(adapters: string[], message = "conflict") {
  const cbs = listenCallbacks["vpn-adapter-conflict"] || [];
  await act(async () => {
    cbs.forEach((cb) => cb({ payload: { adapters, message } }));
  });
}

const ONE: ConfigSummary[] = [
  { id: "cfg-a", name: "Германия — Frankfurt", host: "de1.example.com", display_host: "de1.example.com", user: "swift-fox", path: "C:/app/a.toml", order: 0, last_used: true },
];

function setup() {
  renderWithProviders(
    <ConnectionPanel
      onImport={vi.fn()}
      status="disconnected"
      activeConfigPath=""
      onConnect={vi.fn()}
      onDisconnect={vi.fn().mockResolvedValue(undefined)}
      onSwitchTo={vi.fn()}
      onReconnect={vi.fn().mockResolvedValue(undefined)}
    />,
  );
}

// The banner copy 16-02 will add — interpolated with the conflicting adapter name. Resolved through
// i18n so the assertion is language-agnostic (jsdom defaults to en-US). Until 16-02 adds the key,
// i18n.t returns the raw key, so the RED cases fail on "no banner rendered" (not on copy).
const AMNEZIA_WARNING = i18n.t("connection.secondVpn.warning", { adapter: "Amnezia VPN" });

describe("ConnectionPanel — T-34 second-VPN banner (GREEN in 16-02)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    setupListenMock();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_configs") return Promise.resolve(ONE);
      if (cmd === "ping_config_endpoint") return Promise.resolve({ status: "no-data" });
      return Promise.resolve(null);
    });
  });

  // Test A (baseline): with NO conflict event, the panel renders NO warning banner (no role="alert").
  it("renders no warning banner when no conflict event has fired", async () => {
    setup();
    await screen.findByText("Германия — Frankfurt");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  // Test B (GREEN in 16-02): after a `vpn-adapter-conflict` event, a warning ErrorBanner
  // (role="alert") appears carrying the interpolated adapter name.
  it("shows a warning banner naming the adapter after a conflict event", async () => {
    setup();
    await screen.findByText("Германия — Frankfurt");
    await emitConflict(["Amnezia VPN"]);
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(AMNEZIA_WARNING);
    });
  });

  // Test C (GREEN in 16-02): dismissing the banner hides it; re-emitting the SAME adapter keeps it
  // hidden (per-adapter dismiss persists), while a DIFFERENT adapter re-shows it.
  it("dismiss persists per-adapter — same adapter stays hidden, a different adapter re-shows", async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByText("Германия — Frankfurt");

    // Fire → banner shows → dismiss it (× carries the localized close label).
    await emitConflict(["Amnezia VPN"]);
    const alert = await screen.findByRole("alert");
    await user.click(within(alert).getByRole("button", { name: i18n.t("buttons.close") }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Re-emit the SAME adapter → stays hidden (dismissed for this adapter).
    await emitConflict(["Amnezia VPN"]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    // Emit a DIFFERENT adapter → re-shows the banner.
    await emitConflict(["WireGuard"]);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  // Test D (Fable review #151): a stale banner must clear at the START of the next connect
  // attempt. The backend emits `vpn-adapter-conflict` only on a NON-empty conflict set, so a
  // resolved conflict produces no all-clear event; without this reset the banner would assert a
  // resolved conflict for the whole session. On status → "connecting" the banner clears; a
  // still-present conflict re-emits ~1s later from the per-connect detection thread and re-shows.
  it("clears a stale conflict banner on the next connect attempt (status → connecting)", async () => {
    const { rerender } = renderWithProviders(
      <ConnectionPanel
        onImport={vi.fn()}
        status="disconnected"
        activeConfigPath=""
        onConnect={vi.fn()}
        onDisconnect={vi.fn().mockResolvedValue(undefined)}
        onSwitchTo={vi.fn()}
        onReconnect={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await screen.findByText("Германия — Frankfurt");

    // Conflict shows the banner.
    await emitConflict(["Amnezia VPN"]);
    await screen.findByRole("alert");

    // A new connect attempt begins → the banner clears.
    rerender(
      <ConnectionPanel
        onImport={vi.fn()}
        status="connecting"
        activeConfigPath=""
        onConnect={vi.fn()}
        onDisconnect={vi.fn().mockResolvedValue(undefined)}
        onSwitchTo={vi.fn()}
        onReconnect={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());

    // If the conflict is STILL present, the backend re-emits and the banner re-shows.
    await emitConflict(["Amnezia VPN"]);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });

  // Test E (TA-4): lock the DISCONNECT behaviour. The conflict is cleared ONLY on the `connecting`
  // edge (ConnectionPanel.tsx:171-173) — there is NO clear on `disconnected`. So a banner shown while
  // connected PERSISTS across a transition to `disconnected`. This asserts the CURRENT reality
  // (MINOR-3 in the audit): the banner stays until the user dismisses it or the next connect attempt
  // clears it. NOTE: MINOR-3 «auto-clear the stale conflict banner on disconnect» is a SEPARATE
  // backlog item — this test deliberately pins today's behaviour so a future change that adds the
  // auto-clear will (correctly) flip this test and force a conscious update, rather than passing
  // silently. It does NOT assert auto-clear.
  it("TA-4: a shown conflict banner PERSISTS on status → disconnected (no auto-clear — MINOR-3)", async () => {
    const { rerender } = renderWithProviders(
      <ConnectionPanel
        onImport={vi.fn()}
        status="connected"
        activeConfigPath="C:/app/a.toml"
        onConnect={vi.fn()}
        onDisconnect={vi.fn().mockResolvedValue(undefined)}
        onSwitchTo={vi.fn()}
        onReconnect={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    await screen.findByText("Германия — Frankfurt");

    // A second VPN is detected while we are connected → the banner shows.
    await emitConflict(["Amnezia VPN"]);
    await screen.findByRole("alert");

    // The tunnel drops to disconnected (NOT via a connect attempt, so no `connecting` reset edge).
    rerender(
      <ConnectionPanel
        onImport={vi.fn()}
        status="disconnected"
        activeConfigPath=""
        onConnect={vi.fn()}
        onDisconnect={vi.fn().mockResolvedValue(undefined)}
        onSwitchTo={vi.fn()}
        onReconnect={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    // Current reality (MINOR-3): the banner is STILL shown — the clear only happens on `connecting`.
    // Flush any pending effects first, then assert it persisted.
    await waitFor(() => expect(screen.getByText("Германия — Frankfurt")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(AMNEZIA_WARNING);
  });
});
