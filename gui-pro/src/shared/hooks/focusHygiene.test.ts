/**
 * Focus hygiene gate — every `.focus()` in the app must have decided WHO is moving the focus.
 *
 * This exists because of the shape of the defect it closes, not because of the defect itself. A
 * tooltip that outlived its window was fixed three times, once per place it was noticed, and the
 * complaint the fourth time was about exactly that:
 *
 *   «а что, нельзя сразу во всех местах "починить" тултип? а то только на "закрыть" окно пофиксил»
 *
 * He is right. The mechanism is now one rule — a focus the application placed is not a user
 * arriving — but a rule only covers the call sites that use it, and the next dialog, drawer or
 * popover somebody writes will call `.focus()` directly and reintroduce the defect in a place
 * nobody is looking. So it is not left to memory.
 *
 * THE RULE: a line that calls `something.focus()` must either
 *
 *   • go through `placeFocus()` instead — the app is placing this focus, so it says so; or
 *   • carry a `user-navigation:` note, on the line or in the four lines above it, saying why this
 *     focus really is the user moving himself (an arrow key in a tab strip, Tab inside a focus
 *     trap, Backspace walking back through the octets of an address).
 *
 * The note does not prove anything on its own — it makes the author state a claim, at the moment
 * he writes the call, in a place a reviewer will read. That is the whole ambition: this defect
 * survived twice because nobody was asked the question.
 *
 * SCOPE: `gui-pro/src/**` excluding tests, stories and the story tier — a story that focuses
 * something to demonstrate a rule is not shipping behaviour. `usePointerPresence.ts` is excluded
 * because it is where `placeFocus` is defined and therefore where the one honest bare `.focus()`
 * lives.
 *
 * APPROACH mirrors `storybookDocsHygiene.test.ts`: raw text via `import.meta.glob`, never Node
 * `fs`/`path` — this app's tsconfig ships only `vite/client` types, so those would fail typecheck.
 */

import { describe, it, expect } from "vitest";

/** `x.focus()`, `x?.focus()`, `x.current?.focus()` — with or without spaces. */
const FOCUS_CALL = /\.focus\s*\(\s*\)/;

/** The claim an author makes when a bare `.focus()` really is the user moving himself. */
const USER_NAVIGATION_NOTE = "user-navigation:";

/** How far above the call the note may sit. Enough for a sentence of reasoning, not a whole file. */
const NOTE_LOOKBEHIND = 4;

const modules = import.meta.glob("../../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const isScanned = (path: string): boolean =>
  !path.includes(".test.") &&
  !path.includes(".stories.") &&
  !path.includes("/_story/") &&
  // Where `placeFocus` is defined: the one bare `.focus()` that IS the mechanism.
  !path.endsWith("/usePointerPresence.ts");

/**
 * Strip anything that is only a comment, so prose ABOUT `.focus()` is not mistaken for a call.
 * `Modal.tsx` carries such a sentence («`.focus()` is supported in jsdom but `scrollIntoView` is
 * not»), and without this the gate would fail on a line that calls nothing.
 *
 * A leading `//` is NOT tested for here even though it is the commonest case: the slice below
 * already returns `""` for it, and a second copy of a condition is a guard that can never fail.
 * That exact shape was written into the first draft of this file and caught by mutating it away —
 * every check stayed green — which is the same trap the three previous rounds of this defect each
 * fell into once. Block comments need their own clause because `indexOf("//")` cannot see them.
 */
export const codeOnly = (line: string): string => {
  const trimmed = line.trim();
  if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return "";
  const commentAt = line.indexOf("//");
  return commentAt === -1 ? line : line.slice(0, commentAt);
};

interface Offence {
  file: string;
  line: number;
  text: string;
}

/**
 * The rule itself, over one file's text — kept separate from the sweep so it can be handed a
 * sample and asked to REJECT something.
 *
 * That separation is not tidiness. Mutating «require the note» away to «accept everything» left
 * the whole suite green: nothing here tested that the gate says no, only that the tree happens to
 * say yes. A gate with no self-test is the same shape of defect it was written to prevent.
 */
export function scanSource(source: string): { offences: Omit<Offence, "file">[]; callSites: number } {
  const offences: Omit<Offence, "file">[] = [];
  let callSites = 0;
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!FOCUS_CALL.test(codeOnly(line))) return;
    callSites++;
    const context = lines.slice(Math.max(0, index - NOTE_LOOKBEHIND), index + 1).join("\n");
    if (context.includes(USER_NAVIGATION_NOTE)) return;
    offences.push({ line: index + 1, text: line.trim() });
  });
  return { offences, callSites };
}

