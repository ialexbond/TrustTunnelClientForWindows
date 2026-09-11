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

  // Item 6 (30.1 review): these three now carry `code` alongside `key`. That is a FIXTURE
  // correction, not a behaviour change — a real browser delivers both fields on every physical
  // keypress, and these events (a `key` with no `code` at all) were never something a keyboard
  // could produce. For a Latin-layout user the behaviour asserted here is exactly what it was.
  it("Ctrl+Shift+C calls onToggleConnect", () => {
    const onToggleConnect = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onToggleConnect }));

    fireEvent.keyDown(document, { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true });

    expect(onToggleConnect).toHaveBeenCalled();
  });

  it("Ctrl+Shift+D calls onToggleTheme", () => {
    const onToggleTheme = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onToggleTheme }));

    fireEvent.keyDown(document, { key: "D", code: "KeyD", ctrlKey: true, shiftKey: true });

    expect(onToggleTheme).toHaveBeenCalled();
  });

  it("Ctrl+Shift+L calls onToggleLanguage", () => {
    const onToggleLanguage = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onToggleLanguage }));

    fireEvent.keyDown(document, { key: "L", code: "KeyL", ctrlKey: true, shiftKey: true });

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

// ─────────────────────────────────────────────────────────────────────────
// Item 6 (30.1 milestone review) — the Ctrl+Shift shortcuts were dead on the
// Russian layout, which is the layout this app's audience actually types on.
//
// `KeyboardEvent.key` is the CHARACTER the layout produced. Under ЙЦУКЕН the
// physical C key yields «С» (U+0421 CYRILLIC CAPITAL ES), not «C» (U+0043), so
// `e.key.toUpperCase()` matched nothing and all three shortcuts silently did
// nothing. `KeyboardEvent.code` is the PHYSICAL key and is unaffected by layout.
//
// The Latin cases above pass either way — a real browser sends `key` AND `code`
// together, and matching on either one catches them. So the Cyrillic cases below
// are the only evidence that this fix does anything at all.
// ─────────────────────────────────────────────────────────────────────────
describe("useKeyboardShortcuts — item 6 (30.1): the Russian layout fires the same shortcuts", () => {
  it("Ctrl+Shift+C on ЙЦУКЕН (key «С», code KeyC) calls onToggleConnect", () => {
    const onToggleConnect = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onToggleConnect }));

    fireEvent.keyDown(document, { key: "С", code: "KeyC", ctrlKey: true, shiftKey: true });

    expect(onToggleConnect).toHaveBeenCalled();
  });

  it("Ctrl+Shift+D on ЙЦУКЕН (key «В», code KeyD) calls onToggleTheme", () => {
    const onToggleTheme = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onToggleTheme }));

    fireEvent.keyDown(document, { key: "В", code: "KeyD", ctrlKey: true, shiftKey: true });

    expect(onToggleTheme).toHaveBeenCalled();
  });

  it("Ctrl+Shift+L on ЙЦУКЕН (key «Д», code KeyL) calls onToggleLanguage", () => {
    const onToggleLanguage = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onToggleLanguage }));

    fireEvent.keyDown(document, { key: "Д", code: "KeyL", ctrlKey: true, shiftKey: true });

    expect(onToggleLanguage).toHaveBeenCalled();
  });

  it("matches the PHYSICAL key only: a «C» character produced by another key does NOT fire", () => {
    // One rule, not two. Accepting `e.key` as well would make an IME (or any remapped layout)
    // that emits the character «C» from a different physical key toggle the tunnel — a second,
    // different bug wearing the first one's clothes.
    const onToggleConnect = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onToggleConnect }));

    fireEvent.keyDown(document, { key: "C", code: "KeyQ", ctrlKey: true, shiftKey: true });

    expect(onToggleConnect).not.toHaveBeenCalled();
  });

  it("leaves the digit shortcuts alone: Ctrl+1 still fires from the NUMERIC KEYPAD", () => {
    // The digit branch deliberately still parses `e.key`. Digits are layout-independent on both
    // layouts, and `e.code` would be "Digit1" on the number row but "Numpad1" on the keypad —
    // switching that branch to the physical identifier would BREAK the keypad, which works today.
    const onNavigate = vi.fn();
    renderHook(() => useKeyboardShortcuts({ onNavigate }));

    fireEvent.keyDown(document, { key: "1", code: "Numpad1", ctrlKey: true });

    expect(onNavigate).toHaveBeenCalledWith("control");
  });
});
