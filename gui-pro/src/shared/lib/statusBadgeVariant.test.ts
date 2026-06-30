import { describe, it, expect } from "vitest";
import { statusBadgeVariant } from "./statusBadgeVariant";
import type { VpnStatus } from "../types";

describe("statusBadgeVariant (7-state VpnStatus → StatusBadge colour band)", () => {
  it("maps 'connected' → 'connected' (green)", () => {
    expect(statusBadgeVariant("connected")).toBe("connected");
  });

  it("maps every in-progress state → 'connecting' (yellow)", () => {
    // connection.md decision: connecting / reconnecting / recovering are all
    // «working toward a connection», so they share the non-alarming yellow band.
    expect(statusBadgeVariant("connecting")).toBe("connecting");
    expect(statusBadgeVariant("reconnecting")).toBe("connecting");
    expect(statusBadgeVariant("recovering")).toBe("connecting");
  });

  it("maps the terminal 'error' → 'error' (red)", () => {
    // Only the terminal «Ошибка» is allowed to look alarming (red).
    expect(statusBadgeVariant("error")).toBe("error");
  });

  it("maps teardown + idle states → 'disconnected' (gray)", () => {
    expect(statusBadgeVariant("disconnecting")).toBe("disconnected");
    expect(statusBadgeVariant("disconnected")).toBe("disconnected");
  });

  it("covers all 7 VpnStatus inputs against the expected variant", () => {
    // Exhaustive table — guards the full status→colour contract so a new band
    // assignment (or a dropped case) is caught by this single source of truth.
    const cases: Record<VpnStatus, ReturnType<typeof statusBadgeVariant>> = {
      disconnected: "disconnected",
      connecting: "connecting",
      connected: "connected",
      disconnecting: "disconnected",
      recovering: "connecting",
      reconnecting: "connecting",
      error: "error",
    };
    for (const [status, expected] of Object.entries(cases) as [
      VpnStatus,
      ReturnType<typeof statusBadgeVariant>,
    ][]) {
      expect(statusBadgeVariant(status)).toBe(expected);
    }
  });
});