function scan(): { offences: Offence[]; callSites: number; files: number } {
  const offences: Offence[] = [];
  let callSites = 0;
  let files = 0;

  for (const [path, source] of Object.entries(modules)) {
    if (!isScanned(path)) continue;
    files++;
    const result = scanSource(source);
    callSites += result.callSites;
    for (const o of result.offences) offences.push({ file: path, ...o });
  }
  return { offences, callSites, files };
}

describe("focus hygiene", () => {
  it("does not mistake prose about `.focus()` for a call to it", () => {
    // Asserted through the gate's own predicate rather than on the exact leftover string: what
    // matters is «does this line still look like a call», not how much whitespace survived. The
    // first draft asserted `toBe("")` and went red on a line the gate handles perfectly well.
    const looksLikeACall = (line: string) => FOCUS_CALL.test(codeOnly(line));

    // Real shapes from the tree. Without this the gate reports a sentence as an offence, and an
    // author «fixes» it by annotating a comment.
    expect(looksLikeACall("  // jsdom note: `.focus()` is supported in jsdom")).toBe(false);
    expect(looksLikeACall("   * so `.focus()` dispatches synchronously")).toBe(false);
    expect(looksLikeACall("  /* el.focus() is what a browser does here */")).toBe(false);
    // ...and it still sees a real call that carries its note after it.
    expect(looksLikeACall("      lastEl.focus(); // user-navigation: his Shift+Tab")).toBe(true);
  });

  it("rejects a bare `.focus()` and accepts both ways of answering for one", () => {
    const bare = scanSource("const el = ref.current;\nel.focus();\n");
    expect(bare.callSites).toBe(1);
    expect(bare.offences.map((o) => o.line)).toEqual([2]);

    const answered = scanSource("// user-navigation: his ArrowDown\nel.focus();\n");
    expect(answered.callSites).toBe(1);
    expect(answered.offences).toEqual([]);

    // The other way of answering is not to write a bare `.focus()` at all.
    const placed = scanSource("placeFocus(ref.current);\n");
    expect(placed.callSites).toBe(0);
    expect(placed.offences).toEqual([]);
  });

  it("scans the app, so a glob that matches nothing cannot pass vacuously", () => {
    const { files, callSites } = scan();
    expect(files).toBeGreaterThan(100);
    // A regex that stopped matching would make every assertion below true for the wrong reason.
    expect(callSites).toBeGreaterThan(4);
  });

  it("has no `.focus()` that neither goes through placeFocus nor says why it is the user", () => {
    const { offences } = scan();
    const report = offences.map((o) => `${o.file}:${o.line}  ${o.text}`).join("\n");
    expect(
      report,
      offences.length === 0
        ? ""
        : `A raw .focus() must either use placeFocus() — «the app is placing this focus» — or carry ` +
            `a "${USER_NAVIGATION_NOTE}" note saying why the user really is navigating there:\n${report}`,
    ).toBe("");
  });

  it("routes the dialog focus restore through placeFocus — the site the owner reported", () => {
    const modal = Object.entries(modules).find(([p]) => p.endsWith("/ui/Modal.tsx"))?.[1] ?? "";
    expect(modal).toContain("placeFocus(restoreFocusRef.current)");
  });
});
