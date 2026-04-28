import { describe, it, expect, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import i18n from "../../../shared/i18n";
import { useNavigateAwayGuard, type NavigationChoice } from "./NavigateAwayGuard";

/**
 * Phase 15.1 D-14.1 — NavigateAwayGuard imperative hook tests.
 *
 * Verifies Promise resolution paths:
 *   - "save"    when «Сохранить и выйти» clicked
 *   - "discard" when «Отменить и выйти» clicked
 *   - "stay"    when «Остаться» clicked
 *
 * Test harness exercises hook from inside a real component tree (renderHook
 * doesn't trigger re-render of separately-rendered <NavigateAwayGuardElement />
 * when hook state changes).
 */
function HookHarness({ onChoice }: { onChoice: (choice: NavigationChoice) => void }) {
  const { confirmNavigateAway, NavigateAwayGuardElement } = useNavigateAwayGuard();
  const [pending, setPending] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="open-guard"
        onClick={async () => {
          setPending(true);
          const choice = await confirmNavigateAway();
          setPending(false);
          onChoice(choice);
        }}
      >
        open
      </button>
      <span data-testid="pending">{pending ? "yes" : "no"}</span>
      <NavigateAwayGuardElement />
    </>
  );
}

describe("NavigateAwayGuard", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
  });

  it("returns Promise resolving to 'save' when user clicks «Сохранить и выйти»", async () => {
    let resolved: NavigationChoice | null = null;
    render(
      <HookHarness
        onChoice={(c) => {
          resolved = c;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("open-guard"));
    const saveBtn = await screen.findByRole("button", {
      name: /Сохранить и выйти/i,
    });
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    expect(resolved).toBe("save");
  });

  it("returns Promise resolving to 'discard' when user clicks «Отменить и выйти»", async () => {
    let resolved: NavigationChoice | null = null;
    render(
      <HookHarness
        onChoice={(c) => {
          resolved = c;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("open-guard"));
    const discardBtn = await screen.findByRole("button", {
      name: /Отменить и выйти/i,
    });
    await act(async () => {
      fireEvent.click(discardBtn);
    });
    expect(resolved).toBe("discard");
  });

  it("returns Promise resolving to 'stay' when user clicks «Остаться»", async () => {
    let resolved: NavigationChoice | null = null;
    render(
      <HookHarness
        onChoice={(c) => {
          resolved = c;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("open-guard"));
    const stayBtn = await screen.findByRole("button", { name: /Остаться/i });
    await act(async () => {
      fireEvent.click(stayBtn);
    });
    expect(resolved).toBe("stay");
  });
});
