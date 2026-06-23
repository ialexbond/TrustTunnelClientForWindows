import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { Fail2banSettingsTab } from "./Fail2banSettingsTab";
import type { SecurityState } from "./useSecurityState";

// E-5: the Fail2ban preset radio must SNAP BACK to the real server preset when a
// preset apply FAILS on the backend. Root cause was the shared run() contract
// (see useSecurityState.test.ts): run() swallowed the error and resolved void, so
// the tab's optimistic revert never fired. The additive fix makes
// applyFail2banPreset resolve a success boolean; this tab reverts on `false`.

// useConfirm is mocked so the "strict" confirm dialog auto-resolves true and the
// apply path is reached. Override per-test if a cancel path is needed.
const mockConfirm = vi.fn().mockResolvedValue(true);
vi.mock("../../shared/ui/useConfirm", () => ({
  useConfirm: () => mockConfirm,
}));

// A jail whose values match the "balanced" preset (maxretry 5 / bantime 600 /
// findtime 600) so detectedPreset === "balanced" — the real server state the
// radio must revert TO after a failed strict apply.
const balancedJail = {
  name: "sshd",
  maxretry: 5,
  bantime: "600",
  findtime: "600",
};

function makeState(overrides?: Partial<SecurityState>): SecurityState {
  return {
    isBusy: vi.fn().mockReturnValue(false),
    applyFail2banPreset: vi.fn().mockResolvedValue(true),
    applyFail2banCustom: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as SecurityState;
}

describe("Fail2banSettingsTab — E-5 preset revert on failed apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    i18n.changeLanguage("ru");
  });

  function getRadio(preset: "soft" | "balanced" | "strict"): HTMLInputElement {
    return screen.getByTestId(`preset-radio-${preset}`) as HTMLInputElement;
  }

  it("reverts the radio to the server preset when the apply FAILS (E-5)", async () => {
    // applyFail2banPreset resolves FALSE → simulates a backend rejection that
    // run() surfaced as a toast (already fired) and reported via the boolean.
    const state = makeState({
      applyFail2banPreset: vi.fn().mockResolvedValue(false),
    });

    render(<Fail2banSettingsTab state={state} jail={balancedJail} />);

    // Starting point: balanced is the detected (server) preset.
    expect(getRadio("balanced").checked).toBe(true);
    expect(getRadio("strict").checked).toBe(false);

    // Click strict (the confirm dialog auto-resolves true).
    fireEvent.click(getRadio("strict"));

    // After the failed apply settles, the radio must SNAP BACK to balanced —
    // the real server preset is unchanged, so the optimistic strict selection
    // is reverted.
    await waitFor(() => {
      expect(getRadio("balanced").checked).toBe(true);
    });
    expect(getRadio("strict").checked).toBe(false);
    expect(state.applyFail2banPreset).toHaveBeenCalledWith("strict");
  });

  it("positive control: keeps strict selected when the apply SUCCEEDS", async () => {
    // applyFail2banPreset resolves TRUE — the optimistic selection stays until
    // the jail refresh catches up (jail prop unchanged here, so selectedPreset
    // remains strict).
    const state = makeState({
      applyFail2banPreset: vi.fn().mockResolvedValue(true),
    });

    render(<Fail2banSettingsTab state={state} jail={balancedJail} />);

    fireEvent.click(getRadio("strict"));

    await waitFor(() => {
      expect(getRadio("strict").checked).toBe(true);
    });
    expect(getRadio("balanced").checked).toBe(false);
  });
});
