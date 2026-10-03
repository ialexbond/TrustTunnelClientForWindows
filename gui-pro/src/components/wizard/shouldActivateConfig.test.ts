import { describe, it, expect } from "vitest";
import { shouldActivateConfig } from "./shouldActivateConfig";

describe("shouldActivateConfig (UAT 2026-06-19 R2/R3)", () => {
  it("activates ONLY when no active config AND not connected", () => {
    expect(
      shouldActivateConfig({ hasActiveConfig: false, vpnConnected: false })
    ).toBe(true);
  });

  it("does NOT activate when an active config already exists (disconnected)", () => {
    // R3: an existing active config must never be overwritten/replaced.
    expect(
      shouldActivateConfig({ hasActiveConfig: true, vpnConnected: false })
    ).toBe(false);
  });

  it("does NOT activate when the VPN is connected (no prior config)", () => {
    // R3/R4: never replace the active config while connected.
    expect(
      shouldActivateConfig({ hasActiveConfig: false, vpnConnected: true })
    ).toBe(false);
  });

  it("does NOT activate when both an active config exists AND connected", () => {
    expect(
      shouldActivateConfig({ hasActiveConfig: true, vpnConnected: true })
    ).toBe(false);
  });
});
