import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import "../../test/tauri-mock";
import { useFeatureToggles } from "./useFeatureToggles";

const STORAGE_KEY = "tt_feature_toggles";

describe("useFeatureToggles", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns default toggles when no localStorage", () => {
    const { result } = renderHook(() => useFeatureToggles());
    expect(result.current.toggles).toEqual({
      blockRouting: false,
    });
  });

  it("update() updates the toggle value", () => {
    const { result } = renderHook(() => useFeatureToggles());

    act(() => {
      result.current.update("blockRouting", true);
    });

    expect(result.current.toggles.blockRouting).toBe(true);
  });

  it("persists to localStorage after update", () => {
    const { result } = renderHook(() => useFeatureToggles());

    act(() => {
      result.current.update("blockRouting", true);
    });

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored.blockRouting).toBe(true);
  });

  it("loads persisted values from localStorage on init", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ blockRouting: true }),
    );

    const { result } = renderHook(() => useFeatureToggles());
    expect(result.current.toggles).toEqual({
      blockRouting: true,
    });
  });

  it("falls back to defaults when localStorage contains corrupted JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not valid json!!!");

    const { result } = renderHook(() => useFeatureToggles());
    expect(result.current.toggles).toEqual({
      blockRouting: false,
    });
  });

  it("CustomEvent 'feature-toggles-changed' syncs between hook instances", () => {
    const { result: hookA } = renderHook(() => useFeatureToggles());
    const { result: hookB } = renderHook(() => useFeatureToggles());

    // Update via hookA — this dispatches the custom event
    act(() => {
      hookA.current.update("blockRouting", true);
    });

    // hookB should have picked up the change via the event listener
    expect(hookB.current.toggles.blockRouting).toBe(true);
  });
});
