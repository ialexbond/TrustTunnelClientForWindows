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
    ...actual, // keep PING_* / helpers / types real
    // The hook now returns { pings, refreshPings, pinging }. The mock still records the targets it
    // received (so a test can assert the loop probed NOTHING while connected) and derives the band map
    // from the controllable liveMap — no auto ping, no interval to fake.
    usePerConfigPing: (targets: PingTarget[]) => {
      lastTargets = targets;
      const out: Record<string, ConfigPing> = {};
      for (const t of targets) if (liveMap[t.id]) out[t.id] = liveMap[t.id];
      return { pings: out, refreshPings: async () => {}, pinging: false };
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

  it("BUG-B B2: while CONNECTED the target set INCLUDES the active card; with no manual refresh both cards freeze at the pre-connect band and the engine reads the frozen band", () => {
    // First render DISCONNECTED so the pre-connect readings fill lastGoodByPath (the freeze source).
    const { result, rerender } = renderHook(
      ({ status }: { status: "disconnected" | "connected" }) =>
        useConfigPingSource("/cfg/a.toml", status),
      { initialProps: { status: "disconnected" } as { status: "disconnected" | "connected" } },
    );
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 70 });
    expect(result.current.pings.b).toEqual({ band: "green", valueMs: 85 });

    // CONNECT. Ping is MANUAL-only, so simulate NO manual refresh yet → no fresh live values. BUG-B B2:
    // the ACTIVE card (A) is now IN the target set while connected too (the D-02 exclusion is removed) so
    // «Обновить пинг» can measure it on demand. Without a manual refresh both cards freeze on their
    // retained pre-connect band.
    liveMap = {};
    rerender({ status: "connected" });
    expect(lastTargets.map((t) => t.id).sort()).toEqual(["a", "b"]);

    // Without a manual refresh BOTH cards freeze at their pre-connect band (A active = 70, B = 85).
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 70 });
    expect(result.current.pings.b).toEqual({ band: "green", valueMs: 85 });
    // The engine candidate for B reads the SAME stable frozen value.
    const candB = result.current.candidates.find((c) => c.path === "/cfg/b.toml");
    expect(candB?.reading).toEqual({ status: "ok", ms: 85 });
  });

  it("BUG-B B2: a NUMERIC manual refresh while CONNECTED shows the live number on BOTH active + inactive cards; the engine stays on the frozen band", () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: "disconnected" | "connected" }) =>
        useConfigPingSource("/cfg/a.toml", status),
      { initialProps: { status: "disconnected" } as { status: "disconnected" | "connected" } },
    );
    // Pre-connect fills the freeze cache (a:70, b:85).
    expect(result.current.pings.b).toEqual({ band: "green", valueMs: 85 });

    // Connect, then a manual «Обновить пинг». BUG-B B2: the ACTIVE endpoint (A) is now IN the target set,
    // so the mocked usePerConfigPing returns a live value for it too. A NUMERIC live reading shows on the
    // active card (the owner wants to see a real on-demand number).
    liveMap = { a: { band: "yellow", valueMs: 210 }, b: { band: "yellow", valueMs: 260 } };
    rerender({ status: "connected" });
    expect(lastTargets.map((t) => t.id).sort()).toEqual(["a", "b"]);

    // The ACTIVE card A now surfaces the live NUMERIC manual measurement (210) — owner wants it visible.
    // The INACTIVE card B surfaces its live number (260) as before.
    expect(result.current.pings.a).toEqual({ band: "yellow", valueMs: 210 });
    expect(result.current.pings.b).toEqual({ band: "yellow", valueMs: 260 });
    // The engine candidate STAYS on the frozen pre-connect band (85), NOT the tunnel-routed 260 — so a
    // manual refresh never poisons an auto-switch decision.
    const candB = result.current.candidates.find((c) => c.path === "/cfg/b.toml");
    expect(candB?.reading).toEqual({ status: "ok", ms: 85 });
  });

  it("BUG-B B2: an UNREACHABLE manual refresh of the ACTIVE card while CONNECTED falls back to the retained band (never «Недоступен»); the engine stays frozen", () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: "disconnected" | "connected" }) =>
        useConfigPingSource("/cfg/a.toml", status),
      { initialProps: { status: "disconnected" } as { status: "disconnected" | "connected" } },
    );
    // Pre-connect fills the freeze cache (a active = 70, b = 85).
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 70 });

    // Connect + a manual refresh that reads the ACTIVE endpoint (A) as Unreachable through its own tunnel
    // (timeout, no valueMs) while B reads a live number. The user IS connected to A, so its card must
    // NEVER regress to «Недоступен» — it falls back to the retained honest 70.
    liveMap = { a: { band: "timeout" }, b: { band: "yellow", valueMs: 140 } };
    rerender({ status: "connected" });
    expect(lastTargets.map((t) => t.id).sort()).toEqual(["a", "b"]);

    // The active card keeps its frozen honest band, NOT the Unreachable live reading.
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 70 });
    expect(result.current.pings.a.band).not.toBe("timeout");
    // The inactive card B surfaces its live number.
    expect(result.current.pings.b).toEqual({ band: "yellow", valueMs: 140 });
    // The engine candidate for B stays on the frozen band (the auto-switch decision is never poisoned).
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

  it("D-29: a seeded band carries ONLY a band + numeric ms — no config content / password", () => {
    // BUG-B (17-uat): the seed path stores a { band, valueMs } pill only. Assert the seeded entry has no
    // extra keys that could leak config content (the .toml path/password never becomes part of the band).
    liveMap = {};
    const { result } = renderHook(() => useConfigPingSource("/cfg/a.toml", "connected"));
    act(() => {
      result.current.seedRetainedPing("/cfg/a.toml", 62);
    });
    const seeded = result.current.pings.a as unknown as Record<string, unknown>;
    // Only the pill shape — band + valueMs. No path/password/host/user key crossed into the cached band.
    expect(Object.keys(seeded).sort()).toEqual(["band", "valueMs"]);
    for (const forbidden of ["path", "password", "host", "user", "config", "configPath"]) {
      expect(seeded).not.toHaveProperty(forbidden);
    }
  });

  it("G-19-PING v2: getRetainedPing reads the live frozen band from the ref (null when absent)", () => {
    // The D-05 revert reads A's honest last-known ping from THIS getter (a live ref read), NOT a
    // `pings` snapshot a callback closed over, and NOT a fresh probe (which fails through the just-failed
    // B's killswitch on real hardware → «—»). Disconnected direct probes populate the freeze cache.
    const { result } = renderHook(() => useConfigPingSource("/cfg/a.toml", "disconnected"));
    // A's + B's frozen bands come straight from the live direct readings (liveMap 70 / 85).
    expect(result.current.getRetainedPing("/cfg/a.toml")).toBe(70);
    expect(result.current.getRetainedPing("/cfg/b.toml")).toBe(85);
    // A path with no cached band → null (the caller then falls back to a probe).
    expect(result.current.getRetainedPing("/cfg/unknown.toml")).toBeNull();
  });
});
