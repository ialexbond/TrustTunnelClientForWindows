import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import en from "./locales/en.json";
import ru from "./locales/ru.json";

function flattenKeys(obj: Record<string, unknown>, prefix = ""): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      flattenKeys(value as Record<string, unknown>, fullKey).forEach((k) => keys.add(k));
    } else {
      keys.add(fullKey);
    }
  }
  return keys;
}

describe("i18n key parity", () => {
  it("all English keys exist in Russian", () => {
    const enKeys = flattenKeys(en);
    const ruKeys = flattenKeys(ru);
    const missing = [...enKeys].filter((k) => !ruKeys.has(k));
    expect(missing).toEqual([]);
  });

  it("all Russian keys exist in English", () => {
    const enKeys = flattenKeys(en);
    const ruKeys = flattenKeys(ru);
    const extra = [...ruKeys].filter((k) => !enKeys.has(k));
    expect(extra).toEqual([]);
  });
});

describe("Phase 19 — JSON structural integrity", () => {
  const ruPath = resolve(__dirname, "locales/ru.json");
  const enPath = resolve(__dirname, "locales/en.json");

  // Pitfall 1 mitigation: retracted attempt commit 13118c3f created duplicate
  // "service" JSON keys at the same level — i18n parser silently dropped half
  // of the keys, NSIS installer rendered raw key strings in UI. Single
  // regex-based assertion at file level catches the regression.
  it("ru.json has exactly one 'service' block in JSON (Pitfall 1)", () => {
    const text = readFileSync(ruPath, "utf8");
    const matches = text.match(/"service"\s*:\s*\{/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("en.json has exactly one 'service' block in JSON (Pitfall 1)", () => {
    const text = readFileSync(enPath, "utf8");
    const matches = text.match(/"service"\s*:\s*\{/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("ru.json has no 'utilities' keys post-rename (Pitfall 1)", () => {
    const text = readFileSync(ruPath, "utf8");
    const matches = text.match(/"utilities"\s*:/g) ?? [];
    expect(matches.length).toBe(0);
  });

  it("en.json has no 'utilities' keys post-rename (Pitfall 1)", () => {
    const text = readFileSync(enPath, "utf8");
    const matches = text.match(/"utilities"\s*:/g) ?? [];
    expect(matches.length).toBe(0);
  });

  it("parity — server.service sub-keys match between ru and en", () => {
    const ruServer = (ru as Record<string, Record<string, Record<string, unknown>>>).server;
    const enServer = (en as Record<string, Record<string, Record<string, unknown>>>).server;
    const ruServiceKeys = Object.keys(ruServer.service).sort();
    const enServiceKeys = Object.keys(enServer.service).sort();
    expect(ruServiceKeys).toEqual(enServiceKeys);
  });

  it("parity — server.service.protocol sub-keys match between ru and en", () => {
    const ruProtocol = (ru as Record<string, Record<string, Record<string, Record<string, unknown>>>>).server.service.protocol;
    const enProtocol = (en as Record<string, Record<string, Record<string, Record<string, unknown>>>>).server.service.protocol;
    const ruProtocolKeys = Object.keys(ruProtocol).sort();
    const enProtocolKeys = Object.keys(enProtocol).sort();
    expect(ruProtocolKeys).toEqual(enProtocolKeys);
  });
});
