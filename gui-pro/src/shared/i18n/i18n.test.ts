import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ru from "./locales/ru.json";
// `?raw` imports return the unparsed file text — required for Pitfall 1
// detection: duplicate JSON keys are silently collapsed by `JSON.parse`, so
// the parsed `en`/`ru` modules cannot reveal them. Vite + Vitest both honor
// the `?raw` query (typed via `vite/client` in tsconfig types).
import ruRaw from "./locales/ru.json?raw";
import enRaw from "./locales/en.json?raw";

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

  it("BUG-A2: messages.connect_cancelled exists in BOTH ru and en with its expected copy", () => {
    // The cancel snackbar («Подключение отменено») must be present + localized in both bundles so the
    // wiring layer (useVpnStatusListener snack:cancelled → i18n.t('messages.connect_cancelled')) never
    // falls back to the raw key / English default in the RU-primary app.
    expect(ru.messages.connect_cancelled).toBe("Подключение отменено");
    expect(en.messages.connect_cancelled).toBe("Connection cancelled");
  });

  it("routing.processListError and its hint exist in BOTH ru and en", () => {
    // The process picker renders these when the running-process enumeration fails. It must render
    // the translated text and never the raw backend error, so a missing key here would put a bare
    // key string in front of the user at precisely the moment something already went wrong.
    expect(ru.routing.processListError).toBeTruthy();
    expect(en.routing.processListError).toBeTruthy();
    expect(ru.routing.processListErrorHint).toBeTruthy();
    expect(en.routing.processListErrorHint).toBeTruthy();
    expect(ru.routing.processListError).not.toBe(en.routing.processListError);
  });
});

describe("Phase 19 — JSON structural integrity", () => {
  // Pitfall 1 mitigation: retracted attempt commit 13118c3f created duplicate
  // "service" JSON keys at the same level — i18n parser silently dropped half
  // of the keys, NSIS installer rendered raw key strings in UI. Single
  // regex-based assertion at file level catches the regression.
  it("ru.json has exactly one 'service' block in JSON (Pitfall 1)", () => {
    const matches = ruRaw.match(/"service"\s*:\s*\{/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("en.json has exactly one 'service' block in JSON (Pitfall 1)", () => {
    const matches = enRaw.match(/"service"\s*:\s*\{/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("ru.json has no 'utilities' keys post-rename (Pitfall 1)", () => {
    const matches = ruRaw.match(/"utilities"\s*:/g) ?? [];
    expect(matches.length).toBe(0);
  });

  it("en.json has no 'utilities' keys post-rename (Pitfall 1)", () => {
    const matches = enRaw.match(/"utilities"\s*:/g) ?? [];
    expect(matches.length).toBe(0);
  });

  it("parity — server.service sub-keys match between ru and en", () => {
    // `as unknown as Record<...>` cast: the typed locale modules describe their
    // exact literal shape, which doesn't overlap with a generic recursive Record.
    // Going through `unknown` is TypeScript's documented escape hatch for
    // "trust me, I know the runtime shape" assertions (per ts2352 hint).
    const ruServer = (ru as unknown as Record<string, Record<string, Record<string, unknown>>>).server;
    const enServer = (en as unknown as Record<string, Record<string, Record<string, unknown>>>).server;
    const ruServiceKeys = Object.keys(ruServer.service).sort();
    const enServiceKeys = Object.keys(enServer.service).sort();
    expect(ruServiceKeys).toEqual(enServiceKeys);
  });

  it("parity — server.service.protocol sub-keys match between ru and en", () => {
    const ruProtocol = (ru as unknown as Record<string, Record<string, Record<string, Record<string, unknown>>>>).server.service.protocol;
    const enProtocol = (en as unknown as Record<string, Record<string, Record<string, Record<string, unknown>>>>).server.service.protocol;
    const ruProtocolKeys = Object.keys(ruProtocol).sort();
    const enProtocolKeys = Object.keys(enProtocol).sort();
    expect(ruProtocolKeys).toEqual(enProtocolKeys);
  });
});
