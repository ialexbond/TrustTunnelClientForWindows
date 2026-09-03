import { describe, it, expect, beforeEach } from "vitest";
import i18n from "../i18n";
import {
  REASON_CODE_I18N,
  CORE_MESSAGE_I18N,
  makeLocalizeError,
  localizeVpnError,
} from "./vpnEventHelpers";

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

  it("names the routing-rules file as the cause, in Russian, and points at the routing screen", () => {
    // D-02 (30.1 blocker 2). The backend now refuses the connect when `routing_rules.json` cannot
    // be parsed. The refusal is worth nothing if it reaches the user as the token — this is the
    // row that turns it into a sentence somebody can act on.
    i18n.changeLanguage("ru");
    const localize = makeLocalizeError(i18n);
    const text = localize("routing-rules-unreadable");

    expect(text).not.toBe("routing-rules-unreadable");
    // Russian, not the English serde message and not a passthrough token.
    expect(text).toMatch(/[а-яё]/i);
    // It must name the CAUSE (the routing rules) rather than say «что-то пошло не так», and point
    // at the screen that owns the recovery — the reset lives where the rules live, not on the
    // connect-failure surface.
    expect(text).toMatch(/маршрутизац/i);
    // Distinct from every neighbouring failure: sending somebody to check their servers when
    // their rule file is the broken thing is the wrong screen with a confident voice.
    expect(text).not.toBe(localize("reconnect-gave-up"));
    expect(text).not.toBe(localize("failover-exhausted"));
    expect(text).not.toBe(localize("sidecar-exit"));
  });

  it("does not leak the parser's own text — the code is the whole payload", () => {
    // D-09/D-29: the serde error is English and unbounded (it can quote the file). The map keys
    // off a fixed token, so anything carrying parser detail stays unmapped and is NOT dressed up
    // as a localized message.
    const localize = makeLocalizeError(i18n);
    const raw = "Failed to parse routing_rules.json: expected `,` at line 12 column 3";
    expect(localize(raw)).toBe(raw);
  });

  // ─── 30.1 regression defect 1: a refused connect names the FILE, not the server ───
  //
  // The path-confinement guard refuses a `.toml` that is not inside the app's data folder. It
  // used to pass `None` as the reason, and `None` renders the generic «Не удалось выполнить
  // подключение к серверу» — a sentence that blames a server the app never contacted. The
  // owner saw it six times in six seconds while the actual problem was a file in the wrong
  // folder. These tests pin that the code exists, that it renders its OWN sentence, and that
  // the sentence is not the generic fallback.

  it("maps the path-refusal code to its own key, distinct from the generic connection failure", () => {
    // The exact token `lifecycle::CONFIG_OUTSIDE_DATA_DIR_REASON` writes.
    expect(REASON_CODE_I18N["config-outside-data-dir"]).toBe("errors.config_outside_data_dir");
    // The generic fallback the refusal used to render has its own separate key, and the two must
    // never converge: one says «the server did not answer», the other «the file is in the wrong
    // place». Collapsing them re-creates the defect with an i18n key in front of it.
    expect(REASON_CODE_I18N["config-outside-data-dir"]).not.toBe("errors.connection_failed");
  });

  it("renders the path refusal as a Russian sentence about the FILE, never the generic server failure", () => {
    const localize = makeLocalizeError(i18n);
    const text = localize("config-outside-data-dir");

    // Not the raw token (D-29: the user never sees wire codes).
    expect(text).not.toBe("config-outside-data-dir");
    // Nor the guard's English sentence, which used to reach the red banner verbatim.
    expect(text).not.toMatch(/Access denied/i);
    // It names the config FILE as the subject — the real cause.
    expect(text).toMatch(/конфиг/i);
    expect(text).toMatch(/папк/i);
    // And it is NOT the generic «Не удалось подключиться к серверу» this used to fall back to.
    expect(text).not.toBe(i18n.t("errors.connection_failed"));
  });

  it("mirrors the path-refusal key in English", () => {
    i18n.changeLanguage("en");
    const text = makeLocalizeError(i18n)("config-outside-data-dir");
    expect(text).not.toBe("config-outside-data-dir");
    expect(text).toMatch(/configuration file/i);
    i18n.changeLanguage("ru");
  });

  it("localizes the SAME code on the rejected-command channel, not only on the status event", () => {
    // The refusal reaches the user twice: as a terminal Error status (localizeError above) and as
    // the rejected promise of `invoke("vpn_connect")`, which every catch block used to render with
    // a bare `formatError`. Both channels now carry the same code, so both must resolve to the same
    // Russian sentence — a fix on one channel alone shows Russian in the snackbar and a raw ASCII
    // token in the red banner.
    const viaStatus = makeLocalizeError(i18n)("config-outside-data-dir");
    // Guard against the vacuous form of this test: if the code were unmapped, BOTH channels would
    // return the raw token and the equality below would hold while proving nothing.
    expect(viaStatus).not.toBe("config-outside-data-dir");
    // Tauri rejects with the string the command returned; an Error wrapper is the other shape a
    // catch block can receive. Both must land on the same sentence.
    expect(localizeVpnError("config-outside-data-dir", i18n)).toBe(viaStatus);
    expect(localizeVpnError(new Error("config-outside-data-dir"), i18n)).toBe(viaStatus);
  });

  it("passes an unmapped rejection through unchanged (the SAFETY-03 seam)", () => {
    // Every other catch site in the VPN hooks funnels through this helper now, so it must not
    // start swallowing or mangling the errors it does not know: an SSH sentence, a plugin error
    // and a non-string thrown value all keep today's behaviour.
    expect(localizeVpnError("SSH_AUTH_FAILED|bad password", i18n)).toBe("SSH_AUTH_FAILED|bad password");
    expect(localizeVpnError(new Error("boom"), i18n)).toBe("boom");
    expect(localizeVpnError(undefined, i18n)).toBe("Unknown error");
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
