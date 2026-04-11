import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "./Modal";

describe("Modal", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onClose: any;

  beforeEach(() => {
    onClose = vi.fn();
  });

  it("renders children when open", () => {
    render(
      <Modal open onClose={onClose}>
        <p>Modal content</p>
      </Modal>,
    );
    expect(screen.getByText("Modal content")).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(
      <Modal open={false} onClose={onClose}>
        <p>Modal content</p>
      </Modal>,
    );
    expect(screen.queryByText("Modal content")).not.toBeInTheDocument();
  });

  it("calls onClose when backdrop is clicked", () => {
    render(
      <Modal open onClose={onClose}>
        <p>Inside</p>
      </Modal>,
    );

    // The backdrop is the outer fixed div; click it directly
    const backdrop = screen.getByText("Inside").parentElement!.parentElement!;
    fireEvent.click(backdrop);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when content is clicked", () => {
    render(
      <Modal open onClose={onClose}>
        <p>Inside</p>
      </Modal>,
    );

    fireEvent.click(screen.getByText("Inside"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not call onClose on backdrop click when closeOnBackdrop=false", () => {
    render(
      <Modal open onClose={onClose} closeOnBackdrop={false}>
        <p>Inside</p>
      </Modal>,
    );

    const backdrop = screen.getByText("Inside").parentElement!.parentElement!;
    fireEvent.click(backdrop);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on Escape key", () => {
    render(
      <Modal open onClose={onClose}>
        <p>Inside</p>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose on Escape when closeOnEscape=false", () => {
    render(
      <Modal open onClose={onClose} closeOnEscape={false}>
        <p>Inside</p>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
