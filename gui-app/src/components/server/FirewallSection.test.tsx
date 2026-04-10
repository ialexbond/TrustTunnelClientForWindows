import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { FirewallSection } from "./FirewallSection";
import type { FirewallStatus, SecurityState } from "./useSecurityState";

// ─── Helpers ─────────────────────────────────────────

function makeFirewallStatus(overrides?: Partial<FirewallStatus>): FirewallStatus {
  return {
    installed: true,
    active: true,
    default_in: "deny",
    default_out: "allow",
    default_routed: "disabled",
    logging: "on",
    rules: [
      { number: 1, to: "22/tcp", from: "Anywhere", action: "ALLOW IN", proto: "tcp", comment: "SSH" },
      { number: 2, to: "443/tcp", from: "Anywhere", action: "ALLOW IN", proto: "tcp", comment: "VPN" },
    ],
    current_ssh_port: 22,
    vpn_port: 443,
    ...overrides,
  };
}

function makeSecurityState(overrides?: Partial<SecurityState>): SecurityState {
  return {
    status: null,
    loading: false,
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
    setConfirm: vi.fn(),
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
    sshParams: { host: "1.2.3.4", port: 22, user: "root", password: "pass", keyPath: "" },
    ...overrides,
  } as unknown as SecurityState;
}

// ─── Tests ──────────────────────────────────────────

describe("FirewallSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders 'not installed' + install button + lockout warning when not installed", () => {
    const status = makeFirewallStatus({ installed: false, active: false, rules: [] });
    const state = makeSecurityState();

    render(<FirewallSection status={status} state={state} />);

    expect(screen.getByText("Не установлен")).toBeInTheDocument();
    expect(screen.getByText("Установить и включить firewall")).toBeInTheDocument();
    // Lockout warning contains the SSH port
    expect(screen.getByText(/SSH порт 22/)).toBeInTheDocument();
  });

  it("renders stats grid and rules table when active", () => {
    const status = makeFirewallStatus();
    const state = makeSecurityState();

    render(<FirewallSection status={status} state={state} />);

    // Stats labels
    expect(screen.getByText("Входящие")).toBeInTheDocument();
    expect(screen.getByText("deny")).toBeInTheDocument();
    expect(screen.getByText("Исходящие")).toBeInTheDocument();
    expect(screen.getByText("allow")).toBeInTheDocument();

    // Rules count header — "Правила (2)" in one text node
    expect(screen.getByText(/Правила.*\(2\)/)).toBeInTheDocument();

    // Rule comments
    expect(screen.getByText("# SSH")).toBeInTheDocument();
    expect(screen.getByText("# VPN")).toBeInTheDocument();
  });

  it("renders port 80 toggle reflecting current state (closed)", () => {
    const status = makeFirewallStatus({ rules: [] });
    const state = makeSecurityState();

    render(<FirewallSection status={status} state={state} />);

    // HTTP mode title visible
    expect(screen.getByText(/Порт 80/)).toBeInTheDocument();
    // Renewal-only text when port 80 is NOT open
    expect(screen.getByText(/Только во время обновления/)).toBeInTheDocument();
  });

  it("renders port 80 toggle reflecting current state (open)", () => {
    const status = makeFirewallStatus({
      rules: [
        { number: 1, to: "80/tcp", from: "Anywhere", action: "ALLOW IN", proto: "tcp", comment: "HTTP" },
      ],
    });
    const state = makeSecurityState();

    render(<FirewallSection status={status} state={state} />);

    expect(screen.getByText("Всегда открыт")).toBeInTheDocument();
  });

  it("renders add-rule button that opens modal", () => {
    const status = makeFirewallStatus();
    const state = makeSecurityState();

    render(<FirewallSection status={status} state={state} />);

    fireEvent.click(screen.getByText("Добавить правило"));
    expect(state.setShowAddRule).toHaveBeenCalledWith(true);
  });

  it("clicking install button calls installFirewall", () => {
    const status = makeFirewallStatus({ installed: false, active: false, rules: [] });
    const state = makeSecurityState();

    render(<FirewallSection status={status} state={state} />);

    fireEvent.click(screen.getByText("Установить и включить firewall"));
    expect(state.installFirewall).toHaveBeenCalled();
  });

  it("shows start button when installed but inactive", () => {
    const status = makeFirewallStatus({ installed: true, active: false, rules: [] });
    const state = makeSecurityState();

    render(<FirewallSection status={status} state={state} />);

    expect(screen.getByText("Установлен (неактивен)")).toBeInTheDocument();
    expect(screen.getByText("Включить")).toBeInTheDocument();
  });
});
