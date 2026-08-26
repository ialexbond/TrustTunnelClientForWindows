import { describe, it, expect, beforeEach } from "vitest";
import i18n from "../i18n";
import { REASON_CODE_I18N, CORE_MESSAGE_I18N, makeLocalizeError } from "./vpnEventHelpers";

// Phase 28 (28-03, D-05) — the exhausted-queue verdict is its OWN sentence.
//
// The backend never sends prose: it sets a terminal Error carrying a stable ASCII reason code and
// this map turns it into a localized message at the presentation boundary (T-28-13). 28-02 minted
// `failover-exhausted` as a code DISTINCT from `reconnect-gave-up` precisely so «этот сервер не
// вернулся» and «ни один сервер не ответил» cannot collapse into one message — that distinction is
// only real once the map keeps them apart too.

describe("vpnEventHelpers — reason-code localization", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
  });

  it("maps the exhausted-queue code to its own key, not the reconnect-gave-up one", () => {
    // The exact token `connectivity::FAILOVER_EXHAUSTED_REASON` writes.
    expect(REASON_CODE_I18N["failover-exhausted"]).toBe("errors.failover_exhausted");
    // …and the one-server give-up keeps its own key. Two failures, two messages.
    expect(REASON_CODE_I18N["reconnect-gave-up"]).toBe("errors.reconnect_gave_up");
    expect(REASON_CODE_I18N["failover-exhausted"]).not.toBe(REASON_CODE_I18N["reconnect-gave-up"]);
  });

  it("renders the exhausted queue as a plain Russian statement that no server answered", () => {
    const localize = makeLocalizeError(i18n);
    const text = localize("failover-exhausted");

    // Not the raw token — the whole point of the map (D-29: the user never sees wire codes).
    expect(text).not.toBe("failover-exhausted");
    expect(text).toBeTruthy();
    // The honest sentence D-05 names: none of the servers answered.
    expect(text).toMatch(/ни один/i);
    expect(text).toMatch(/сервер/i);
    // And it is a DIFFERENT sentence from the single-server give-up.
    expect(text).not.toBe(localize("reconnect-gave-up"));
  });

  it("mirrors the key in English", () => {
    i18n.changeLanguage("en");
    const localize = makeLocalizeError(i18n);
    const text = localize("failover-exhausted");
    expect(text).not.toBe("failover-exhausted");
    expect(text).not.toBe(localize("reconnect-gave-up"));
    i18n.changeLanguage("ru");
  });

  it("leaves an unknown code and a null error exactly as they arrive (the SAFETY-03 seam)", () => {
    const localize = makeLocalizeError(i18n);
    // An older sanitized backend message still renders verbatim rather than vanishing.
    expect(localize("some-code-nobody-mapped")).toBe("some-code-nobody-mapped");
    expect(localize(null)).toBeNull();
    expect(localize(undefined)).toBeNull();
  });

  it("still localizes the pre-existing reason codes and fixed core phrases", () => {
    const localize = makeLocalizeError(i18n);
    // A regression here would mean the new entry displaced an existing one.
    for (const code of Object.keys(REASON_CODE_I18N)) {
      expect(localize(code)).not.toBe(code);
    }
    for (const phrase of Object.keys(CORE_MESSAGE_I18N)) {
      expect(localize(phrase)).not.toBe(phrase);
    }
  });
});
