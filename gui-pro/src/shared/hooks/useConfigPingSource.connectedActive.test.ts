import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigSummary } from "./useConfigList";
import type { ConfigPing } from "../../components/connection/ConfigPingPill";
import type { PingTarget } from "./usePerConfigPing";

// Phase 17 Wave 0 (17-01) — RED (GREEN by 17-02).
//
// D-02 honesty: while CONNECTED, the ACTIVE endpoint card must stay FROZEN at its honest
// pre-connect band and must NEVER read «Недоступен» / flash «—». Today a manual «Обновить пинг»
// while connected probes the active endpoint THROUGH its own tunnel (client → active server →
// itself), which reads garbage — typically Unreachable — and the current `patchedPings` shows
// that live value on the ACTIVE card too (owner 2026-07-05 change: live number shown on demand).
// The D-02 fix (17-02) excludes the active endpoint from the live-shown map (or discards its
// live result) so the active card keeps its frozen pre-connect band, while INACTIVE cards can
// still surface a manual live number. Assumption A3: no «—»/measuring flash on the active card.
//
// This spec asserts the INTENDED D-02 behavior, so it is RED against the current hook (which
// surfaces the active card's live Unreachable) until 17-02 lands the active-card freeze.

// The default `/cfg/*` config set (POSIX-form paths). The F2 block below swaps in Windows-form paths by
// mutating CONFIGS in place (the mock closes over the reference), so each block's beforeEach restores its
// own set to keep the blocks independent of run order.
const DEFAULT_CONFIGS: ConfigSummary[] = [
  { id: "a", name: "A", host: "a.win", display_host: "a.win", user: "ua", path: "/cfg/a.toml", order: 0, last_used: true },
  { id: "b", name: "B", host: "b.win", display_host: "b.win", user: "ub", path: "/cfg/b.toml", order: 1, last_used: false },
];
const CONFIGS: ConfigSummary[] = [...DEFAULT_CONFIGS];

vi.mock("./useConfigList", () => ({
  useConfigList: () => ({ configs: CONFIGS, reload: vi.fn(), refresh: vi.fn(), loading: false }),
}));

// The mock returns a controllable live-ping map keyed by id (only for ids in `targets`), so a
// test can simulate a manual refresh that reads the ACTIVE endpoint as Unreachable through the
// tunnel.
let liveMap: Record<string, ConfigPing> = {};
// F3: a controllable in-flight flag so a test can assert the disconnected bridge shimmers ONLY while a
// manual round is actually running, and settles to a plain number at rest.
let pingingFlag = false;
vi.mock("./usePerConfigPing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usePerConfigPing")>();
  return {
    ...actual,
    usePerConfigPing: (targets: PingTarget[]) => {
      const out: Record<string, ConfigPing> = {};
      for (const t of targets) if (liveMap[t.id]) out[t.id] = liveMap[t.id];
      return { pings: out, refreshPings: async () => {}, pinging: pingingFlag };
    },
  };
});

import { useConfigPingSource } from "./useConfigPingSource";

describe("useConfigPingSource — D-02 active card frozen while connected (RED until 17-02)", () => {
  beforeEach(() => {
    // Restore the POSIX-form default set (the F2 block mutates CONFIGS in place).
    CONFIGS.length = 0;
    CONFIGS.push(...DEFAULT_CONFIGS);
    liveMap = { a: { band: "green", valueMs: 70 }, b: { band: "green", valueMs: 85 } };
    pingingFlag = false;
  });

  it("the ACTIVE card keeps its frozen pre-connect band and NEVER reads «Недоступен» after a connected manual refresh", () => {
    // Fill the pre-connect freeze cache while DISCONNECTED (active A = 70 ms honest direct).
    const { result, rerender } = renderHook(
      ({ status }: { status: "disconnected" | "connected" }) => useConfigPingSource("/cfg/a.toml", status),
      { initialProps: { status: "disconnected" } as { status: "disconnected" | "connected" } },
    );
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 70 });

    // CONNECT, then a manual refresh reads the ACTIVE endpoint (A) as Unreachable through the
    // tunnel (garbage) while an INACTIVE endpoint (B) reads a live number.
    liveMap = { a: { band: "red", unreachable: true } as unknown as ConfigPing, b: { band: "yellow", valueMs: 140 } };
    rerender({ status: "connected" });

    // D-02: the ACTIVE card A must show its FROZEN honest pre-connect band (green 70) — NOT the
    // tunnel-routed Unreachable, and NOT a «—»/measuring flash.
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 70 });
    expect((result.current.pings.a as ConfigPing | undefined)?.band).not.toBe("red");
    expect((result.current.pings.a as { unreachable?: boolean } | undefined)?.unreachable).toBeFalsy();
    expect(result.current.pings.a).toBeDefined(); // never absent → no «—» flash (A3)
  });

  it("INACTIVE cards can still surface a manual live number while connected", () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: "disconnected" | "connected" }) => useConfigPingSource("/cfg/a.toml", status),
      { initialProps: { status: "disconnected" } as { status: "disconnected" | "connected" } },
    );
    // Manual refresh while connected: B (inactive) gets a fresh live number.
    liveMap = { b: { band: "yellow", valueMs: 140 } };
    rerender({ status: "connected" });
    // The inactive card B surfaces the live manual reading (not frozen) — only the ACTIVE card
    // is frozen by D-02.
    expect(result.current.pings.b).toEqual({ band: "yellow", valueMs: 140 });
  });
});

