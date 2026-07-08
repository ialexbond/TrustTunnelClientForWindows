import { describe, it, expect } from "vitest";
// Phase 17 Wave 0 (17-01) — RED (GREEN by 17-04).
//
// PA-1 (FE side): the typed IPC event contract. `shared/ipc/events.ts` does NOT exist yet
// (the `shared/ipc/` directory is created by 17-04), so this import fails to resolve — the
// intended Wave-0 RED for the net-new FE contract. 17-04 lands the two interfaces (mirroring
// the Rust `InternetStatusPayload` / `AdapterConflictPayload` structs, whose serde byte-shape
// is locked in vpn.rs by the sibling Task-2 test) and flips this spec GREEN in place.
//
// The interfaces must mirror the Rust wire shape exactly so the banner-routing listener can
// branch on the typed fields instead of poking at an untyped `serde_json::json!` blob:
//   InternetStatusEvent  { online: boolean; action?: InternetStatusAction; reason?: InternetStatusReason }
//   AdapterConflictEvent { adapters: string[]; message: string }
//
// F10/F15 (Fable-5 review): `action`/`reason` are closed literal unions of the ACTUAL Rust codes
// ("disconnect"/"give_up"; "tunnel-lost"/"internet-lost"), so a typo'd code here is a tsc error.
// `"reconnect"` is gone — PA-4 removed every Rust producer of it, so it never arrives on the wire.
import type { InternetStatusEvent, AdapterConflictEvent } from "./events";
// A VALUE import so the RED is a genuine runtime module-resolution failure (a bare
// `import type` is erased by esbuild and would spuriously pass). 17-04 exports these two
// event-channel name constants from `shared/ipc/events.ts` — the exact channel strings the
// typed listeners subscribe to (`"internet-status"` / `"vpn-adapter-conflict"`).
import { INTERNET_STATUS_EVENT, ADAPTER_CONFLICT_EVENT } from "./events";

describe("shared/ipc/events — PA-1 typed payload contract (RED until 17-04)", () => {
  it("exports the event-channel name constants the typed listeners subscribe to", () => {
    expect(INTERNET_STATUS_EVENT).toBe("internet-status");
    expect(ADAPTER_CONFLICT_EVENT).toBe("vpn-adapter-conflict");
  });

  it("InternetStatusEvent parses the online/action/reason shape the Rust emit produces", () => {
    // An online event carries just `online` (action/reason are optional — omitted on the wire
    // when the Rust Option is None).
    const online: InternetStatusEvent = { online: true };
    expect(online.online).toBe(true);
    expect(online.action).toBeUndefined();

    // An offline `disconnect` event carries the typed action + reason the banner routing branches
    // on — the exact codes a `declare_offline_and_handoff(tunnel-lost)` emit produces (F10). These
    // literals must be members of the narrowed unions or this file fails to type-check.
    const offline: InternetStatusEvent = {
      online: false,
      action: "disconnect",
      reason: "tunnel-lost",
    };
    expect(offline.online).toBe(false);
    expect(offline.action).toBe("disconnect");
    expect(offline.reason).toBe("tunnel-lost");

    // The `give_up` action carries no reason (omitted on the wire).
    const gaveUp: InternetStatusEvent = { online: false, action: "give_up" };
    expect(gaveUp.action).toBe("give_up");
    expect(gaveUp.reason).toBeUndefined();
  });

  it("AdapterConflictEvent parses the adapters/message shape the yellow banner reads", () => {
    const conflict: AdapterConflictEvent = {
      adapters: ["Wintun", "TAP-Windows"],
      message: "Обнаружен конфликтующий VPN-адаптер",
    };
    // The banner shows the message and can list the conflicting adapters.
    expect(conflict.adapters).toHaveLength(2);
    expect(conflict.adapters[0]).toBe("Wintun");
    expect(conflict.message).toContain("адаптер");
  });

  it("a listener parsing a raw emitted payload yields the branching fields banner routing needs", () => {
    // Simulate the shape a Tauri `listen("internet-status", …)` callback receives, then narrow
    // it through the typed interface — the exact step the GREEN listener performs. The codes are
    // real wire values ("disconnect" + "internet-lost"), so the comparison type-checks against
    // the closed unions (F10) — a made-up code would be a non-overlapping-comparison tsc error.
    const rawPayload: unknown = { online: false, action: "disconnect", reason: "internet-lost" };
    const parsed = rawPayload as InternetStatusEvent;
    // Banner routing keys on `online` + `action`; both must be present and typed.
    const shouldShowBanner = parsed.online === false && parsed.action === "disconnect";
    expect(shouldShowBanner).toBe(true);
    expect(parsed.reason).toBe("internet-lost");
  });
});
