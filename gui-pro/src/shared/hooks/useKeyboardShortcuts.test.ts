import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";

beforeEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe("useKeyboardShortcuts", () => {
  it("Ctrl+1 calls onNavigate with 'control'", () => {
    const onNavigate = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onNavigate }));

    fireEvent.keyDown(document, { key: "1", ctrlKey: true });

    expect(onNavigate).toHaveBeenCalledWith("control");
  });

  it("Ctrl+2 calls onNavigate with 'connection'", () => {
    const onNavigate = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onNavigate }));

    fireEvent.keyDown(document, { key: "2", ctrlKey: true });

    expect(onNavigate).toHaveBeenCalledWith("connection");
  });

  it("Ctrl+3 calls onNavigate with 'routing'", () => {
    const onNavigate = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onNavigate }));

    fireEvent.keyDown(document, { key: "3", ctrlKey: true });

    expect(onNavigate).toHaveBeenCalledWith("routing");
  });

  it("Ctrl+Shift+C calls onToggleConnect", () => {
    const onToggleConnect = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onToggleConnect }));

    fireEvent.keyDown(document, { key: "C", ctrlKey: true, shiftKey: true });

    expect(onToggleConnect).toHaveBeenCalled();
  });

  it("Ctrl+Shift+D calls onToggleTheme", () => {
    const onToggleTheme = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onToggleTheme }));

    fireEvent.keyDown(document, { key: "D", ctrlKey: true, shiftKey: true });

    expect(onToggleTheme).toHaveBeenCalled();
  });

  it("Ctrl+Shift+L calls onToggleLanguage", () => {
    const onToggleLanguage = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onToggleLanguage }));

    fireEvent.keyDown(document, { key: "L", ctrlKey: true, shiftKey: true });

    expect(onToggleLanguage).toHaveBeenCalled();
  });

  it("cleanup removes the event listener", () => {
    const onNavigate = vi.fn();
    const { unmount } = renderHook(() => useKeyboardShortcuts({ onNavigate }));

    unmount();

    fireEvent.keyDown(document, { key: "1", ctrlKey: true });

    expect(onNavigate).not.toHaveBeenCalled();
  });
});
