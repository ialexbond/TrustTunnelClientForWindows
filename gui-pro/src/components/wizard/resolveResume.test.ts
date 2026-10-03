import { describe, it, expect } from "vitest";
import { resolveResume, type ServerProbe } from "./resolveResume";

// A fully-installed, enabled, active, locally-exported server (the "done" baseline).
// Individual tests override the fields they exercise.
function fullProbe(overrides?: Partial<ServerProbe>): ServerProbe {
  return {
    installed: true,
    binaryInstalled: true,
    credentialsExist: true,
    rulesExist: true,
    vpnConfigExists: true,
    hostsConfigExists: true,
    certPresent: true,
    unitExists: true,
    unitEnabled: true,
    serviceActive: true,
    partial: false,
    configDiverges: false,
    localExportComplete: true,
    ...overrides,
  };
}

describe("resolveResume", () => {
  it('not installed → "endpoint"', () => {
    expect(
      resolveResume(
        fullProbe({
          installed: false,
          binaryInstalled: false,
          credentialsExist: false,
          rulesExist: false,
          vpnConfigExists: false,
          hostsConfigExists: false,
          certPresent: false,
          unitExists: false,
          unitEnabled: false,
          serviceActive: false,
          partial: false,
          localExportComplete: false,
        }),
      ),
    ).toBe("endpoint");
  });

  it('installed && partial → "recovery"', () => {
    expect(resolveResume(fullProbe({ partial: true }))).toBe("recovery");
  });

  // FINDING G — resolveResume consumes the unit enable/active chain.

  it('unitExists:true but unitEnabled:false → "recovery" (enable --now not done)', () => {
    // Not partial server-side, but the unit was never enabled.
    expect(
      resolveResume(fullProbe({ unitEnabled: false })),
    ).toBe("recovery");
  });

  it('unitEnabled:true but serviceActive:false → "recovery" (enabled but not running)', () => {
    expect(
      resolveResume(fullProbe({ serviceActive: false })),
    ).toBe("recovery");
  });

  // Codex #5 — "done" requires a real local export.

  it('fully installed + enabled + active but localExportComplete:false → "fetching" (NOT "done")', () => {
    expect(
      resolveResume(fullProbe({ localExportComplete: false })),
    ).toBe("fetching");
  });

  it('fully installed + enabled + active + localExportComplete:true → "done"', () => {
    expect(resolveResume(fullProbe())).toBe("done");
  });
});
