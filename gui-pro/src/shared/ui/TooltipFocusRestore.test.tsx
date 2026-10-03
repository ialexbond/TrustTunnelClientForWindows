import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FOCUS_INTENT_WINDOW_MS } from "../hooks/usePointerPresence";
import { Modal } from "./Modal";
import { Tooltip } from "./Tooltip";

/**
 * G-32-20 — a dialog closing must not leave a tooltip behind on the control that opened it.
 *
 * The owner, on build `x4nb7d`:
 *
 *   «а что, нельзя сразу во всех местах "починить" тултип? а то только на "закрыть" окно пофиксил.
 *    А если модалку закрываю — там тултип остаётся»
 *
 * Written as HIS sequence rather than as an abstraction, and every assertion is on what RENDERS
 * (`queryByRole("tooltip")`), never on `hoverShow` / `focusShow` — so a refactor that keeps the flags
 * and breaks the paint still goes red.
 *
 * The real `Modal` is used on purpose. This is the third round of this defect and the previous two
 * were fixed one call site at a time; a test built on a hand-rolled stand-in for a dialog would
 * prove the mechanism and not the twenty-one modals that actually reach the user through
 * `shared/ui/Modal.tsx`.
 */

/** Every `write_activity_log` line this test produced, as `[message, details]` pairs. */
const loggedLines = (): (readonly [string, string | undefined])[] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "write_activity_log")
    .map(([, args]) => {
      const a = args as { message?: string; details?: string } | undefined;
      return [a?.message ?? "", a?.details] as const;
    });

/**
 * The row from the report: an icon with a tooltip that opens a dialog.
 *
 * `UsersSection.tsx:394` is the shipped instance — an `IconButton` with a `tooltip` prop (which
 * renders its own `Tooltip`, `IconButton.tsx:74`) whose `onClick` opens `UserConfigModal`, a
 * `Modal`. Reproduced here with the two primitives so the test owns nothing but the sequence.
 */
function ConfigRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip text="Показать конфиг">
        <button type="button" onClick={() => setOpen(true)}>
          config
        </button>
      </Tooltip>
      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        showCloseButton
        closeButtonTestId="close-x"
      >
        <p>QR</p>
      </Modal>
    </>
  );
}

/** A dialog whose first focusable carries a tooltip of its own. */
function ModalWithTooltippedControl({ isOpen }: { isOpen: boolean }) {
  return (
    <Modal isOpen={isOpen} onClose={() => {}}>
      <Tooltip text="Скачать файл">
        <button type="button">download</button>
      </Tooltip>
    </Modal>
  );
}

describe("a dialog that closes must not raise a tooltip on the control it returns focus to", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Whether a focus can be attributed to the user is answered from module state in
    // usePointerPresence, which outlives a single test, while the fake clock is reinstalled at the
    // real current time for each one. Push past the attribution window so every case starts from
    // «the user has done nothing», and a case that needs an input has to produce it itself.
    act(() => {
      vi.advanceTimersByTime(FOCUS_INTENT_WINDOW_MS + 1);
    });
    vi.mocked(invoke).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("paints nothing when he closes the dialog with the mouse and focus comes back to the icon", () => {
    render(<ConfigRow />);
    const icon = screen.getByRole("button", { name: "config" });
    const wrapper = icon.closest("div")!;

    // 1. The pointer arrives on the icon and rests there. The tip appears, as it should.
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    // 2. He presses the icon WITH THE MOUSE. A real browser focuses the button as part of the
    //    press, so the focus is produced here rather than dispatched as a bare event — the
    //    distinction that round three was built on.
    fireEvent.mouseDown(wrapper);
    act(() => {
      icon.focus();
    });
    fireEvent.click(icon);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    // 3. He moves the pointer off the row and onto the dialog.
    fireEvent.mouseLeave(wrapper);

    // 4. He closes the dialog with the mouse. This press is a real user action a moment ago, which
    //    is exactly why the round-three rule lets the focus that follows through.
    const closeX = screen.getByTestId("close-x");
    fireEvent.mouseDown(closeX);
    fireEvent.click(closeX);

    // 5. The dialog returns focus to the icon it was opened from. The pointer has not moved since
    //    step 3 and is nowhere near the row.
    expect(document.activeElement).toBe(icon);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("still returns focus to the opener — the accessibility behaviour is untouched", () => {
    render(<ConfigRow />);
    const icon = screen.getByRole("button", { name: "config" });

    fireEvent.mouseDown(icon.closest("div")!);
    act(() => {
      icon.focus();
    });
    fireEvent.click(icon);
    expect(document.activeElement).not.toBe(icon);

    const closeX = screen.getByTestId("close-x");
    fireEvent.mouseDown(closeX);
    fireEvent.click(closeX);

    expect(document.activeElement).toBe(icon);
  });

  it("shows the tip for a genuine Tab onto the same icon in a visible window", () => {
    render(<ConfigRow />);
    const icon = screen.getByRole("button", { name: "config" });

    // The SAME `.focus()` call as the dialog makes in the case above. The only difference is who
    // asked for it, which is the whole contract.
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => {
      icon.focus();
    });

    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });

  it("paints nothing on a tooltipped control the dialog focuses when it opens", () => {
    const { rerender } = render(<ModalWithTooltippedControl isOpen={false} />);
    // The user clicks something to open it — a real, recent input.
    fireEvent.mouseDown(document.body);
    act(() => {
      rerender(<ModalWithTooltippedControl isOpen />);
    });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "download" }));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("names the refusal in the activity log, so a fourth round is read and not guessed", () => {
    render(<ConfigRow />);
    const icon = screen.getByRole("button", { name: "config" });

    fireEvent.mouseDown(icon.closest("div")!);
    act(() => {
      icon.focus();
    });
    fireEvent.click(icon);

    const closeX = screen.getByTestId("close-x");
    fireEvent.mouseDown(closeX);
    fireEvent.click(closeX);

    const refusals = loggedLines().filter(([m]) => m === "pointer focus refused: app-placed");
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals[0][1]).toMatch(/^target=BUTTON$/);
  });
});
