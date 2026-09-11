import { describe, it, expect } from "vitest";
import { parseReleaseNotes } from "./parseReleaseNotes";

// Vite raw import — loaded at bundle time, no Node.js fs required. Vitest resolves the same query,
// so these cases run against the SHIPPED bytes of the notes file rather than a duplicated fixture
// that would silently drift away from it the first time the file is edited.
import realNotes from "../release-notes/RELEASE_NOTES.ru.md?raw";

/**
 * Multi-section samples are hand-written rather than lifted from the real file: the real file has
 * exactly one section by design (no pre-3.0.0 history), so ordering and prefix-collision can only be
 * exercised on a synthetic input.
 */
const TWO_SECTIONS = [
  "## Версия 4.1.0",
  "",
  "- новая версия сверху",
  "",
  "## Версия 4.0.0",
  "",
  "- старая версия снизу",
  "",
].join("\n");

const PREFIX_COLLISION = [
  "## Версия 3.0",
  "",
  "- короткий номер",
  "",
  "## Версия 3.0.0",
  "",
  "- длинный номер",
  "",
].join("\n");

const EMPTY_BODY = ["## Версия 2.0.0", "", "   ", "\t", "", "## Версия 1.0.0", "", "- есть текст", ""].join("\n");

describe("parseReleaseNotes", () => {
  it("returns the real 3.0.0 section with its heading stripped and edges trimmed", () => {
    const body = parseReleaseNotes(realNotes, "3.0.0");

    expect(body).toBeTruthy();
    expect(body!.startsWith("## ")).toBe(false);
    expect(body).toBe(body!.trim());
    // The window draws «Версия 3.0.0» itself, so the number must not come back inside the body.
    expect(body).not.toMatch(/^##\s+Версия/m);
    expect(body).toContain("Панель управления");
  });

  it("returns null for a version that has no section", () => {
    expect(parseReleaseNotes(realNotes, "9.9.9")).toBeNull();
  });

  it("matches only on the full exact version string — a prefix never satisfies a longer version", () => {
    // Against the real file (only 3.0.0 exists): the shorter number must not borrow the longer one.
    expect(parseReleaseNotes(realNotes, "3.0")).toBeNull();
    expect(parseReleaseNotes(realNotes, "3.0.0")).toBeTruthy();

    // And the other way round, against a file that carries both headings.
    expect(parseReleaseNotes(PREFIX_COLLISION, "3.0")).toBe("- короткий номер");
    expect(parseReleaseNotes(PREFIX_COLLISION, "3.0.0")).toBe("- длинный номер");
  });

  it("returns null — not an empty string — for a section whose body is whitespace only", () => {
    // null is the no-notes plate; an empty string would render an empty section, which is the one
    // outcome the design refuses (a version heading with nothing under it).
    expect(parseReleaseNotes(EMPTY_BODY, "2.0.0")).toBeNull();
    expect(parseReleaseNotes(EMPTY_BODY, "1.0.0")).toBe("- есть текст");
  });

  it("does not depend on section order — the last section parses like the first", () => {
    expect(parseReleaseNotes(TWO_SECTIONS, "4.1.0")).toBe("- новая версия сверху");
    expect(parseReleaseNotes(TWO_SECTIONS, "4.0.0")).toBe("- старая версия снизу");

    // Same two sections, oldest first: each version still yields its own body.
    const reversed = ["## Версия 4.0.0", "", "- старая версия снизу", "", "## Версия 4.1.0", "", "- новая версия сверху", ""].join("\n");
    expect(parseReleaseNotes(reversed, "4.1.0")).toBe(parseReleaseNotes(TWO_SECTIONS, "4.1.0"));
    expect(parseReleaseNotes(reversed, "4.0.0")).toBe(parseReleaseNotes(TWO_SECTIONS, "4.0.0"));
  });

  it("round-trips Cyrillic unchanged — the body is a verbatim slice of the raw input", () => {
    const body = parseReleaseNotes(realNotes, "3.0.0")!;

    expect(realNotes).toContain(body);
    expect(realNotes.slice(realNotes.indexOf(body), realNotes.indexOf(body) + body.length)).toBe(body);
    // «ё» and ««»» are the characters a broken encoding mangles first. The anchors are picked for
    // those characters, not for their wording — when the notes are rewritten, repoint them at any
    // surviving phrase that still carries «ё» and the guillemets.
    expect(body).toContain("светлая и тёмная темы");
    expect(body).toContain("«подключено»");
  });

  it("is idempotent — parsing the same input twice returns identical results", () => {
    expect(parseReleaseNotes(realNotes, "3.0.0")).toBe(parseReleaseNotes(realNotes, "3.0.0"));
    expect(parseReleaseNotes(TWO_SECTIONS, "4.0.0")).toBe(parseReleaseNotes(TWO_SECTIONS, "4.0.0"));
  });
});