// ── F2 (17-REVIEW): a path-form mismatch must NOT hide a measurement we already have ──────────
//
// The freeze cache is written under the manifest `c.path` form; `activeReading` used to index it with
// the raw `activeConfigPath` prop (from localStorage `tt_config_path`), which arrives in a DIFFERENT
// string form (`\` vs `/`, drive-letter case) for the SAME file on tray-adopt / deeplink / legacy paths.
// The raw lookup returned `undefined` → a `no-data` verdict for a config whose good band was sitting in
// the cache the whole time. The fix keys the lookup off the RESOLVED `activeConfig.path`, normalized at
// every write + read. (This regression originally surfaced as a silently disarmed frontend auto-switch
// engine; that engine was deleted in 28-09, and these cases now guard the reading itself.)
describe("useConfigPingSource — F2 path-form divergence resolves activeReading", () => {
  const WIN_CONFIGS: ConfigSummary[] = [
    // Manifest path form: forward slashes, lowercase drive letter (Rust list_configs form).
    { id: "a", name: "A", host: "a.win", display_host: "a.win", user: "ua", path: "c:/x/a.toml", order: 0, last_used: true },
    { id: "b", name: "B", host: "b.win", display_host: "b.win", user: "ub", path: "c:/x/b.toml", order: 1, last_used: false },
  ];

  beforeEach(() => {
    // Use the Windows-form config list for this block by swapping CONFIGS' contents in place (the module
    // mock closes over the CONFIGS reference, so mutate it rather than reassign).
    CONFIGS.length = 0;
    CONFIGS.push(...WIN_CONFIGS);
    liveMap = { a: { band: "green", valueMs: 70 }, b: { band: "green", valueMs: 85 } };
    pingingFlag = false;
  });

  it("cache written under 'c:/x/a.toml' resolves for an active connect path 'C:\\\\x\\\\A.toml' → activeReading is ok, not no-data", () => {
    // The active connect path arrives in the OTHER form: backslashes + uppercase drive + uppercase name.
    const ACTIVE_RAW = "C:\\x\\A.toml";

    const { result, rerender } = renderHook(
      ({ status }: { status: "disconnected" | "connected" }) => useConfigPingSource(ACTIVE_RAW, status),
      { initialProps: { status: "disconnected" } as { status: "disconnected" | "connected" } },
    );
    // DISCONNECTED: A is probed directly (70 ms honest) → fills the freeze cache under the manifest form.
    expect(result.current.activeReading).toEqual({ status: "ok", ms: 70 });

    // CONNECT. No manual refresh → the connected branch must resolve the FROZEN band despite the path-form
    // mismatch between ACTIVE_RAW ("C:\x\A.toml") and the manifest key ("c:/x/a.toml").
    liveMap = {};
    rerender({ status: "connected" });

    // F2: activeReading is the frozen 70 ms — NOT no-data. A no-data here would report the connected
    // server as unmeasured for the whole session, while its honest band sat in the cache under the
    // other path form.
    expect(result.current.activeReading).toEqual({ status: "ok", ms: 70 });
    expect(result.current.activeReading.status).not.toBe("no-data");

    // The active card also shows the frozen band under the mismatched path form.
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 70 });
  });

  it("candidates resolve their frozen band under path-form divergence too (sibling of activeReading)", () => {
    const ACTIVE_RAW = "C:\\x\\A.toml";
    const { result, rerender } = renderHook(
      ({ status }: { status: "disconnected" | "connected" }) => useConfigPingSource(ACTIVE_RAW, status),
      { initialProps: { status: "disconnected" } as { status: "disconnected" | "connected" } },
    );
    // Pre-connect fills the cache (a:70, b:85).
    expect(result.current.candidates.find((c) => c.path === "c:/x/b.toml")?.reading).toEqual({
      status: "ok",
      ms: 85,
    });

    liveMap = {};
    rerender({ status: "connected" });
    // Frozen candidate B still resolves 85 (keyed by the normalized manifest path).
    expect(result.current.candidates.find((c) => c.path === "c:/x/b.toml")?.reading).toEqual({
      status: "ok",
      ms: 85,
    });
  });
});

