/**
 * Install-mode contract — the bundler installs Pro FOR THE MACHINE, and something says so.
 *
 * WHY THIS FILE EXISTS. Phase 32 moved the program out of the user's profile and into the
 * machine's program folder. That single bundler setting — `bundle.windows.nsis.installMode`
 * = `perMachine` — is the premise underneath almost every safety argument the phase then made:
 *
 *   • the data root is NAMED under `%LOCALAPPDATA%` instead of living beside the binaries,
 *     because the binaries now sit in a folder an ordinary user cannot write (D-05);
 *   • the uninstall entry is expected in HKLM, not HKCU, which is what `commands/updater.rs`
 *     reasons from when it decides an install is visible to the machine;
 *   • the uninstaller runs ELEVATED, which is the whole reason `lifecycle.rs` spends several
 *     contracts refusing to resolve a profile-relative path from inside it — under `perMachine`
 *     `$LOCALAPPDATA` is the ELEVATING ADMINISTRATOR'S profile, not the user's;
 *   • the pid directory and the data root are deliberately different places, because one of them
 *     is now world-readable and the other holds servers and passwords.
 *
 * Ten comments across `lifecycle.rs`, `data_adoption.rs`, `commands/updater.rs` and
 * `commands/vpn.rs` open with «under `perMachine` …». NOTHING asserted it. Flip that one JSON
 * string back to `currentUser` and the build still succeeds, every Rust contract still passes —
 * they are contracts about the hook TEXT, not about where Windows puts the program — and ten
 * paragraphs of reasoning silently become false. The failure would surface as a credential
 * disclosure (the data root back in a writable install directory) or as an uninstaller quietly
 * deleting the wrong profile's files, both of which this phase already paid to close once.
 *
 * So the premise is pinned here, at the only place that reads it: the config itself.
 *
 * APPROACH mirrors `focusHygiene.test.ts` and `storybookDocsHygiene.test.ts`: raw text via
 * `import.meta.glob`, never Node `fs`, so the gate runs in the same jsdom environment as the rest
 * of the suite and needs no runner configuration of its own.
 *
 * WHAT THIS DOES NOT PROVE. It proves the bundler was ASKED for a per-machine install. It does
 * not prove Windows complied — that is `32-VALIDATION.md` § «Manual-Only», row «First install
 * after the per-machine flip», and it was confirmed on a real disk on 2026-09-08
 * (`32-UAT.md` test 1: HKLM uninstall entry present, HKCU entry for Pro gone,
 * `C:\Program Files\TrustTunnel Client Pro` populated).
 */

import { describe, it, expect } from "vitest";

/** The bundler config, as text. Glob rather than a direct import so a MISSING file is an empty
 *  record we can indict by name, instead of a build error with no explanation. */
const configs = import.meta.glob("../../src-tauri/tauri.conf.json", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const CONFIG_PATH = "../../src-tauri/tauri.conf.json";

/**
 * The single predicate both the real assertion and the negative controls go through.
 *
 * Returns the configured install mode, or throws with the reason it could not find one. Throwing
 * on a missing key — rather than returning `undefined` and letting a comparison quietly be false
 * — is what stops this gate from passing over a config whose schema moved underneath it.
 */
function readInstallMode(configText: string): string {
  const parsed = JSON.parse(configText) as Record<string, unknown>;

  const bundle = parsed.bundle as Record<string, unknown> | undefined;
  if (!bundle) throw new Error("no `bundle` block");

  const windows = bundle.windows as Record<string, unknown> | undefined;
  if (!windows) throw new Error("no `bundle.windows` block");

  const nsis = windows.nsis as Record<string, unknown> | undefined;
  if (!nsis) throw new Error("no `bundle.windows.nsis` block");

  const mode = nsis.installMode;
  if (typeof mode !== "string") {
    throw new Error("`bundle.windows.nsis.installMode` is absent or not a string");
  }
  return mode;
}

describe("the install-mode premise the phase reasons from", () => {
  it("finds the bundler config it is supposed to be measuring", () => {
    // The vacuity guard for the glob itself. Without it, a moved or renamed config would leave
    // `configs` empty and every assertion below would have nothing to disagree with.
    const found = Object.keys(configs);
    expect(
      found.length,
      `expected to read ${CONFIG_PATH}; the glob matched ${JSON.stringify(found)}`,
    ).toBe(1);
    expect(configs[CONFIG_PATH].length).toBeGreaterThan(0);
  });

  it("installs Pro for the machine, not for the current user", () => {
    const mode = readInstallMode(configs[CONFIG_PATH]);
    expect(
      mode,
      "bundle.windows.nsis.installMode must stay `perMachine`. It is the premise under D-05 " +
        "(the data root is named under %LOCALAPPDATA% because the install directory is no longer " +
        "writable by the user), under the HKLM uninstall entry commands/updater.rs reads, and " +
        "under every lifecycle.rs contract that refuses to resolve a profile-relative path from " +
        "an ELEVATED uninstaller. Changing it back to `currentUser` re-opens the credential " +
        "disclosure phase 32 closed, and no other test in this repository would notice.",
    ).toBe("perMachine");
  });

  it("rejects every way the premise could go missing — the gate can say no", () => {
    // Negative controls. The arm above only means something if this same predicate refuses the
    // configurations that would break the premise. Each mutant is rejected for its OWN reason,
    // so a predicate that started throwing unconditionally would not be able to fake this.
    const base = JSON.parse(configs[CONFIG_PATH]) as Record<string, unknown>;

    const clone = () => JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    const nsisOf = (c: Record<string, unknown>) =>
      (
        (c.bundle as Record<string, unknown>).windows as Record<string, unknown>
      ).nsis as Record<string, unknown>;

    // 1. the flip itself — parses fine, reads fine, and is exactly wrong
    const flipped = clone();
    nsisOf(flipped).installMode = "currentUser";
    expect(readInstallMode(JSON.stringify(flipped))).not.toBe("perMachine");

    // 2. the key deleted — must throw, never return undefined into a passing comparison
    const dropped = clone();
    delete nsisOf(dropped).installMode;
    expect(() => readInstallMode(JSON.stringify(dropped))).toThrow(/installMode/);

    // 3. the key present but not a string (a `true` left behind by a bad edit)
    const retyped = clone();
    nsisOf(retyped).installMode = true;
    expect(() => readInstallMode(JSON.stringify(retyped))).toThrow(/installMode/);

    // 4-6. each enclosing block removed in turn, each indicted by its own name
    for (const [drop, expected] of [
      ["nsis", /`bundle\.windows\.nsis` block/],
      ["windows", /`bundle\.windows` block/],
      ["bundle", /`bundle` block/],
    ] as const) {
      const mutant = clone();
      if (drop === "bundle") delete mutant.bundle;
      else if (drop === "windows") delete (mutant.bundle as Record<string, unknown>).windows;
      else delete ((mutant.bundle as Record<string, unknown>).windows as Record<string, unknown>).nsis;
      expect(() => readInstallMode(JSON.stringify(mutant))).toThrow(expected);
    }
  });
});
