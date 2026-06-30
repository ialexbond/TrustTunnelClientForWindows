import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InlineNameEdit } from "./InlineNameEdit";

// InlineNameEdit is a CONTROLLED inline editor: it owns no draft state itself, so the test
// hosts it in a tiny wrapper that holds the draft (the real caller — the ConfigCard rename
// sub-state — does the same). The wrapper exposes the committed/cancelled callbacks and the
// final draft value so each behavior can be asserted directly.
const ARIA = "Имя конфигурации";

function Host({
  initial = "",
  onCommit,
  onCancel,
  maxLength,
}: {
  initial?: string;
  onCommit?: () => void;
  onCancel?: () => void;
  maxLength?: number;
}) {
  const [value, setValue] = useState(initial);
  return (
    <InlineNameEdit
      value={value}
      onChange={setValue}
      onCommit={onCommit}
      onCancel={onCancel}
      maxLength={maxLength}
      ariaLabel={ARIA}
    />
  );
}

describe("InlineNameEdit", () => {
  // ✓/Enter commit: Enter inside a non-empty field fires onCommit. (The committed value lives
  // in the caller's draft — onRename in production — which the host already holds via onChange.)
  it("Enter commits and calls onCommit for a non-empty value", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} />);

    const input = screen.getByRole("textbox", { name: ARIA });
    await user.type(input, "Германия");
    expect(input).toHaveValue("Германия");

    await user.keyboard("{Enter}");
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  // «empty never saves» (D-14): the component guards Enter so a whitespace-only / empty value
  // can NEVER commit, even though the caller's onCommit no-ops too — the guard is the floor.
  it("Enter does NOT commit a whitespace-only value", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Host onCommit={onCommit} />);

    const input = screen.getByRole("textbox", { name: ARIA });
    await user.type(input, "   ");
    await user.keyboard("{Enter}");

    expect(onCommit).not.toHaveBeenCalled();
  });

  // ✗/Escape cancel: Escape fires onCancel so the caller discards the draft (the box closes
  // and the original name is kept). The component itself does not clear the field — discard is
  // the caller's job — so we assert the cancel signal, which is the testable behavior.
  it("Escape cancels and calls onCancel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<Host initial="старое" onCancel={onCancel} />);

    const input = screen.getByRole("textbox", { name: ARIA });
    await user.type(input, "x");
    await user.keyboard("{Escape}");

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // The in-editor CharCounter reflects the live length against the cap (N/max).
  it("the in-editor character counter reflects the value length", async () => {
    const user = userEvent.setup();
    render(<Host maxLength={64} />);

    // Empty draft → 0/64.
    expect(screen.getByText("0/64")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: ARIA }), "abc");
    expect(screen.getByText("3/64")).toBeInTheDocument();
  });
});
