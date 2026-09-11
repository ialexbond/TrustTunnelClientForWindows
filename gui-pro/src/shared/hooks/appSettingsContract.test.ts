/**
 * The app-settings DEFAULT contract: for every setting bound through `APP_SETTINGS_KEYS`, every
 * reader must agree on what an ABSENT key means, and the answer must be `APP_SETTINGS_DEFAULTS`.
 *
 * WHY THIS FILE EXISTS (G-32-9). `tt_auto_connect` had two readers that disagreed:
 *
 *   - `useAppSettings` read it through `readBoolean(key, APP_SETTINGS_DEFAULTS.autoConnectOnLaunch)`,
 *     so an absent key painted the «Автоподключение при запуске» switch ON.
 *   - `useAutoConnect` read the RAW key and required the literal "true", so an absent key meant OFF
 *     and the hook returned at its very first gate.
 *
 * Until the user touched that switch, the screen promised a feature that was not armed. It was
 * measured, not inferred: on a real Windows install the WebView leveldb showed `tt_auto_connect`
 * written ONCE, as the LAST record in the file, after the failed reboot and after a manual connect —
 * i.e. the key did not exist at the moment auto-connect should have fired.
 *
 * The fix is a single shared reader (`readAppSettingBoolean`), and this file is what stops the two
 * ends drifting apart again. It pins the invariant twice, from two directions:
 *
 *   1. BEHAVIOUR — the shared reader returns exactly `APP_SETTINGS_DEFAULTS[name]` for an absent
 *      key, for EVERY boolean setting, not just the one that broke.
 *   2. STRUCTURE — no module other than `useAppSettings.ts` reads one of those keys straight out of
 *      localStorage. A consumer that does is free to invent its own idea of «absent», which is the
 *      whole defect; catching it here means catching it before it ships rather than in a leveldb
 *      hexdump afterwards.
 *
 * The setting table is derived from `APP_SETTINGS_DEFAULTS` at runtime rather than transcribed, so
 * a boolean setting added later joins this contract without anybody remembering to add it.
 *
 * Raw text via `import.meta.glob` (not `node:fs`): this package's tsconfig ships only `vite/client`
 * types, and evaluating the modules would drag in Tauri mocks. Same idiom as
 * `_story/releaseCoupling.test.ts` — but this file lives in production source ON PURPOSE, because
 * the rule it guards is a production rule and must travel to the release branch with the code.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  APP_SETTINGS_DEFAULTS,
  APP_SETTINGS_KEYS,
  readAppSettingBoolean,
  type AppSettings,
  type BooleanAppSettingName,
} from "./useAppSettings";

/**
 * Every boolean member of `AppSettings`, discovered from the defaults object itself.
 *
 * Derived rather than listed: a hand-written list is a second register of the same fact, and the
 * bug this file exists to prevent is precisely two registers of one fact drifting apart.
 */
const BOOLEAN_SETTINGS = (
  Object.keys(APP_SETTINGS_DEFAULTS) as (keyof AppSettings)[]
).filter(
  (name) => typeof APP_SETTINGS_DEFAULTS[name] === "boolean",
) as BooleanAppSettingName[];

beforeEach(() => {
  localStorage.clear();
});

