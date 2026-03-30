import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLanguage } from "./useLanguage";

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
