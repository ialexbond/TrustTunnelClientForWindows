import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SshPortSection } from "./SshPortSection";
import type { SecurityState } from "./useSecurityState";

// ─── Mocks ──────────────────────────────────────────

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", changeLanguage: vi.fn() },
  }),
}));

vi.mock("lucide-react", () => ({
  Loader2: (props: Record<string, unknown>) => <span data-testid="loader" {...props} />,
  RotateCcw: (props: Record<string, unknown>) => <span data-testid="rotate-ccw" {...props} />,
}));

// ─── Helpers ────────────────────────────────────────

function makeMockState(overrides?: Partial<SecurityState>): SecurityState {
  return {
    status: {
      fail2ban: { installed: false, active: false, jails: [] },
      firewall: {
        installed: true,
        active: true,
        default_in: "deny",
        default_out: "allow",
        default_routed: "disabled",
        logging: "on",
        rules: [],
        current_ssh_port: 22,
        vpn_port: 443,
      },
    },
    loading: false,
    portBusy: false,
    changeSshPort: vi.fn(),
    setConfirm: vi.fn(),
    // Minimal stubs for the rest of SecurityState
    isBusy: vi.fn().mockReturnValue(false),
    f2bBusy: false,
    fwBusy: false,
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
    showAddRule: false,
    setShowAddRule: vi.fn(),
    showFwLog: false,
    setShowFwLog: vi.fn(),
    fwLog: "",
    newRule: { port: "", proto: "tcp", action: "allow", from: "", comment: "" },
    setNewRule: vi.fn(),
    confirm: null,
    load: vi.fn(),
    installFail2ban: vi.fn(),
    uninstallFail2ban: vi.fn(),
    startFail2ban: vi.fn(),
    stopFail2ban: vi.fn(),
    banIp: vi.fn(),
    unbanIp: vi.fn(),
    saveJail: vi.fn(),
    loadF2bLog: vi.fn(),
    installFirewall: vi.fn(),
    uninstallFirewall: vi.fn(),
    startFirewall: vi.fn(),
    stopFirewall: vi.fn(),
    deleteRule: vi.fn(),
    addRule: vi.fn(),
    loadFwLog: vi.fn(),
    run: vi.fn(),
    pushSuccess: vi.fn(),
    sshParams: { host: "1.2.3.4", port: 22, user: "root", password: "pass" },
    ...overrides,
  } as unknown as SecurityState;
}

// ─── Tests ──────────────────────────────────────────

describe("SshPortSection", () => {
  // PORT-06: Current port display
  it("displays current SSH port from state.status", () => {
    const state = makeMockState({
      status: {
        fail2ban: { installed: false, active: false, jails: [] },
        firewall: {
          installed: true, active: true, default_in: "deny", default_out: "allow",
          default_routed: "disabled", logging: "on", rules: [],
          current_ssh_port: 2222, vpn_port: 443,
        },
      },
    });

    render(<SshPortSection state={state} />);
    expect(screen.getByText(/2222/)).toBeInTheDocument();
  });

  // PORT-07: Reset button visibility
  it("shows Reset button when currentPort !== 22 and status is loaded", () => {
    const state = makeMockState({
      status: {
        fail2ban: { installed: false, active: false, jails: [] },
        firewall: {
          installed: true, active: true, default_in: "deny", default_out: "allow",
          default_routed: "disabled", logging: "on", rules: [],
          current_ssh_port: 2222, vpn_port: 443,
        },
      },
    });

    render(<SshPortSection state={state} />);
    expect(screen.getByText("server.security.ssh_port.reset")).toBeInTheDocument();
  });

  it("hides Reset button when currentPort === 22", () => {
    const state = makeMockState({
      status: {
        fail2ban: { installed: false, active: false, jails: [] },
        firewall: {
          installed: true, active: true, default_in: "deny", default_out: "allow",
          default_routed: "disabled", logging: "on", rules: [],
          current_ssh_port: 22, vpn_port: 443,
        },
      },
    });

    render(<SshPortSection state={state} />);
    expect(screen.queryByText("server.security.ssh_port.reset")).not.toBeInTheDocument();
  });

  it("hides Reset button when status is null (loading)", () => {
    const state = makeMockState({ status: null });

    render(<SshPortSection state={state} />);
    expect(screen.queryByText("server.security.ssh_port.reset")).not.toBeInTheDocument();
  });

  // PORT-07: Reset button action
  it("calls state.changeSshPort(22) via confirm dialog when Reset clicked", async () => {
    const user = userEvent.setup();
    const changeSshPort = vi.fn();
    const setConfirm = vi.fn();

    const state = makeMockState({
      status: {
        fail2ban: { installed: false, active: false, jails: [] },
        firewall: {
          installed: true, active: true, default_in: "deny", default_out: "allow",
          default_routed: "disabled", logging: "on", rules: [],
          current_ssh_port: 2222, vpn_port: 443,
        },
      },
      changeSshPort,
      setConfirm,
    });

    render(<SshPortSection state={state} />);
    const resetBtn = screen.getByText("server.security.ssh_port.reset");
    await user.click(resetBtn);

    // setConfirm should have been called with an object containing onConfirm
    expect(setConfirm).toHaveBeenCalledTimes(1);
    const confirmArg = setConfirm.mock.calls[0][0];
    expect(confirmArg).toHaveProperty("onConfirm");

    // Simulate user confirming the dialog
    confirmArg.onConfirm();
    expect(changeSshPort).toHaveBeenCalledWith(22);
  });
});
