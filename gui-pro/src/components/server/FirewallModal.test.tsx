import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { FirewallModal } from "./FirewallModal";
import type { SecurityState, FirewallStatus, FirewallRule } from "./useSecurityState";
import { renderWithProviders as render } from "../../test/test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockSshParams = {
  host: "192.168.1.100",
  port: 22,
  user: "root",
  password: "secret-pw",
};

function buildState(overrides: {
  firewall?: Partial<FirewallStatus>;
  showAddRule?: boolean;
  newRule?: { port: string; proto: string; action: string; from: string; comment: string };
  isBusyKey?: string | null;
  fwBusy?: boolean;
}): SecurityState {
  const firewall: FirewallStatus = {
    installed: false,
    active: false,
    default_in: "deny",
    default_out: "allow",
    default_routed: "disabled",
    logging: "low",
    rules: [],
    current_ssh_port: 22,
    vpn_port: null,
    ...(overrides.firewall ?? {}),
  };
  const isBusyKey = overrides.isBusyKey ?? null;
  return {
    status: {
      fail2ban: { installed: false, active: false, jails: [] },
      firewall,
    },
    loading: false,
    isBusy: vi.fn().mockImplementation((k: string) => k === isBusyKey),
    f2bBusy: false,
    fwBusy: overrides.fwBusy ?? false,
    fwWriting: false,
    expandedJail: null,
    setExpandedJail: vi.fn(),
    jailDraft: {},
    setJailDraft: vi.fn(),
    showF2bLog: false,
    setShowF2bLog: vi.fn(),
    f2bLog: "",
    manualBanIp: "",
    setManualBanIp: vi.fn(),
    showAddRule: overrides.showAddRule ?? false,
    setShowAddRule: vi.fn(),
    showFwLog: false,
    setShowFwLog: vi.fn(),
    fwLog: "",
    newRule: overrides.newRule ?? { port: "", proto: "tcp", action: "allow", from: "", comment: "" },
    setNewRule: vi.fn(),
    load: vi.fn().mockResolvedValue(undefined),
    installFail2ban: vi.fn().mockResolvedValue(undefined),
    uninstallFail2ban: vi.fn().mockResolvedValue(undefined),
    startFail2ban: vi.fn().mockResolvedValue(undefined),
    stopFail2ban: vi.fn().mockResolvedValue(undefined),
    banIp: vi.fn(),
    unbanIp: vi.fn().mockResolvedValue(undefined),
    saveJail: vi.fn().mockResolvedValue(undefined),
    loadF2bLog: vi.fn().mockResolvedValue(undefined),
    installFirewall: vi.fn().mockResolvedValue(undefined),
    uninstallFirewall: vi.fn().mockResolvedValue(undefined),
    startFirewall: vi.fn().mockResolvedValue(undefined),
    stopFirewall: vi.fn().mockResolvedValue(undefined),
    deleteRule: vi.fn().mockResolvedValue(undefined),
    addRule: vi.fn().mockResolvedValue(undefined),
    loadFwLog: vi.fn().mockResolvedValue(undefined),
    applyFail2banPreset: vi.fn().mockResolvedValue(undefined),
    applyFail2banCustom: vi.fn().mockResolvedValue(undefined),
    certbotTimerStatus: null,
    loadCertbotTimerStatus: vi.fn().mockResolvedValue(undefined),
    enableCertbotTimer: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(undefined),
    pushSuccess: vi.fn(),
    sshParams: mockSshParams,
  } as unknown as SecurityState;
}

beforeEach(() => {
  vi.clearAllMocks();
  i18n.changeLanguage("ru");
});

