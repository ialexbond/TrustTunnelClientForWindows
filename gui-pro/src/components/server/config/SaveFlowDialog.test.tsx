import { describe, it, expect, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import i18n from "../../../shared/i18n";
import { useSaveFlowDialog, type DiffRow } from "./SaveFlowDialog";

const ROWS: DiffRow[] = [
  {
    pathKey: "listen_address",
    fileName: "vpn",
    before: "0.0.0.0:443",
    after: "0.0.0.0:8443",
  },
  {
    pathKey: "main_hosts.0.hostname",
    fileName: "hosts",
    before: "old.com",
    after: "new.com",
  },
];

/**
 * Test harness — exercises useSaveFlowDialog hook from inside a real component
 * tree (renderHook doesn't trigger re-render of separately-rendered <SaveFlowDialogElement />
 * when hook state changes). Buttons in the harness expose the imperative API.
 */
function HookHarness({
  onConfirm,
  hasDisrupt = false,
}: {
  onConfirm: (resolved: boolean) => void;
  hasDisrupt?: boolean;
}) {
  const { confirmSave, SaveFlowDialogElement } = useSaveFlowDialog();
  const [pending, setPending] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="open-save"
        onClick={async () => {
          setPending(true);
          const ok = await confirmSave(ROWS, hasDisrupt);
          setPending(false);
          onConfirm(ok);
        }}
      >
        open
      </button>
      <span data-testid="pending">{pending ? "yes" : "no"}</span>
      <SaveFlowDialogElement />
    </>
  );
}

/**
 * Phase 15.1 D-4.3 + D-4.4 — SaveFlowDialog imperative hook tests.
 *
 * Verifies:
 *   - Diff rows render in table
 *   - Promise<true> on Apply click
 *   - Promise<false> on Cancel click
 *   - Disrupt warning shown when hasDisruptHighField=true (role="status")
 *
 * Modal lifecycle nuance: enter animation needs 2 RAF tick to set animating=true,
 * but content is mounted immediately (mounted=true). React Testing Library
 * `findByText` waits for content async — adequate for our assertions.
 */
describe("SaveFlowDialog (D-4.3 + D-4.4)", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
  });

  it("renders diff rows in a table when opened", async () => {
    const onConfirm = (): void => {};
    render(<HookHarness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId("open-save"));
    expect(await screen.findByText(/0\.0\.0\.0:443/)).toBeInTheDocument();
    expect(screen.getByText(/0\.0\.0\.0:8443/)).toBeInTheDocument();
    expect(screen.getByText(/old\.com/)).toBeInTheDocument();
    expect(screen.getByText(/new\.com/)).toBeInTheDocument();
  });

  it("returns Promise<true> when user clicks Применить изменения", async () => {
    let resolvedValue: boolean | null = null;
    render(
      <HookHarness
        onConfirm={(ok) => {
          resolvedValue = ok;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("open-save"));
    const applyBtn = await screen.findByRole("button", {
      name: /Применить изменения/i,
    });
    await act(async () => {
      fireEvent.click(applyBtn);
    });
    expect(resolvedValue).toBe(true);
  });

  it("returns Promise<false> when user clicks Отмена", async () => {
    let resolvedValue: boolean | null = null;
    render(
      <HookHarness
        onConfirm={(ok) => {
          resolvedValue = ok;
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("open-save"));
    const cancelBtn = await screen.findByRole("button", { name: /^Отмена$/i });
    await act(async () => {
      fireEvent.click(cancelBtn);
    });
    expect(resolvedValue).toBe(false);
  });

  it("shows disrupt warning footer when hasDisruptHighField=true (D-4.4)", async () => {
    const onConfirm = (): void => {};
    render(<HookHarness onConfirm={onConfirm} hasDisrupt />);
    fireEvent.click(screen.getByTestId("open-save"));
    // Disrupt warning banner has role="status"
    const banner = await screen.findByRole("status");
    expect(banner).toBeInTheDocument();
  });
});
