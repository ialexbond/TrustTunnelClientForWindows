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
    changeSshPort: vi.fn().mockResolvedValue(undefined),
    portBusy: false,
    generateSshKey: vi.fn().mockResolvedValue(undefined),
    exportSshKeyBackup: vi.fn().mockResolvedValue(undefined),
    disablePasswordAuth: vi.fn().mockResolvedValue(undefined),
    importSshKey: vi.fn().mockResolvedValue(undefined),
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
      expect(screen.getByText(/отключить firewall\?/i)).toBeVisible(),
    );
    // Click confirm in ConfirmDialog — disambiguated by button index because
    // P0-4 #O added a second "Отключить" button (the ufw-toggle-button shows
    // the same imperative label). The ufw-toggle-button has data-testid; the
    // remaining "Отключить" button is the ConfirmDialog's confirm CTA.
    const allDisableButtons = await screen.findAllByRole("button", { name: /^отключить$/i });
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

  it("Delete rule button invokes deleteRule with rule number", async () => {
    const rules: FirewallRule[] = [
      { number: 1, action: "ALLOW IN", to: "22/tcp", from: "Anywhere", proto: "tcp", comment: "" },
    ];
    const state = buildState({ firewall: { installed: true, active: true, rules } });
    render(<FirewallModal isOpen={true} onClose={vi.fn()} state={state} />);
    fireEvent.click(await screen.findByTestId("delete-rule-1"));
    await waitFor(() => expect(state.deleteRule).toHaveBeenCalledWith(1));
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
});
