import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onConfirm: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onCancel: any;

  const defaults = {
    open: true,
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

  it("renders default button labels", () => {
    render(<ConfirmDialog {...defaults} />);
    expect(screen.getByText("Подтвердить")).toBeInTheDocument();
    expect(screen.getByText("Отмена")).toBeInTheDocument();
  });

  it("renders custom button labels", () => {
    render(
      <ConfirmDialog
        {...defaults}
        confirmLabel="Yes, delete"
        cancelLabel="Keep it"
      />,
    );
    expect(screen.getByText("Yes, delete")).toBeInTheDocument();
    expect(screen.getByText("Keep it")).toBeInTheDocument();
  });

  it("calls onConfirm when confirm button clicked", () => {
    render(<ConfirmDialog {...defaults} />);
    fireEvent.click(screen.getByText("Подтвердить"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when cancel button clicked", () => {
    render(<ConfirmDialog {...defaults} />);
    fireEvent.click(screen.getByText("Отмена"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when open=false", () => {
    render(<ConfirmDialog {...defaults} open={false} />);
    expect(screen.queryByText("Delete item?")).not.toBeInTheDocument();
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
