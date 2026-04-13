import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onConfirm: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onCancel: any;

  const defaults = {
    isOpen: true,
    title: "Delete item?",
    message: "This action cannot be undone.",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    onConfirm = vi.fn();
    onCancel = vi.fn();
    defaults.onConfirm = onConfirm;
    defaults.onCancel = onCancel;
  });

  it("renders title and message", () => {
    render(<ConfirmDialog {...defaults} />);
    expect(screen.getByText("Delete item?")).toBeInTheDocument();
    expect(screen.getByText("This action cannot be undone.")).toBeInTheDocument();
  });

  it("renders default confirm text 'Удалить'", () => {
    render(<ConfirmDialog {...defaults} />);
    expect(screen.getByText("Удалить")).toBeInTheDocument();
  });

  it("renders default cancel text 'Отмена'", () => {
    render(<ConfirmDialog {...defaults} />);
    expect(screen.getByText("Отмена")).toBeInTheDocument();
  });

  it("renders custom confirmText", () => {
    render(<ConfirmDialog {...defaults} confirmText="Yes, delete" />);
    expect(screen.getByText("Yes, delete")).toBeInTheDocument();
  });

  it("renders custom cancelText", () => {
    render(<ConfirmDialog {...defaults} cancelText="Keep it" />);
    expect(screen.getByText("Keep it")).toBeInTheDocument();
  });

  it("renders custom confirmLabel (legacy)", () => {
    render(<ConfirmDialog {...defaults} confirmLabel="Confirm label" />);
    expect(screen.getByText("Confirm label")).toBeInTheDocument();
  });

  it("renders custom cancelLabel (legacy)", () => {
    render(<ConfirmDialog {...defaults} cancelLabel="Cancel label" />);
    expect(screen.getByText("Cancel label")).toBeInTheDocument();
  });

  it("calls onConfirm when confirm button clicked", () => {
    render(<ConfirmDialog {...defaults} />);
    fireEvent.click(screen.getByText("Удалить"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when cancel button clicked", () => {
    render(<ConfirmDialog {...defaults} />);
    fireEvent.click(screen.getByText("Отмена"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when isOpen=false", () => {
    render(<ConfirmDialog {...defaults} isOpen={false} />);
    expect(screen.queryByText("Delete item?")).not.toBeInTheDocument();
  });

  it("works with legacy open prop", () => {
    render(
      <ConfirmDialog
        open={true}
        title="Legacy"
        message="Legacy message"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
    expect(screen.getByText("Legacy")).toBeInTheDocument();
  });

  it("applies danger variant styling to title", () => {
    render(<ConfirmDialog {...defaults} variant="danger" />);
    const title = screen.getByText("Delete item?");
    expect(title.style.color).toContain("danger");
  });

  it("applies warning variant styling to title", () => {
    render(<ConfirmDialog {...defaults} variant="warning" />);
    const title = screen.getByText("Delete item?");
    expect(title.style.color).toContain("warning");
  });
});
