import { describe, it, expect } from "vitest";
import type { TFunction } from "i18next";
import { translatePathError } from "./translatePathError";
import i18n from "../i18n";

// Same mock shape as translateSshError.test.ts: echo the key back, and append the
// interpolation object when one was passed. Asserting the KEY (not the Russian
// sentence) keeps this test from becoming a duplicate of ru.json — the copy is
// allowed to be reworded without turning this file red.
const mockT = ((key: string, params?: Record<string, string>) => {
  if (params) return `${key}:${JSON.stringify(params)}`;
  return key;
}) as TFunction;

describe("translatePathError", () => {
  // ─── The three codes from commands/paths.rs::validate_copy_source (plan 25-01) ───

  it("translates COPY_SOURCE_OUTSIDE_ROOTS", () => {
    expect(translatePathError("COPY_SOURCE_OUTSIDE_ROOTS", mockT)).toBe(
      "pathErrors.sourceOutsideRoots",
    );
  });

  it("translates COPY_SOURCE_REPARSE_POINT to its OWN sentence, not the generic one", () => {
    const reparse = translatePathError("COPY_SOURCE_REPARSE_POINT", mockT);
    expect(reparse).toBe("pathErrors.sourceReparsePoint");
    // Distinctness matters: a symlink refusal and an outside-roots refusal are
    // different situations for the user, so they must not collapse into one key.
    expect(reparse).not.toBe(translatePathError("COPY_SOURCE_OUTSIDE_ROOTS", mockT));
  });

  it("translates COPY_SOURCE_UNRESOLVABLE and does NOT leak the io detail into the copy", () => {
    // The code arrives as `CODE|{io error}`, but the user-facing sentence carries no
    // detail — an io error string is noise to a non-technical reader here.
    expect(
      translatePathError("COPY_SOURCE_UNRESOLVABLE|The system cannot find the file", mockT),
    ).toBe("pathErrors.sourceUnresolvable");
  });

  // ─── The copy failure from commands/config.rs::copy_file (plan 25-01) ───

  it("translates COPY_FAILED and passes the detail through as an interpolation value", () => {
    expect(translatePathError("COPY_FAILED|Access is denied. (os error 5)", mockT)).toBe(
      'pathErrors.copyFailed:{"detail":"Access is denied. (os error 5)"}',
    );
  });

  it("translates COPY_FAILED with an empty detail without producing undefined", () => {
    expect(translatePathError("COPY_FAILED", mockT)).toBe('pathErrors.copyFailed:{"detail":""}');
  });

  it("IN-03: keeps a detail that itself contains a pipe instead of truncating it", () => {
    // The detail is an io string the Rust side does not author, so it can contain anything.
    // `split("|")[1]` kept only the first segment and silently dropped the rest of the very
    // sentence that tells the user what went wrong.
    expect(translatePathError("COPY_FAILED|drive R:\\ | not ready", mockT)).toBe(
      'pathErrors.copyFailed:{"detail":"drive R:\\\\ | not ready"}',
    );
  });

  // ─── Input shapes: catch blocks hand us `unknown` ───

  it("unwraps an Error whose message is a code, identically to the bare string", () => {
    expect(translatePathError(new Error("COPY_SOURCE_OUTSIDE_ROOTS"), mockT)).toBe(
      translatePathError("COPY_SOURCE_OUTSIDE_ROOTS", mockT),
    );
  });

  // ─── Fallback: anything unmapped keeps today's behaviour ───

  it("returns an unrecognised string unchanged", () => {
    expect(translatePathError("some other backend failure", mockT)).toBe(
      "some other backend failure",
    );
  });

  // T-41(b): this used to assert the bare English `"Unknown error"` — the assertion
  // encoded the bug. `formatError`'s fallback is now claimed here at the presentation
  // boundary, so a thrown non-Error/non-string reaches the user in their language.
  it("localizes formatError's fallback for a non-string, non-Error value", () => {
    // Still guarantees the snackbar can never receive undefined.
    expect(translatePathError(42, mockT)).toBe("commonErrors.unknown");
    expect(translatePathError(null, mockT)).toBe("commonErrors.unknown");
    expect(translatePathError({ code: 7 }, mockT)).toBe("commonErrors.unknown");
  });

  // ─── The frontend-stamped save-dialog code (T-41a) ───

  it("translates SAVE_DIALOG_FAILED and does NOT leak the plugin's English detail", () => {
    expect(
      translatePathError("SAVE_DIALOG_FAILED|dialog plugin unavailable", mockT),
    ).toBe("pathErrors.saveDialogFailed");
  });

  it("translates SAVE_DIALOG_FAILED with no detail at all", () => {
    expect(translatePathError("SAVE_DIALOG_FAILED", mockT)).toBe(
      "pathErrors.saveDialogFailed",
    );
  });

  // The dialog refusing to open and the copy failing are different situations for
  // the user, so they must not collapse into one sentence.
  it("keeps SAVE_DIALOG_FAILED distinct from the copy failure", () => {
    expect(translatePathError("SAVE_DIALOG_FAILED", mockT)).not.toBe(
      translatePathError("COPY_FAILED", mockT),
    );
  });
});

// The mock `t` above proves the KEY is picked; these prove the keys actually exist
// in ru.json and resolve to Russian. Without this a typo'd key would render as the
// key path itself and the mocked tests would still be green.
describe("translatePathError — resolved through the real RU catalogue", () => {
  it.each([
    ["SAVE_DIALOG_FAILED|dialog plugin unavailable", "dialog plugin unavailable"],
    ["COPY_SOURCE_OUTSIDE_ROOTS", "COPY_SOURCE_OUTSIDE_ROOTS"],
  ])("%s renders as Russian prose", (raw, leak) => {
    i18n.changeLanguage("ru");
    const msg = translatePathError(raw, i18n.t);

    expect(msg).toMatch(/[А-Яа-я]/);
    expect(msg).not.toContain(leak);
    expect(msg).not.toMatch(/^pathErrors\./);
  });

  it("renders the non-Error, non-string fallback as Russian prose", () => {
    i18n.changeLanguage("ru");
    const msg = translatePathError({ unexpected: true }, i18n.t);

    expect(msg).toBe(i18n.t("commonErrors.unknown"));
    expect(msg).toMatch(/[А-Яа-я]/);
    expect(msg).not.toContain("Unknown error");
    expect(msg).not.toMatch(/^commonErrors\./);
  });
});
