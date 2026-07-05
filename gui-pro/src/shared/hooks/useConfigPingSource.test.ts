import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigSummary } from "./useConfigList";
import type { ConfigPing } from "../../components/connection/ConfigPingPill";
import type { PingTarget } from "./usePerConfigPing";

// useConfigPingSource composes useConfigList + usePerConfigPing. Mock the two child hooks (so we control
// the list + can capture the ping targets). The pure helpers (dedupeConfigsByIdentity,
// configPingToReading) stay real — the whole point is to verify the REAL freeze logic.
//
// F26: there is NO live tunnel probe anymore (a reference-host probe does not honestly traverse the
// tunnel from this process). While connected EVERY card — active included — is frozen at its pre-connect
// reachability. These tests pin that.

const CONFIGS: ConfigSummary[] = [
  { id: "a", name: "A", host: "a.win", display_host: "a.win", user: "ua", path: "/cfg/a.toml", order: 0, last_used: true },
  { id: "b", name: "B", host: "b.win", display_host: "b.win", user: "ub", path: "/cfg/b.toml", order: 1, last_used: false },
];

vi.mock("./useConfigList", () => ({
  useConfigList: () => ({ configs: CONFIGS, reload: vi.fn(), refresh: vi.fn(), loading: false }),
}));

// The mock records the last `targets` it received so a test can assert the loop probed NOTHING while
// connected, and returns a controllable live-ping map keyed by id (only for the ids in `targets`).
let lastTargets: PingTarget[] = [];
let liveMap: Record<string, ConfigPing> = {};
vi.mock("./usePerConfigPing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usePerConfigPing")>();
  return {
    ...actual, // keep PING_* / types real
    usePerConfigPing: (targets: PingTarget[]) => {
      lastTargets = targets;
      const out: Record<string, ConfigPing> = {};
      for (const t of targets) if (liveMap[t.id]) out[t.id] = liveMap[t.id];
      return out;
    },
  };
});

// Imported AFTER the mocks are registered.
import { useConfigPingSource } from "./useConfigPingSource";

describe("useConfigPingSource — F24/F26 freeze (no live probe while connected)", () => {
  beforeEach(() => {
    lastTargets = [];
    liveMap = { a: { band: "green", valueMs: 70 }, b: { band: "green", valueMs: 85 } };
  });

  it("while DISCONNECTED probes every config directly and shows live readings", () => {
    const { result } = renderHook(() => useConfigPingSource("/cfg/a.toml", "disconnected"));
    // Both configs are probed (nothing excluded while down).
    expect(lastTargets.map((t) => t.id).sort()).toEqual(["a", "b"]);
    // Cards show the live direct pings; candidate B carries the live reading.
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 70 });
    expect(result.current.pings.b).toEqual({ band: "green", valueMs: 85 });
    const candB = result.current.candidates.find((c) => c.path === "/cfg/b.toml");
    expect(candB?.reading).toEqual({ status: "ok", ms: 85 });
  });

  it("while CONNECTED probes NOTHING and freezes EVERY card (active included) at its pre-connect value", () => {
    // First render DISCONNECTED so the pre-connect readings fill lastGoodByPath (the freeze source).
    const { result, rerender } = renderHook(
      ({ status }: { status: "disconnected" | "connected" }) =>
        useConfigPingSource("/cfg/a.toml", status),
      { initialProps: { status: "disconnected" } as { status: "disconnected" | "connected" } },
    );
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 70 });
    expect(result.current.pings.b).toEqual({ band: "green", valueMs: 85 });

    // Now CONNECT. The direct-probe loop must go silent (targets empty) — no through-tunnel garbage,
    // and no fake live tunnel probe.
    rerender({ status: "connected" });
    expect(lastTargets).toEqual([]);

    // BOTH cards are FROZEN at their pre-connect values — the ACTIVE card A stays 70 (NOT a live/fake
    // number), the inactive B stays 85.
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 70 });
    expect(result.current.pings.b).toEqual({ band: "green", valueMs: 85 });
    // The engine candidate for B reads the SAME stable frozen value.
    const candB = result.current.candidates.find((c) => c.path === "/cfg/b.toml");
    expect(candB?.reading).toEqual({ status: "ok", ms: 85 });
  });

  it("F29: seedRetainedPing fills the freeze cache so a connected card shows the seeded ping", () => {
    // Simulate autostart: connect immediately with NO warm probe reading (usePerConfigPing returns {}
    // while connected anyway). The active card A has no retained value → honest «—» (absent).
    liveMap = {};
    const { result } = renderHook(() => useConfigPingSource("/cfg/a.toml", "connected"));
    expect(result.current.pings.a).toBeUndefined();

    // useAutoConnect (or a manual connect) delivers the honest pre-connect RTT via seedRetainedPing.
    act(() => {
      result.current.seedRetainedPing("/cfg/a.toml", 62);
    });
    // The connected card now shows the seeded ping (not «—», not a fabricated number).
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 62 });
  });
});