// ── F1 (17-REVIEW): through-tunnel reading must NEVER poison the frozen band ───────────────────
//
// A connected manual «Обновить пинг» probes the INACTIVE endpoints through the tunnel (garbage, F26).
// The cache-write effect's `if (!tunnelUp)` guard checks the CURRENT status only, so on the
// tunnelUp true→false flip it re-runs with the stale connected-time `pings` still present and would
// flush the through-tunnel value into `lastGoodByPath` as a fake "honest DIRECT" band — the exact fake
// number the phase retired. Ping is manual-only, so nothing overwrites the poison before a reconnect →
// the frozen card + PA-2 candidate band show the fake number all session.
describe("useConfigPingSource — F1 through-tunnel reading does NOT poison lastGoodByPath on disconnect", () => {
  beforeEach(() => {
    CONFIGS.length = 0;
    CONFIGS.push(...DEFAULT_CONFIGS);
    liveMap = { a: { band: "green", valueMs: 70 }, b: { band: "green", valueMs: 85 } };
    pingingFlag = false;
  });

  it("a connected manual refresh of an INACTIVE card, then disconnect, keeps the honest pre-connect band (not the tunnel garbage)", () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: "disconnected" | "connected" }) => useConfigPingSource("/cfg/a.toml", status),
      { initialProps: { status: "disconnected" } as { status: "disconnected" | "connected" } },
    );
    // DISCONNECTED: honest pre-connect direct probes fill the cache (a active = 70, b inactive = 85).
    expect(result.current.pings.b).toEqual({ band: "green", valueMs: 85 });

    // CONNECT + manual «Обновить пинг»: the inactive endpoint B reads a through-tunnel value (garbage —
    // here a red 600 ms). A is the active card and is excluded from the connected target set (D-02).
    liveMap = { b: { band: "red", valueMs: 600 } };
    rerender({ status: "connected" });
    // Display-only: the card may surface the live tunnel number, but the ENGINE candidate stays frozen.
    expect(result.current.candidates.find((c) => c.path === "/cfg/b.toml")?.reading).toEqual({
      status: "ok",
      ms: 85,
    });

    // DISCONNECT with the through-tunnel value STILL LINGERING in `pings` (ping is manual-only — no fresh
    // probe fired). This is the exact regression window: the cache-write effect re-runs with `!tunnelUp`
    // now true and the stale connected-time `pings.b` (red 600) still present. F1 must REFUSE to cache
    // this tunnel-tainted object (matched by reference), leaving `lastGoodByPath[b]` at the honest 85.
    rerender({ status: "disconnected" });

    // Now clear the live map (represents the WR-05 prune / a moment before the next manual refresh) so the
    // disconnected bridge falls through to `lastGoodByPath` — the frozen band under test — instead of the
    // lingering live display value.
    liveMap = {};
    rerender({ status: "disconnected" });

    // F1: the retained band for B is the HONEST pre-connect 85 (bridged, settled per F3 since no round is
    // in flight) — NOT the poison 600. If the flip-time cache-write had flushed the through-tunnel object,
    // this would read red/600 instead.
    expect(result.current.pings.b).toEqual({ band: "green", valueMs: 85 });
    expect((result.current.pings.b as ConfigPing).valueMs).not.toBe(600);
    expect((result.current.pings.b as ConfigPing).band).not.toBe("red");
  });

  it("reconnect after the poison sequence still hands the engine the honest frozen band", () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: "disconnected" | "connected" }) => useConfigPingSource("/cfg/a.toml", status),
      { initialProps: { status: "disconnected" } as { status: "disconnected" | "connected" } },
    );
    expect(result.current.candidates.find((c) => c.path === "/cfg/b.toml")?.reading).toEqual({
      status: "ok",
      ms: 85,
    });

    // Connect + tunnel-routed manual refresh, then disconnect (poison lingers), then RECONNECT.
    liveMap = { b: { band: "red", valueMs: 600 } };
    rerender({ status: "connected" });
    rerender({ status: "disconnected" });
    liveMap = {}; // manual-only — no fresh probe between the disconnect and the reconnect
    rerender({ status: "connected" });

    // F1: on the reconnect the engine candidate for B is STILL the honest frozen 85, never the fake 600.
    expect(result.current.candidates.find((c) => c.path === "/cfg/b.toml")?.reading).toEqual({
      status: "ok",
      ms: 85,
    });
  });

  it("a FRESH direct probe after disconnect DOES update the cache (the boundary is not over-broad)", () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: "disconnected" | "connected" }) => useConfigPingSource("/cfg/a.toml", status),
      { initialProps: { status: "disconnected" } as { status: "disconnected" | "connected" } },
    );
    expect(result.current.pings.b).toEqual({ band: "green", valueMs: 85 });

    // Connect + through-tunnel refresh, then disconnect (poison must be refused).
    liveMap = { b: { band: "red", valueMs: 600 } };
    rerender({ status: "connected" });
    rerender({ status: "disconnected" });

    // A genuinely fresh DIRECT probe lands while disconnected (a NEW object → not the tainted reference).
    // This honest value MUST be cached — F1 must not freeze the cache permanently.
    liveMap = { a: { band: "green", valueMs: 72 }, b: { band: "green", valueMs: 90 } };
    rerender({ status: "disconnected" });
    expect(result.current.candidates.find((c) => c.path === "/cfg/b.toml")?.reading).toEqual({
      status: "ok",
      ms: 90,
    });
  });
});

