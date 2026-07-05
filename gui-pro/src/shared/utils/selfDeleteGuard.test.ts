import { describe, it, expect, vi, afterEach } from "vitest";
import { markSelfDelete, clearSelfDelete, isSelfDeleting } from "./selfDeleteGuard";

// B2 (16-UAT round 2): the self-delete guard is a module-level singleton shared between
// the in-app delete initiator and the fs-watcher reactor. These tests pin its contract:
// mark → isSelfDeleting true; clear → false; normalization matches samePath's rules; the
// TTL backstop auto-expires a forgotten mark; an empty path is a no-op.

afterEach(() => {
  vi.useRealTimers();
});

describe("selfDeleteGuard", () => {
  it("mark makes a path self-deleting; clear removes it", () => {
    const p = "C:/data/TrustTunnel_swift-fox.toml";
    expect(isSelfDeleting(p)).toBe(false);
    markSelfDelete(p);
    expect(isSelfDeleting(p)).toBe(true);
    clearSelfDelete(p);
    expect(isSelfDeleting(p)).toBe(false);
  });

  it("matches by normalized path (separator + case insensitive, like samePath)", () => {
    markSelfDelete("C:\\data\\Cfg.toml");
    // Same file, different string form (forward slashes, lowercase) still matches.
    expect(isSelfDeleting("c:/data/cfg.toml")).toBe(true);
    clearSelfDelete("c:/data/cfg.toml");
    expect(isSelfDeleting("C:\\data\\Cfg.toml")).toBe(false);
  });

  it("an empty path is a no-op for mark/clear/isSelfDeleting", () => {
    expect(isSelfDeleting("")).toBe(false);
    markSelfDelete(""); // must not throw or mark anything
    expect(isSelfDeleting("")).toBe(false);
  });

  it("TTL backstop auto-clears a forgotten mark", () => {
    vi.useFakeTimers();
    const p = "C:/data/forgotten.toml";
    markSelfDelete(p);
    expect(isSelfDeleting(p)).toBe(true);
    // The caller never calls clearSelfDelete — the backstop TTL must expire it on its own.
    // The TTL is 8s (#7: teardown can take ~7s); advance well past it.
    vi.advanceTimersByTime(9000);
    expect(isSelfDeleting(p)).toBe(false);
  });

  // ── #9 (Fable re-review): a re-mark must (re)arm the TTL, not inherit a stale timer ──
  // The bug: `selfDeleting` was a Set + a bare setTimeout with no cancel, so re-marking the
  // same path left the PREVIOUS timer pending → it deleted the fresh mark's key early. This
  // is reachable via the ordinary "delete several configs quickly, active one last" flow,
  // since every delete marks activeConfigPath.
  it("re-marking the same path does NOT let a stale timer expire the fresh mark early", () => {
    vi.useFakeTimers();
    const p = "C:/data/active.toml";
    markSelfDelete(p);
    // 5s in — the FIRST timer would fire at 8s. Re-mark now: this must cancel the first timer
    // and arm a fresh 8s TTL from here.
    vi.advanceTimersByTime(5000);
    expect(isSelfDeleting(p)).toBe(true);
    markSelfDelete(p);
    // Advance to just past where the ORIGINAL timer would have fired (8s total). With the bug
    // the stale timer would delete the key here; fixed, the fresh timer keeps it marked.
    vi.advanceTimersByTime(3500); // 8.5s total, but only 3.5s into the fresh 8s TTL
    expect(isSelfDeleting(p)).toBe(true);
    // The fresh TTL eventually expires it.
    vi.advanceTimersByTime(5000); // 8.5s into the fresh TTL
    expect(isSelfDeleting(p)).toBe(false);
  });

  it("marking a second path while the first is pending keeps both correctly timed", () => {
    vi.useFakeTimers();
    const a = "C:/data/a.toml";
    const b = "C:/data/b.toml";
    markSelfDelete(a);
    vi.advanceTimersByTime(4000); // a is 4s into its TTL
    markSelfDelete(b); // b starts a fresh TTL; a's timer is untouched
    // At 8s total, a's TTL expires; b is only 4s in and still marked.
    vi.advanceTimersByTime(4000); // total 8s
    expect(isSelfDeleting(a)).toBe(false);
    expect(isSelfDeleting(b)).toBe(true);
    // b expires at its own 8s mark.
    vi.advanceTimersByTime(4000); // b now 8s in
    expect(isSelfDeleting(b)).toBe(false);
  });

  it("clearSelfDelete cancels the pending backstop timer", () => {
    vi.useFakeTimers();
    const p = "C:/data/cleared.toml";
    markSelfDelete(p);
    clearSelfDelete(p);
    expect(isSelfDeleting(p)).toBe(false);
    // The timer must be cancelled: advancing past the TTL must not re-run any delete that
    // could interfere with a re-mark of the same key in the meantime.
    markSelfDelete(p); // re-mark after a clear — a fresh full TTL
    vi.advanceTimersByTime(7000); // 7s < 8s TTL → still marked (the cancelled timer never fired)
    expect(isSelfDeleting(p)).toBe(true);
    vi.advanceTimersByTime(2000); // 9s → fresh timer expires
    expect(isSelfDeleting(p)).toBe(false);
  });
});