describe("app settings — an absent key means the DEFAULT, for every reader", () => {
  it("has boolean settings to check at all (guards against a vacuous table)", () => {
    // If the derivation above ever returns [], every `it.each` below would pass by iterating
    // nothing. This phase has already found seven checks that could not fail; this is the
    // cheapest way to keep this one out of that list.
    expect(BOOLEAN_SETTINGS.length).toBeGreaterThan(0);
    expect(BOOLEAN_SETTINGS).toContain("autoConnectOnLaunch");
  });

  it.each(BOOLEAN_SETTINGS)(
    "%s: absent key reads as APP_SETTINGS_DEFAULTS",
    (name) => {
      expect(localStorage.getItem(APP_SETTINGS_KEYS[name])).toBeNull();
      expect(readAppSettingBoolean(name)).toBe(APP_SETTINGS_DEFAULTS[name]);
    },
  );

  it.each(BOOLEAN_SETTINGS)(
    "%s: a STORED value still wins over the default (the reader is not a constant)",
    (name) => {
      // Without this pair the test above would also pass for a reader that ignored localStorage
      // entirely and returned the default forever — a toggle that never takes.
      localStorage.setItem(APP_SETTINGS_KEYS[name], "true");
      expect(readAppSettingBoolean(name)).toBe(true);
      localStorage.setItem(APP_SETTINGS_KEYS[name], "false");
      expect(readAppSettingBoolean(name)).toBe(false);
    },
  );

  it.each(BOOLEAN_SETTINGS)(
    "%s: a corrupt value reads as false, never as a throw",
    (name) => {
      // `readBoolean`'s long-standing posture: anything present that is not the literal "true" is
      // false. Pinned here so «absent» and «garbage» stay DIFFERENT answers — absent is the
      // default, garbage is off. Collapsing them would re-introduce the bug in the other polarity.
      localStorage.setItem(APP_SETTINGS_KEYS[name], "yes-please");
      expect(readAppSettingBoolean(name)).toBe(false);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────
// The STRUCTURAL half: nobody reads these keys behind the shared reader's back.
// ─────────────────────────────────────────────────────────────────────────

/** Every TypeScript source under `gui-pro/src`, as raw text. Root-absolute keys (`/src/…`). */
const ALL_SOURCES = {
  ...import.meta.glob("/src/**/*.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("/src/**/*.tsx", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
} as Record<string, string>;

/**
 * The ONE module allowed to touch these keys directly — it is the shared reader's own home, and
 * the place `APP_SETTINGS_DEFAULTS` is applied.
 */
const READER_MODULE = "/src/shared/hooks/useAppSettings.ts";

/** Tests may set/read the raw keys freely — that is how they arrange the world they assert on. */
const isTestOrStory = (path: string) =>
  /\.test\.tsx?$/.test(path) ||
  /\.stories\.tsx?$/.test(path) ||
  /(^|\/)_story\//.test(path);

/**
 * The literal key strings. Naming `APP_SETTINGS_KEYS` in any form counts too — dotted
 * (`APP_SETTINGS_KEYS.masterOn`) AND indexed (`APP_SETTINGS_KEYS[name]`), because both hand a
 * consumer the key without the default that belongs to it.
 *
 * The indexed form was missed by an earlier draft of this file, and the self-check below is what
 * found it: pointed at `useAppSettings.ts` — whose `classifyStoredAppSetting` uses exactly that
 * form — the detector reported nothing.
 */
const KEY_LITERALS = Object.values(APP_SETTINGS_KEYS) as string[];

/** Every `localStorage.getItem(<arg>)` call, with its argument text captured. */
const GET_ITEM_RE = /localStorage\.getItem\(\s*([^)]*?)\s*\)/g;

/**
 * Blank out comments, preserving newlines so reported line numbers stay true.
 *
 * Unlike the release-coupling gate — which scans comments too, on the reasoning that a
 * commented-out import is a paste away from a real one — this check MUST ignore prose. The comment
 * at the fixed call site quotes the very expression it replaced
 * (`localStorage.getItem("tt_auto_connect")`) because that is what makes the comment worth reading,
 * and a check that forbade explaining the defect would be a check that punishes documenting it.
 *
 * Blunt about one thing: a `//` inside a string literal (a URL) ends the line early. That could
 * only hide a violation written to the RIGHT of a URL on the same line, and the self-check below
 * proves the detector still fires after stripping.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");

/** Every direct read of a settings key in `source`, as `file:line — explanation` strings. */
function findDirectReads(path: string, source: string): string[] {
  const found: string[] = [];
  const code = stripComments(source);

  for (const match of code.matchAll(GET_ITEM_RE)) {
    const arg = match[1];
    const named = KEY_LITERALS.some((key) => arg.includes(key));
    const viaKeyMap = arg.includes("APP_SETTINGS_KEYS");
    if (!named && !viaKeyMap) continue;

    // Report the line so the failure names the exact site, not just the file.
    const line = code.slice(0, match.index).split("\n").length;
    found.push(
      `${path}:${line} — localStorage.getItem(${arg}) reads a settings key directly; ` +
        `use readAppSettingBoolean() so «absent» means APP_SETTINGS_DEFAULTS`,
    );
  }
  return found;
}

describe("app settings — no consumer reads a settings key behind the shared reader's back", () => {
  it("scanned a plausible number of source files (guards against a vacuous scan)", () => {
    // A glob that silently matched nothing would make the violation check below pass forever.
    expect(Object.keys(ALL_SOURCES).length).toBeGreaterThan(100);
    expect(ALL_SOURCES[READER_MODULE]).toBeDefined();
  });

  it("still DETECTS a direct read after comment-stripping (guards against a blind detector)", () => {
    // The detector is pointed at the one module that legitimately contains direct reads — the
    // reader's own home, which the sweep skips by name. If comment-stripping (or a regex edit)
    // ever blinded it, this fires here instead of the sweep below silently going green forever.
    expect(findDirectReads(READER_MODULE, ALL_SOURCES[READER_MODULE]).length).toBeGreaterThan(0);

    // …and it must not be fooled by prose: the same call inside a comment is not a call.
    expect(
      findDirectReads("/fake.ts", '// localStorage.getItem("tt_auto_connect")\n'),
    ).toEqual([]);
    expect(
      findDirectReads("/fake.ts", 'const x = localStorage.getItem("tt_auto_connect");\n'),
    ).toHaveLength(1);
    // Both ways of naming the key map, since either one hands over a key without its default.
    expect(
      findDirectReads("/fake.ts", "localStorage.getItem(APP_SETTINGS_KEYS.masterOn);\n"),
    ).toHaveLength(1);
    expect(
      findDirectReads("/fake.ts", "localStorage.getItem(APP_SETTINGS_KEYS[name]);\n"),
    ).toHaveLength(1);
  });

  it("finds no direct localStorage read of an APP_SETTINGS_KEYS key outside useAppSettings.ts", () => {
    const violations = Object.entries(ALL_SOURCES)
      .filter(([path]) => path !== READER_MODULE && !isTestOrStory(path))
      .flatMap(([path, source]) => findDirectReads(path, source));

    expect(violations).toEqual([]);
  });
});