// ── F3 (17-REVIEW): active card must NOT be stuck in an indefinite «measuring» shimmer post-disconnect ──
//
// At connect, D-02 excludes the active endpoint from targets + WR-05 prunes `pings[activeId]`. On
// disconnect the active id re-enters targets with no `pings` entry, so the disconnected branch bridges it
// from `lastGoodByPath`. The former bridge marked it `measuring:true` unconditionally, assuming an
// auto-probe loop would overwrite it. That loop is gone (ping is manual-only), so the most prominent card
// showed an indefinite skeleton (no number) after EVERY disconnect until a manual refresh — violating
// D-02's own "no «—»/measuring flash" promise. The fix bridges the retained band as a SETTLED value,
// shimmering only while a manual round is actually in flight (`pinging`).
describe("useConfigPingSource — F3 post-disconnect active card shows the retained number (settled, not a skeleton)", () => {
  beforeEach(() => {
    CONFIGS.length = 0;
    CONFIGS.push(...DEFAULT_CONFIGS);
    liveMap = { a: { band: "green", valueMs: 70 }, b: { band: "green", valueMs: 85 } };
    pingingFlag = false;
  });

  it("after connect→disconnect the ACTIVE card shows its retained band as a settled number (no measuring flag)", () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: "disconnected" | "connected" }) => useConfigPingSource("/cfg/a.toml", status),
      { initialProps: { status: "disconnected" } as { status: "disconnected" | "connected" } },
    );
    // DISCONNECTED: A (active) probed directly → freeze cache holds a=70.
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 70 });

    // CONNECT: A is excluded from targets (D-02) and its live entry is pruned (WR-05). The card freezes on
    // the retained band.
    rerender({ status: "connected" });

    // DISCONNECT with NO fresh live reading for A (ping is manual-only). A re-enters targets with no
    // `pings` entry → the disconnected bridge must settle it to the retained band, NOT an indefinite
    // «measuring» skeleton.
    liveMap = {}; // no fresh probe fired between connect and this disconnect
    rerender({ status: "disconnected" });

    // F3: the active card shows the retained NUMBER, settled — measuring must be absent/falsy.
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 70 });
    expect((result.current.pings.a as ConfigPing).measuring).toBeFalsy();
  });

  it("while a manual round IS in flight the bridged card shimmers (measuring true) over its retained band", () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: "disconnected" | "connected" }) => useConfigPingSource("/cfg/a.toml", status),
      { initialProps: { status: "disconnected" } as { status: "disconnected" | "connected" } },
    );
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 70 });
    rerender({ status: "connected" });

    // Disconnect WITH a manual round actively in flight — the card correctly shimmers at its prior band.
    liveMap = {};
    pingingFlag = true;
    rerender({ status: "disconnected" });
    expect(result.current.pings.a).toEqual({ band: "green", valueMs: 70, measuring: true });
  });
});
