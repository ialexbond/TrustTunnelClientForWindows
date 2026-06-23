import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Modal } from "./Modal";

describe("Modal", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onClose: any;

  beforeEach(() => {
    onClose = vi.fn();
  });

  it("renders children when isOpen=true", () => {
    render(
      <Modal isOpen onClose={onClose}>
        <p>Modal content</p>
      </Modal>
    );
    expect(screen.getByText("Modal content")).toBeInTheDocument();
  });

  it("renders children when open=true (legacy prop)", () => {
    render(
      <Modal open onClose={onClose}>
        <p>Legacy content</p>
      </Modal>
    );
    expect(screen.getByText("Legacy content")).toBeInTheDocument();
  });

  it("renders nothing when isOpen=false", () => {
    render(
      <Modal isOpen={false} onClose={onClose}>
        <p>Modal content</p>
      </Modal>
    );
    expect(screen.queryByText("Modal content")).not.toBeInTheDocument();
  });

  it("renders title when provided", () => {
    render(
      <Modal isOpen title="My Title" onClose={onClose}>
        <p>Content</p>
      </Modal>
    );
    expect(screen.getByText("My Title")).toBeInTheDocument();
  });

  it("calls onClose when overlay is clicked (full mousedown+mouseup gesture)", () => {
    render(
      <Modal isOpen onClose={onClose}>
        <p>Inside</p>
      </Modal>
    );
    // Overlay is the parent of the panel
    const panel = screen.getByText("Inside").closest("div[class*='max-w']")!;
    const overlay = panel.parentElement!;
    // FIX-J: close fires only when both mousedown AND mouseup land on backdrop.
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onClose when mousedown starts inside panel then releases on overlay (drag-select)", () => {
    // FIX-J regression test — the original bug: user starts text-drag inside
    // the modal, releases outside → modal was closing mid-edit and lost data.
    render(
      <Modal isOpen onClose={onClose}>
        <p>Inside</p>
      </Modal>
    );
    const inside = screen.getByText("Inside");
    const panel = inside.closest("div[class*='max-w']")!;
    const overlay = panel.parentElement!;
    fireEvent.mouseDown(inside);
    fireEvent.mouseUp(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not call onClose when panel content is clicked", () => {
    render(
      <Modal isOpen onClose={onClose}>
        <p>Inside</p>
      </Modal>
    );
    fireEvent.click(screen.getByText("Inside"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not call onClose on overlay click when closeOnBackdrop=false", () => {
    render(
      <Modal isOpen onClose={onClose} closeOnBackdrop={false}>
        <p>Inside</p>
      </Modal>
    );
    const panel = screen.getByText("Inside").closest("div[class*='max-w']")!;
    const overlay = panel.parentElement!;
    fireEvent.mouseDown(overlay);
    fireEvent.mouseUp(overlay);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on Escape key", () => {
    render(
      <Modal isOpen onClose={onClose}>
        <p>Inside</p>
      </Modal>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose on Escape when closeOnEscape=false", () => {
    render(
      <Modal isOpen onClose={onClose} closeOnEscape={false}>
        <p>Inside</p>
      </Modal>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("applies sm size class", () => {
    render(
      <Modal isOpen size="sm" onClose={onClose}>
        <p>Small</p>
      </Modal>
    );
    const panel = screen.getByText("Small").closest("div[class*='max-w']")!;
    expect(panel.className).toContain("max-w-sm");
  });

  it("applies md size class by default", () => {
    render(
      <Modal isOpen onClose={onClose}>
        <p>Medium</p>
      </Modal>
    );
    const panel = screen.getByText("Medium").closest("div[class*='max-w']")!;
    expect(panel.className).toContain("max-w-md");
  });

  it("applies lg size class", () => {
    render(
      <Modal isOpen size="lg" onClose={onClose}>
        <p>Large</p>
      </Modal>
    );
    const panel = screen.getByText("Large").closest("div[class*='max-w']")!;
    expect(panel.className).toContain("max-w-lg");
  });

  it("overlay uses z-[var(--z-modal)] class (not hardcoded 9000)", () => {
    render(
      <Modal isOpen onClose={onClose}>
        <p>Check z</p>
      </Modal>
    );
    const panel = screen.getByText("Check z").closest("div[class*='max-w']")!;
    const overlay = panel.parentElement!;
    expect(overlay.className).toContain("z-[var(--z-modal)]");
    expect(overlay.className).not.toContain("9000");
  });

  // ── Lifecycle contract: exit animation must render for 200ms ──
  // Guards the rule documented in known-issues.md #10 + Modal.tsx JSDoc:
  // Modal manages its own mount/unmount timing. When isOpen flips true→false,
  // the DOM must stay mounted for 200ms so the fade/scale/translate transition
  // can play. Caller MUST NOT `if (!isOpen) return null` before <Modal> — that
  // would unmount the tree instantly and kill the exit animation.
  it("keeps DOM mounted during 200ms exit transition (lifecycle contract)", async () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <Modal isOpen onClose={onClose}>
        <p>Will fade out</p>
      </Modal>
    );
    expect(screen.getByText("Will fade out")).toBeInTheDocument();

    // Close the modal — DOM must stay mounted during exit animation.
    rerender(
      <Modal isOpen={false} onClose={onClose}>
        <p>Will fade out</p>
      </Modal>
    );

    // Immediately after close: panel still mounted (fade-out in progress)
    expect(screen.queryByText("Will fade out")).toBeInTheDocument();

    // Advance by 100ms — still within exit animation
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.queryByText("Will fade out")).toBeInTheDocument();

    // After 200ms — Modal unmounts
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.queryByText("Will fade out")).not.toBeInTheDocument();

    vi.useRealTimers();
  });

  // ── Focus management (A11Y-01 / A4) ──
  // The dialog must trap keyboard focus while open and return focus to the
  // trigger when closed. Asserted purely via document.activeElement / roles —
  // never via CSS classes. Recipe: 09-RESEARCH-designsystem.md §3.1.

  it("moves focus into the dialog content box on open (initial-focus)", () => {
    render(
      <Modal isOpen onClose={onClose}>
        <button type="button">First action</button>
        <button type="button">Second action</button>
      </Modal>
    );
    const panel = screen.getByText("First action").closest("div[class*='max-w']")!;
    // Focus landed on the first focusable inside the dialog content box.
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "First action" })
    );
  });

  it("wraps Tab from the last focusable to the first (focus-trap)", () => {
    render(
      <Modal isOpen onClose={onClose}>
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </Modal>
    );
    const first = screen.getByRole("button", { name: "First action" });
    const last = screen.getByRole("button", { name: "Last action" });
    const panel = first.closest("div[class*='max-w']")!;

    // Move focus to the last element, then Tab forward → wraps to first.
    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(panel, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("wraps Shift+Tab from the first focusable to the last (focus-trap)", () => {
    render(
      <Modal isOpen onClose={onClose}>
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </Modal>
    );
    const first = screen.getByRole("button", { name: "First action" });
    const last = screen.getByRole("button", { name: "Last action" });
    const panel = first.closest("div[class*='max-w']")!;

    first.focus();
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(panel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("restores focus to the trigger element when closed (focus-restore)", () => {
    // The trigger button lives outside the modal and is focused before open.
    const Harness = ({ open }: { open: boolean }) => (
      <>
        <button type="button">Trigger</button>
        <Modal isOpen={open} onClose={onClose}>
          <button type="button">Inside action</button>
        </Modal>
      </>
    );
    const trigger = (() => {
      const { rerender } = render(<Harness open={false} />);
      const t = screen.getByRole("button", { name: "Trigger" });
      t.focus();
      expect(document.activeElement).toBe(t);
      // Open the modal — focus moves inside.
      rerender(<Harness open />);
      expect(document.activeElement).not.toBe(t);
      // Close the modal — focus returns to the trigger.
      rerender(<Harness open={false} />);
      return t;
    })();
    expect(document.activeElement).toBe(trigger);
  });

  // ── Opt-in close button + header slot (A-1) ──

  it("does not render a close button by default (byte-stable opt-out)", () => {
    render(
      <Modal isOpen onClose={onClose} title="Plain">
        <p>Body</p>
      </Modal>
    );
    expect(
      screen.queryByRole("button", { name: /close|закрыть/i })
    ).not.toBeInTheDocument();
  });

  it("renders an opt-in close button that fires onClose", () => {
    render(
      <Modal
        isOpen
        onClose={onClose}
        showCloseButton
        role="dialog"
        ariaLabelledby="dlg-title"
      >
        <h2 id="dlg-title">Accessible dialog</h2>
        <p>Body</p>
      </Modal>
    );
    const closeBtn = screen.getByRole("button", { name: /close|закрыть/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
    // Dialog has an accessible name via aria-labelledby.
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName("Accessible dialog");
  });

  it("disables the close button (and blocks onClose) when closeButtonDisabled", () => {
    // 09-23: surfaces that block close during an in-flight op (UserConfigModal
    // download, UserModal submit) pass closeButtonDisabled so the canonical
    // button is a faithful drop-in for their hand-rolled disabled <X>.
    render(
      <Modal isOpen onClose={onClose} showCloseButton closeButtonDisabled>
        <p>Body</p>
      </Modal>
    );
    const closeBtn = screen.getByRole("button", { name: /close|закрыть/i });
    expect(closeBtn).toBeDisabled();
    fireEvent.click(closeBtn);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("exposes the close button under an opt-in test id", () => {
    // 09-23: lets a migrated modal keep a stable data-testid its suite queries
    // (e.g. UserModal's user-modal-close) instead of querying by SVG/class.
    render(
      <Modal
        isOpen
        onClose={onClose}
        showCloseButton
        closeButtonTestId="my-close"
      >
        <p>Body</p>
      </Modal>
    );
    expect(screen.getByTestId("my-close")).toBeInTheDocument();
  });

  it("renders the optional header slot above children", () => {
    render(
      <Modal isOpen onClose={onClose} header={<span>Header slot</span>}>
        <p>Child body</p>
      </Modal>
    );
    expect(screen.getByText("Header slot")).toBeInTheDocument();
    // Header precedes the child content in DOM order.
    const header = screen.getByText("Header slot");
    const child = screen.getByText("Child body");
    expect(
      header.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