describe("FirewallModal", () => {
  it("shows not-installed message when UFW absent", async () => {
    render(
      <FirewallModal
        isOpen={true}
        onClose={vi.fn()}
        state={buildState({ firewall: { installed: false, active: false, rules: [] } })}
      />,
    );
    expect(await screen.findByTestId("rules-empty")).toBeVisible();
    // No add-rule button when not installed (D-3.1 — keep simple).
    expect(screen.queryByTestId("show-add-form-button")).not.toBeInTheDocument();
  });

  // a11y dialog semantics (Phase-9 review a11y-3): the Modal primitive applies an
  // unconditional focus-trap, so this modal must be a NAMED dialog or SR/keyboard
  // users are trapped in an unannounced generic container.
  it("is exposed as a named dialog (role + accessible name)", async () => {
    render(
      <FirewallModal
        isOpen={true}
        onClose={vi.fn()}
        state={buildState({ firewall: { installed: false, active: false, rules: [] } })}
      />,
    );
    expect(
      await screen.findByRole("dialog", {
        name: i18n.t("server.security.firewall.modal_title"),
      }),
    ).toBeInTheDocument();
  });

  // 09-25 (F11): rules are hidden behind the amber plate while the firewall is
  // inactive, so fetching them on open is wasted work that repeats on enable.
  // The rules-fetch effect must NOT call state.load when inactive, but MUST
  // when active.
  it("F11: does NOT fetch rules on open when firewall inactive", () => {
    const state = buildState({ firewall: { installed: true, active: false, rules: [] } });
    render(<FirewallModal isOpen={true} onClose={vi.fn()} state={state} />);
    expect(state.load).not.toHaveBeenCalled();
  });

  it("F11: fetches rules on open when firewall active", async () => {
    const state = buildState({ firewall: { installed: true, active: true, rules: [] } });
    render(<FirewallModal isOpen={true} onClose={vi.fn()} state={state} />);
    await waitFor(() => expect(state.load).toHaveBeenCalledTimes(1));
  });

  // WR-03: if the modal is open while the firewall flips inactive→active
  // mid-session, the rules-fetch effect must re-run (it now depends on
  // fwActive, not just isOpen). Previously it stayed keyed on [isOpen] and
  // relied on startFirewall's own reload — an undocumented cross-dependency.
  it("WR-03: fetches rules when firewall enabled while modal is open", async () => {
    const inactive = buildState({ firewall: { installed: true, active: false, rules: [] } });
    const { rerender } = render(
      <FirewallModal isOpen={true} onClose={vi.fn()} state={inactive} />,
    );
    expect(inactive.load).not.toHaveBeenCalled();

    // User enables the firewall while the modal stays open → fwActive flips true.
    const active = buildState({ firewall: { installed: true, active: true, rules: [] } });
    rerender(<FirewallModal isOpen={true} onClose={vi.fn()} state={active} />);
    await waitFor(() => expect(active.load).toHaveBeenCalledTimes(1));
  });

  it("shows empty state when installed but no rules", async () => {
    render(
      <FirewallModal
        isOpen={true}
        onClose={vi.fn()}
        state={buildState({ firewall: { installed: true, active: true, rules: [] } })}
      />,
    );
    expect(await screen.findByTestId("rules-empty")).toBeVisible();
  });

  it("renders rules table with allow/deny color coding", async () => {
    const rules: FirewallRule[] = [
      { number: 1, action: "ALLOW IN", to: "22/tcp", from: "Anywhere", proto: "tcp", comment: "SSH" },
      { number: 2, action: "DENY IN", to: "23/tcp", from: "Anywhere", proto: "tcp", comment: "" },
    ];
    render(
      <FirewallModal
        isOpen={true}
        onClose={vi.fn()}
        state={buildState({ firewall: { installed: true, active: true, rules } })}
      />,
    );
    expect(await screen.findByTestId("rule-row-1")).toBeVisible();
    expect(screen.getByTestId("rule-row-2")).toBeVisible();
    // P1-8 #P — ALLOW IN / DENY IN заменены RU-friendly labels.
    expect(screen.getByText(/^разрешён$/i)).toBeVisible();
    expect(screen.getByText(/^запрещён$/i)).toBeVisible();
  });

  it("UFW disable opens ConfirmDialog before invoking stopFirewall (D-3.3)", async () => {
    const state = buildState({ firewall: { installed: true, active: true, rules: [] } });
    render(<FirewallModal isOpen={true} onClose={vi.fn()} state={state} />);
    fireEvent.click(await screen.findByTestId("ufw-toggle-button"));

    // ConfirmDialog appears with "Отключить Firewall?" title (Modal-scoped wording).
    await waitFor(() =>
      expect(screen.getByText(/отключить брандмауэр\?/i)).toBeVisible(),
    );
    // Click confirm in ConfirmDialog — disambiguated by button index because
    // P0-4 #O added a second "Отключить брандмауэр" button (the ufw-toggle-button
    // shows the same imperative label, both bound to action_disable). The
    // ufw-toggle-button has data-testid; the remaining button is the
    // ConfirmDialog's confirm CTA.
    const allDisableButtons = await screen.findAllByRole("button", {
      name: /^отключить брандмауэр$/i,
    });
    const confirmButton = allDisableButtons.find(
      (b) => b.getAttribute("data-testid") !== "ufw-toggle-button",
    );
    expect(confirmButton).toBeDefined();
    fireEvent.click(confirmButton!);
    await waitFor(() => expect(state.stopFirewall).toHaveBeenCalled());
    expect(state.startFirewall).not.toHaveBeenCalled();
  });

  it("UFW enable invokes startFirewall directly (no confirm)", async () => {
    const state = buildState({ firewall: { installed: true, active: false, rules: [] } });
    render(<FirewallModal isOpen={true} onClose={vi.fn()} state={state} />);
    fireEvent.click(await screen.findByTestId("ufw-toggle-button"));
    await waitFor(() => expect(state.startFirewall).toHaveBeenCalled());
  });

  it("Add Rule submit invokes state.addRule with current newRule", async () => {
    const state = buildState({
      firewall: { installed: true, active: true, rules: [] },
      showAddRule: true,
      newRule: { port: "8080", proto: "tcp", action: "allow", from: "any", comment: "test" },
    });
    render(<FirewallModal isOpen={true} onClose={vi.fn()} state={state} />);
    fireEvent.click(await screen.findByTestId("add-rule-submit"));
    await waitFor(() => expect(state.addRule).toHaveBeenCalled());
  });

  it("Delete rule button opens ConfirmDialog → invokes deleteRule on confirm", async () => {
    // P UAT 2026-05-03: hook-internal confirm removed; FirewallModal owns confirm UX.
    // Click trash → confirm dialog → click "Удалить" → deleteRule(1).
    // NOTE: uses a NON-SSH port (8080) — the active SSH port (22) is now non-deletable
    // (post-UAT brick fix), so a deletable-rule test must target a different port.
    const rules: FirewallRule[] = [
      { number: 1, action: "ALLOW IN", to: "8080/tcp", from: "Anywhere", proto: "tcp", comment: "" },
    ];
    const state = buildState({ firewall: { installed: true, active: true, rules } });
    render(<FirewallModal isOpen={true} onClose={vi.fn()} state={state} />);
    fireEvent.click(await screen.findByTestId("delete-rule-1"));
    // Wait for confirm dialog
    await waitFor(() => expect(screen.getByText(/удалить правило\?/i)).toBeVisible());
    // Click confirm — finds the dialog's confirm button (label "Удалить")
    const buttons = screen.getAllByRole("button", { name: /^удалить$/i });
    expect(buttons.length).toBeGreaterThan(0);
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(state.deleteRule).toHaveBeenCalledWith(1));
  });

  it("delete button is DISABLED for the active SSH port row (never lock the admin out)", async () => {
    // post-UAT server-brick fix: the rule for the connected SSH port must not be
    // deletable from the table — deleting it (with ufw default-deny) locks the admin
    // out of the server entirely. The 22 row (= current_ssh_port) is disabled; a
    // non-SSH row (8080) stays deletable.
    const rules: FirewallRule[] = [
      { number: 1, action: "ALLOW IN", to: "22/tcp", from: "Anywhere", proto: "tcp", comment: "SSH (TrustTunnel)" },
      { number: 2, action: "ALLOW IN", to: "8080/tcp", from: "Anywhere", proto: "tcp", comment: "" },
    ];
    const state = buildState({ firewall: { installed: true, active: true, rules, current_ssh_port: 22 } });
    render(<FirewallModal isOpen={true} onClose={vi.fn()} state={state} />);
    expect(await screen.findByTestId("delete-rule-1")).toBeDisabled();
    expect(screen.getByTestId("delete-rule-2")).not.toBeDisabled();
  });

  it("Add Rule submit disabled when port empty", async () => {
    const state = buildState({
      firewall: { installed: true, active: true, rules: [] },
      showAddRule: true,
      newRule: { port: "", proto: "tcp", action: "allow", from: "", comment: "" },
    });
    render(<FirewallModal isOpen={true} onClose={vi.fn()} state={state} />);
    const submit = await screen.findByTestId("add-rule-submit");
    expect(submit).toBeDisabled();
  });

  it("Show Add Rule button invisible when busy installing", async () => {
    const state = buildState({
      firewall: { installed: true, active: true, rules: [] },
      fwBusy: true,
    });
    render(<FirewallModal isOpen={true} onClose={vi.fn()} state={state} />);
    const showAddBtn = await screen.findByTestId("show-add-form-button");
    expect(showAddBtn).toBeDisabled();
  });

  // ── Owner UAT 2026-08-20 — button placement is a REQUIREMENT, not incidental ──
  //
  // The owner asked for the two buttons to swap: «Добавить правило» into the status
  // row, the enable/disable toggle into the bottom-right footer. Every test above
  // reaches its button by data-testid, so a refactor could move them back and the
  // whole suite would stay green — silently undoing the request. These three pin the
  // arrangement itself. They assert CONTAINMENT (which region owns the button), not
  // pixels or class names, so ordinary restyling does not make them brittle.

  it("owner UAT: the add-rule trigger lives in the status row", async () => {
    const state = buildState({ firewall: { installed: true, active: true, rules: [] } });
    render(<FirewallModal isOpen={true} onClose={vi.fn()} state={state} />);

    const statusRow = await screen.findByTestId("ufw-toggle-row");
    const addBtn = await screen.findByTestId("show-add-form-button");
    expect(statusRow).toContainElement(addBtn);
  });

  it("owner UAT: the enable/disable toggle is NOT in the status row (it moved to the footer)", async () => {
    const state = buildState({ firewall: { installed: true, active: true, rules: [] } });
    render(<FirewallModal isOpen={true} onClose={vi.fn()} state={state} />);

    const statusRow = await screen.findByTestId("ufw-toggle-row");
    const toggle = await screen.findByTestId("ufw-toggle-button");
    // Still rendered — just not here any more.
    expect(toggle).toBeInTheDocument();
    expect(statusRow).not.toContainElement(toggle);
  });

  it("add-rule trigger is absent while the firewall is installed but INACTIVE", async () => {
    // Not cosmetic: the backend accepts `ufw allow ...` while UFW is down, but
    // parse_ufw_status skips those rules, so the user would add one, never see it in
    // the table, and conclude the app is broken. The condition moved with the button
    // when it was relocated — this proves it did not get left behind at the old site.
    const state = buildState({ firewall: { installed: true, active: false, rules: [] } });
    render(<FirewallModal isOpen={true} onClose={vi.fn()} state={state} />);

    expect(await screen.findByTestId("ufw-toggle-row")).toBeInTheDocument();
    expect(screen.queryByTestId("show-add-form-button")).not.toBeInTheDocument();
    // The footer toggle is still offered, so the user can turn UFW on.
    expect(await screen.findByTestId("ufw-toggle-button")).toBeInTheDocument();
  });
});
