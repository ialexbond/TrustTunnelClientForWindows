import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ru from "./locales/ru.json";

// G-03.1-7 (plan 03.1-11) — the texts for a failed WinTUN adapter (errors.wintun_missing) and a
// failed tunnel start (errors.listener_failed).
//
// The old texts sent the user to «run as administrator» and to look for wintun.dll. Both were
// false leads: the app always runs elevated, and the WintunCreateAdapter call itself proves
// wintun.dll loaded. The advice about wintun.dll is also the kind that invites downloading a DLL
// from an unknown site (T-3.1-47). The texts now say what happened and what helps.
//
// errors.adapter_timeout was removed: its trigger line «Failed to setup adapter» is not printed
// anywhere in the core sources, so nothing could ever show it.

const FALSE_ADVICE = /администратор|administrator|wintun/i;

const EXPECTED = {
  ru: {
    wintun_missing:
      "Windows не создала сетевой адаптер VPN. Подключитесь ещё раз; если ошибка повторяется — перезагрузите компьютер.",
    listener_failed:
      "Не удалось запустить VPN-туннель. Подключитесь ещё раз; если ошибка повторяется — перезагрузите компьютер.",
  },
  en: {
    wintun_missing:
      "Windows did not create the VPN network adapter. Connect again; if it keeps happening, restart your computer.",
    listener_failed:
      "Could not start the VPN tunnel. Connect again; if it keeps happening, restart your computer.",
  },
} as const;

const LOCALES = { ru: ru.errors, en: en.errors } as const;
const KEYS = ["wintun_missing", "listener_failed"] as const;

describe("adapter / tunnel error texts (G-03.1-7)", () => {
  for (const lang of ["ru", "en"] as const) {
    for (const key of KEYS) {
      it(`${lang} errors.${key} is the honest text`, () => {
        expect(LOCALES[lang][key]).toBe(EXPECTED[lang][key]);
      });

      it(`${lang} errors.${key} does not advise administrator rights or wintun.dll`, () => {
        expect(LOCALES[lang][key]).not.toMatch(FALSE_ADVICE);
      });
    }
  }

  it("ru texts say what helps: restart the computer", () => {
    for (const key of KEYS) {
      expect(ru.errors[key]).toContain("перезагрузите компьютер");
    }
  });

  it("en texts say what helps: restart your computer", () => {
    for (const key of KEYS) {
      expect(en.errors[key]).toContain("restart your computer");
    }
  });

  it("wintun_missing names Windows and the adapter in both locales", () => {
    expect(ru.errors.wintun_missing).toMatch(/Windows/);
    expect(ru.errors.wintun_missing).toMatch(/адаптер/);
    expect(en.errors.wintun_missing).toMatch(/Windows/);
    expect(en.errors.wintun_missing).toMatch(/adapter/);
  });

  it("the dead key errors.adapter_timeout is gone from both locales", () => {
    expect("adapter_timeout" in ru.errors).toBe(false);
    expect("adapter_timeout" in en.errors).toBe(false);
  });
});
