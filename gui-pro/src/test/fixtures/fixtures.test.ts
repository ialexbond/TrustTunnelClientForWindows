import { describe, it, expect, vi, beforeEach } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { parseCertInfo, daysUntil } from "../../components/server/certUtils";
import {
  makeCertRaw,
  captureListeners,
  emitEvent,
  activityLogSpy,
  expectNoSecretLogged,
  installActivityLogSpy,
} from "./index";

/**
 * Self-tests for the Phase 3 shared fixtures (Wave 0). These prove the helpers
 * behave as the Wave-1 streams will rely on — without touching production code.
 */

describe("makeCertRaw — cert day bands via certUtils", () => {
  it("makeCertRaw(20) parses to ~20 days left (ok band > 14)", () => {
    const info = parseCertInfo(makeCertRaw(20));
    const days = daysUntil(info.notAfter);
    expect(days).not.toBeNull();
    // Rounding tolerance: daysUntil uses Math.ceil over a real Date.now().
    expect(days!).toBeGreaterThanOrEqual(19);
    expect(days!).toBeLessThanOrEqual(21);
    expect(days!).toBeGreaterThan(14); // ok band
    expect(info.certType).toBe("lets_encrypt");
  });

  it("makeCertRaw(-1) parses to an expired cert (≤ 0 days)", () => {
    const info = parseCertInfo(makeCertRaw(-1));
    const days = daysUntil(info.notAfter);
    expect(days).not.toBeNull();
    expect(days!).toBeLessThanOrEqual(0); // expired band
  });

  it("makeCertRaw(5) lands in the danger band (1–7 days)", () => {
    const days = daysUntil(parseCertInfo(makeCertRaw(5)).notAfter);
    expect(days!).toBeGreaterThanOrEqual(1);
    expect(days!).toBeLessThanOrEqual(7);
  });
});

describe("activityLogSpy — D-29 absence assertion", () => {
  beforeEach(() => {
    installActivityLogSpy(); // resets prior call history
  });

  it("PASSES when no logged arg contains the probe secret", () => {
    activityLogSpy("STATE", "panel.load.start host=10.0.0.1");
    // Probe secret asserted ABSENT — never printed.
    expect(() => expectNoSecretLogged("TOPSECRET123")).not.toThrow();
  });

  it("THROWS when a logged arg contains the probe secret", () => {
    // Simulate a leak: a string arg carries the placeholder secret.
    activityLogSpy("STATE", "leaked password=TOPSECRET123 oops");
    expect(() => expectNoSecretLogged("TOPSECRET123")).toThrow();
  });

  it("ignores non-string args (numbers/objects do not false-trigger)", () => {
    activityLogSpy("STATE", "safe", { count: 1 }, 42);
    expect(() => expectNoSecretLogged("TOPSECRET123")).not.toThrow();
  });
});

describe("captureListeners / emitEvent — Tauri event round-trip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emitEvent reaches a listener registered via the mocked listen()", async () => {
    const events = captureListeners();
    const received: unknown[] = [];
    // Register like production code would.
    await listen("tt:security-changed", (e: { payload: unknown }) => {
      received.push(e.payload);
    });
    expect(events.count("tt:security-changed")).toBe(1);

    events.emitEvent("tt:security-changed", { firewall: "active" });
    expect(received).toEqual([{ firewall: "active" }]);
  });

  it("supports the standalone emitEvent(registry, ...) form", async () => {
    const events = captureListeners();
    const hits: unknown[] = [];
    await listen("benchmark-progress", (e: { payload: unknown }) => {
      hits.push(e.payload);
    });
    emitEvent(events.registry, "benchmark-progress", { pct: 50 });
    expect(hits).toEqual([{ pct: 50 }]);
  });

  it("unlisten removes the callback so later emits are no-ops", async () => {
    const events = captureListeners();
    const hits: unknown[] = [];
    const unlisten = await listen(
      "update-protocol-step",
      (e: { payload: unknown }) => {
        hits.push(e.payload);
      },
    );
    unlisten();
    events.emitEvent("update-protocol-step", { step: 1 });
    expect(hits).toEqual([]);
  });
});
