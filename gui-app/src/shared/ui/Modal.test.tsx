import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

  it("calls onClose when overlay is clicked", () => {
    render(
      <Modal isOpen onClose={onClose}>
        <p>Inside</p>
      </Modal>
    );
    // Overlay is the parent of the panel
    const panel = screen.getByText("Inside").closest("div[class*='max-w']")!;
    const overlay = panel.parentElement!;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
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
    fireEvent.click(overlay);
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
});
