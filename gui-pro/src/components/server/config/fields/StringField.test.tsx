import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../../../shared/i18n";
import { StringField } from "./StringField";
import type { TomlFieldSchema } from "../types";

/**
 * Phase 04 Plan 15 — Config H-3 regression coverage for StringField's onBlur
 * commit guard. audit/03-configuration.md H-3: handleBlur compares the typed
 * value against an `initialValue` snapshot. When the parent updates the schema
 * externally (discardAll / cross-tab reload) the local buffer re-syncs, but the
 * commit baseline must re-sync WITH it — otherwise a legitimate edit can be
 * suppressed (compared against a stale baseline) or a no-op edit re-emitted.
 *
 * These tests pin the onBlur commit contract against an externally-updated
 * schema, and the H-3 case proves the baseline tracks the latest schema value.
 *
 * NOTE (Plan 15): StringField's pre-fix `initialValue` was a per-render const, so
 * it already tracked the live schema value — the literal H-3 symptom is only
 * reachable through the discardAll/tree-revert interaction in useTomlConfigState
 * (a separate finding, see deferred-items.md). The fix here re-anchors the commit
 * baseline in a ref updated by the SAME sync effect (the audit's recommended
 * robust shape), and these tests pin that contract so a future memoization of the
 * value can never silently reintroduce a stale-baseline commit.
 */

function stringSchema(value: string): TomlFieldSchema {
  return {
    key: "listen_address",
    path: ["listen_address"],
    type: { kind: "string", value },
    isExplicit: true,
  };
}

describe("StringField — onBlur commit guard (H-3)", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
  });

  it("emits onChange on blur only when the value differs from the schema baseline", () => {
    const onChange = vi.fn();
    render(<StringField schema={stringSchema("A")} onChange={onChange} />);
    const input = screen.getByRole("textbox");

    // Blur with no change → no commit.
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();

    // Type a different value → commit on blur.
    fireEvent.change(input, { target: { value: "B" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(["listen_address"], "B");
  });

  it("H-3: after an external schema update, a value matching the NEW schema is not re-committed; a different one is", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <StringField schema={stringSchema("A")} onChange={onChange} />,
    );
    const input = screen.getByRole("textbox");

    // User commits A→B.
    fireEvent.change(input, { target: { value: "B" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(["listen_address"], "B");
    onChange.mockClear();

    // Parent applies the edit: the schema value is now "B". The local buffer
    // re-syncs to "B" via the [schema.type] effect. The commit baseline MUST also
    // be "B" now — blurring without a change must NOT re-emit a redundant onChange
    // against a stale "A" baseline.
    rerender(<StringField schema={stringSchema("B")} onChange={onChange} />);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();

    // A genuinely new value still commits against the refreshed "B" baseline.
    fireEvent.change(input, { target: { value: "C" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(["listen_address"], "C");
  });
});
