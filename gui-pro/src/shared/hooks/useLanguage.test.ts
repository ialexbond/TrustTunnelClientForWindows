import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import "../../test/tauri-mock";
import { invoke } from "@tauri-apps/api/core";
import { useLanguage } from "./useLanguage";

// `../../test/tauri-mock` replaces `@tauri-apps/api/core` `invoke` with a vi.fn() — grab the typed
// mock so the plate-language mirror pushes can be asserted (review #13; mirrors the
// useAppSettings `set_notifications_enabled` mirror-test pattern).
const mockInvoke = vi.mocked(invoke);

// Mock react-i18next
const mockChangeLanguage = vi.fn();
let mockLanguage = "en";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    i18n: {
      get language() { return mockLanguage; },
      changeLanguage: mockChangeLanguage,
    },
  }),
}));

// Mock @tauri-apps/api/event
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockLanguage = "en";
  localStorage.clear();
});

describe("useLanguage", () => {
  it("returns i18n object and handler functions", () => {
    const { result } = renderHook(() => useLanguage());

    expect(result.current.i18n).toBeDefined();
    expect(result.current.handleLanguageChange).toBeInstanceOf(Function);
    expect(result.current.toggleLanguage).toBeInstanceOf(Function);
  });

  it("handleLanguageChange calls i18n.changeLanguage and saves to localStorage", () => {
    const { result } = renderHook(() => useLanguage());

    act(() => {
      result.current.handleLanguageChange("ru");
    });

    expect(mockChangeLanguage).toHaveBeenCalledWith("ru");
    expect(localStorage.getItem("tt_language")).toBe("ru");
  });

  it("toggleLanguage switches from en to ru", () => {
    mockLanguage = "en";
    const { result } = renderHook(() => useLanguage());

    act(() => {
      result.current.toggleLanguage();
    });

    expect(mockChangeLanguage).toHaveBeenCalledWith("ru");
    expect(localStorage.getItem("tt_language")).toBe("ru");
  });

  it("toggleLanguage switches from ru to en", () => {
    mockLanguage = "ru";
    const { result } = renderHook(() => useLanguage());

    act(() => {
      result.current.toggleLanguage();
    });

    expect(mockChangeLanguage).toHaveBeenCalledWith("en");
    expect(localStorage.getItem("tt_language")).toBe("en");
  });
});

// Phase 13 (13-07) regression tests — the FE→Rust plate-language mirror (review #13). The plate is
// a separate webview with an empty localStorage, so `useLanguage` mirrors the UI language into the
// Rust plate-language cell (`set_plate_language`); this exact link was behind the UAT round-3
// defect (Russian plate on the English app language) and had zero test assertions.
describe("useLanguage — FE→Rust plate-language mirror (set_plate_language)", () => {
  it("pushes {language:'en'} on mount for an 'en' i18n language", () => {
    mockLanguage = "en";
    renderHook(() => useLanguage());

    expect(mockInvoke).toHaveBeenCalledWith("set_plate_language", { language: "en" });
  });

  it("normalizes a region locale ('en-US') to the 2-value whitelist ('en')", () => {
    mockLanguage = "en-US";
    renderHook(() => useLanguage());

    expect(mockInvoke).toHaveBeenCalledWith("set_plate_language", { language: "en" });
  });

  it("pushes {language:'ru'} for the Russian i18n language", () => {
    mockLanguage = "ru";
    renderHook(() => useLanguage());

    expect(mockInvoke).toHaveBeenCalledWith("set_plate_language", { language: "ru" });
  });

  it("coerces any non-'en' language ('de') to 'ru' — the whitelist fallback", () => {
    mockLanguage = "de";
    renderHook(() => useLanguage());

    expect(mockInvoke).toHaveBeenCalledWith("set_plate_language", { language: "ru" });
  });

  it("re-pushes when the i18n language changes (en → ru)", () => {
    mockLanguage = "en";
    const { rerender } = renderHook(() => useLanguage());
    expect(mockInvoke).toHaveBeenCalledWith("set_plate_language", { language: "en" });

    mockInvoke.mockClear();
    mockLanguage = "ru";
    rerender();

    expect(mockInvoke).toHaveBeenCalledWith("set_plate_language", { language: "ru" });
  });
});
