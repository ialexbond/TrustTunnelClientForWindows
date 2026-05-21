import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWelcomeTour } from "./useWelcomeTour";

describe("useWelcomeTour", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("initial state: completed === false when localStorage пустой", () => {
    const { result } = renderHook(() => useWelcomeTour());
    expect(result.current.completed).toBe(false);
  });

  it("initial state: completed === true когда tt_welcome_completed === \"true\"", () => {
    localStorage.setItem("tt_welcome_completed", "true");
    const { result } = renderHook(() => useWelcomeTour());
    expect(result.current.completed).toBe(true);
  });

  it("complete() пишет localStorage И обновляет state", () => {
    const { result } = renderHook(() => useWelcomeTour());
    expect(result.current.completed).toBe(false);

    act(() => {
      result.current.complete();
    });

    expect(result.current.completed).toBe(true);
    expect(localStorage.getItem("tt_welcome_completed")).toBe("true");
  });

  it("reset() удаляет localStorage ключ И сбрасывает state в false", () => {
    localStorage.setItem("tt_welcome_completed", "true");
    const { result } = renderHook(() => useWelcomeTour());
    expect(result.current.completed).toBe(true);

    act(() => {
      result.current.reset();
    });

    expect(result.current.completed).toBe(false);
    expect(localStorage.getItem("tt_welcome_completed")).toBeNull();
  });

  it("complete() вызывает localStorage.setItem с literal \"true\"", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => useWelcomeTour());

    act(() => {
      result.current.complete();
    });

    expect(setItemSpy).toHaveBeenCalledWith("tt_welcome_completed", "true");
  });

  it("различает варианты \"true\" (только literal \"true\" считается completed)", () => {
    // Любые отличные от literal "true" значения — completed === false.
    // Соответствует паттерну tt_auth_method_<host> из CLAUDE.md.
    const variants = ["True", "TRUE", "1", "yes", "false", ""];
    for (const variant of variants) {
      localStorage.setItem("tt_welcome_completed", variant);
      const { result } = renderHook(() => useWelcomeTour());
      expect(result.current.completed, `variant "${variant}" should be false`).toBe(false);
    }
  });

  it("reset() вызывает localStorage.removeItem", () => {
    localStorage.setItem("tt_welcome_completed", "true");
    const removeItemSpy = vi.spyOn(Storage.prototype, "removeItem");
    const { result } = renderHook(() => useWelcomeTour());

    act(() => {
      result.current.reset();
    });

    expect(removeItemSpy).toHaveBeenCalledWith("tt_welcome_completed");
  });
});
