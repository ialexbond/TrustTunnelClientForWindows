import { describe, it, expect } from "vitest";
// Ambient types for these two builtins live in ./nodeFsUrlShim.d.ts — this package's tsconfig ships
// no @types/node, so a plain `import { readFileSync } from "node:fs"` would fail typecheck without it.
import { readFileSync } from "node:fs";
// Explicit node:url URL, not the global one: under vitest's jsdom environment, `new URL(rel, base)`
// resolves against jsdom's polyfilled `document.baseURI` (http://localhost:3000/) instead of the
// real file:// base — silently swallowing `import.meta.url` and breaking the `fs` read below.
import { URL as NodeURL } from "node:url";
import tokensCssSource from "./tokens.css?raw";
// The real configuration file, as text — mirrors shellOpenScope.test.ts: the point is what SHIPS,
// not a parsed object a build-time transform could stand between the assertion and the file.
import tauriConfSource from "../../../src-tauri/tauri.conf.json?raw";

/**
 * WHAT THIS FILE IS FOR (MR3-01 / D-13 / D-14 / D-15).
 *
 * The app used to fetch its brand wordmark face ("Outfit") from Google Fonts on every launch —
 * disclosing that this VPN client is running to a third party, and silently falling back to another
 * face whenever the network is off. This guard pins the fix: Outfit ships as a bundled variable
 * WOFF2 next to Geist/GeistMono, its licence travels with it (added in a later task in this same
 * plan — see the CSP/licence describe blocks appended after Task 1), and neither Google font host
 * survives anywhere the app could reach it — the stylesheet or the security policy.
 *
 * Host needles are built from fragments so this file itself never contains a full Google Fonts host
 * (a `git grep` for the literal string must not match this guard as a false positive).
 */
const GOOGLE_FONTS_STYLE_HOST = "fonts." + "googleapis.com";
const GOOGLE_FONTS_STATIC_HOST = "fonts." + "gstatic.com";

describe("self-hosted fonts (tokens.css) — MR3-01", () => {
  it("declares @font-face 'Outfit' pointing at the bundled woff2", () => {
    expect(tokensCssSource).toMatch(
      /@font-face\s*{\s*font-family:\s*'Outfit';\s*src:\s*url\('\.\/fonts\/Outfit-Variable\.woff2'\)\s*format\('woff2'\);/,
    );
  });

  it("does not @import anything (the Google Fonts import is gone)", () => {
    expect(tokensCssSource).not.toContain("@import");
  });

  it("never mentions a Google Fonts host", () => {
    expect(tokensCssSource).not.toContain(GOOGLE_FONTS_STYLE_HOST);
    expect(tokensCssSource).not.toContain(GOOGLE_FONTS_STATIC_HOST);
  });

  it("--font-family-display is unchanged (Outfit first, Geist Sans fallback)", () => {
    expect(tokensCssSource).toContain(
      "--font-family-display: 'Outfit', 'Geist Sans', system-ui, -apple-system, sans-serif;",
    );
  });
});

describe("bundled Outfit font file", () => {
  it("is a real WOFF2 (signature + header length match)", () => {
    const fontPath = new NodeURL("./fonts/Outfit-Variable.woff2", import.meta.url);
    const bytes = readFileSync(fontPath);
    const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    expect(signature).toBe("wOF2");
    // WOFF2 header: uint32BE at byte offset 8 is the total file length. Read by hand (not
    // `Buffer.readUInt32BE`) since `bytes` is typed as the plain `Uint8Array` declared above.
    const headerLength = ((bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11]) >>> 0;
    expect(headerLength).toBe(bytes.length);
  });
});

describe("security policy (tauri.conf.json) — D-14", () => {
  function csp(): string {
    const conf = JSON.parse(tauriConfSource) as {
      app?: { security?: { csp?: unknown } };
    };
    const value = conf.app?.security?.csp;
    expect(typeof value, "app.security.csp must be a policy string").toBe("string");
    return value as string;
  }

  it("style-src and font-src no longer allow a Google Fonts host", () => {
    const policy = csp();
    expect(policy).not.toContain(GOOGLE_FONTS_STYLE_HOST);
    expect(policy).not.toContain(GOOGLE_FONTS_STATIC_HOST);
  });

  it("font-src is narrowed to 'self' and the rest of the policy is unchanged", () => {
    const policy = csp();
    expect(policy).toBe(
      "default-src 'self'; img-src 'self' data: asset: https://asset.localhost; " +
        "style-src 'self' 'unsafe-inline'; font-src 'self'; " +
        "connect-src 'self' ipc: http://ipc.localhost; script-src 'self'; object-src 'none'; " +
        "base-uri 'self'; frame-ancestors 'none'",
    );
  });
});

describe("font licences travel with the fonts — D-13", () => {
  it("Outfit-OFL.txt carries the Outfit Project Authors copyright and the SIL OFL", () => {
    const path = new NodeURL("./fonts/Outfit-OFL.txt", import.meta.url);
    const text = readFileSync(path, "utf-8");
    expect(text.split("\n")[0]).toContain("The Outfit Project Authors");
    expect(text).toContain("SIL OPEN FONT LICENSE");
  });

  it("Geist-OFL.txt carries the Geist Project Authors copyright and the SIL OFL", () => {
    const path = new NodeURL("./fonts/Geist-OFL.txt", import.meta.url);
    const text = readFileSync(path, "utf-8");
    expect(text.split("\n")[0]).toContain("The Geist Project Authors");
    expect(text).toContain("SIL OPEN FONT LICENSE");
  });
});
