import { describe, it, expect, beforeEach } from "vitest";
import { documentLangFor, stampDocumentLang } from "./documentLang";

describe("documentLangFor (MR3-03 / D-16)", () => {
  it("maps 'ru' and region variants to 'ru'", () => {
    expect(documentLangFor("ru")).toBe("ru");
    expect(documentLangFor("ru-RU")).toBe("ru");
  });

  it("maps 'en' and region variants to 'en'", () => {
    expect(documentLangFor("en")).toBe("en");
    expect(documentLangFor("en-US")).toBe("en");
  });

  it("maps anything else to 'ru' (the app's primary language) — same rule as useLanguage's plate mirror", () => {
    expect(documentLangFor("de")).toBe("ru");
    expect(documentLangFor(undefined)).toBe("ru");
    expect(documentLangFor("")).toBe("ru");
  });
});

describe("stampDocumentLang", () => {
  beforeEach(() => {
    document.documentElement.lang = "";
  });

  it("sets document.documentElement.lang from the resolved language", () => {
    stampDocumentLang("en");
    expect(document.documentElement.lang).toBe("en");
    stampDocumentLang("ru");
    expect(document.documentElement.lang).toBe("ru");
  });

  it("resolves through documentLangFor, not the raw i18next tag", () => {
    stampDocumentLang("en-US");
    expect(document.documentElement.lang).toBe("en");
  });
});
