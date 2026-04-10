import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { Fail2banSection } from "./Fail2banSection";
import type { Fail2banStatus, SecurityState } from "./useSecurityState";

// ─── Helpers ─────────────────────────────────────────

function makeFail2banStatus(overrides?: Partial<Fail2banStatus>): Fail2banStatus {
  return {
    installed: true,
    active: true,
    jails: [
      {
        name: "sshd",
        enabled: true,
        currently_failed: 2,
        total_failed: 10,
        currently_banned: 3,
        total_banned: 5,
        banned_ips: ["10.0.0.1", "10.0.0.2"],
        maxretry: 5,
        bantime: "600",
        findtime: "600",
      },
    ],
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

describe("Fail2banSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders 'not installed' + install button when fail2ban not installed", () => {
    const status = makeFail2banStatus({ installed: false, active: false, jails: [] });
    const state = makeSecurityState();

    render(<Fail2banSection status={status} state={state} />);

    expect(screen.getByText("Не установлен")).toBeInTheDocument();
    expect(screen.getByText("Установить и включить")).toBeInTheDocument();
  });

  it("renders 'active' badge + stop/uninstall buttons when active", () => {
    const status = makeFail2banStatus({ installed: true, active: true });
    const state = makeSecurityState();

    render(<Fail2banSection status={status} state={state} />);

    expect(screen.getByText("Активен")).toBeInTheDocument();
    expect(screen.getByText("Остановить")).toBeInTheDocument();
    expect(screen.getByText("Удалить")).toBeInTheDocument();
  });

  it("renders jail cards with banned IP count when jails present", () => {
    const status = makeFail2banStatus();
    const state = makeSecurityState();

    render(<Fail2banSection status={status} state={state} />);

    expect(screen.getByText("sshd")).toBeInTheDocument();
    // currently_banned value (3) rendered as bold
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("expand jail shows banned IPs and config inputs", () => {
    const status = makeFail2banStatus();
    const state = makeSecurityState({ expandedJail: "sshd" });

    render(<Fail2banSection status={status} state={state} />);

    // Banned IPs should be visible
    expect(screen.getByText("10.0.0.1")).toBeInTheDocument();
    expect(screen.getByText("10.0.0.2")).toBeInTheDocument();
    // Config labels
    expect(screen.getByText("Макс. попыток")).toBeInTheDocument();
    expect(screen.getByText("Время бана")).toBeInTheDocument();
    expect(screen.getByText("Окно поиска")).toBeInTheDocument();
    // Save button
    expect(screen.getByText("Сохранить")).toBeInTheDocument();
  });

  it("clicking install button calls installFail2ban", () => {
    const status = makeFail2banStatus({ installed: false, active: false, jails: [] });
    const state = makeSecurityState();

    render(<Fail2banSection status={status} state={state} />);

    fireEvent.click(screen.getByText("Установить и включить"));
    expect(state.installFail2ban).toHaveBeenCalled();
  });

  it("shows start button when installed but inactive", () => {
    const status = makeFail2banStatus({ installed: true, active: false, jails: [] });
    const state = makeSecurityState();

    render(<Fail2banSection status={status} state={state} />);

    expect(screen.getByText("Установлен (неактивен)")).toBeInTheDocument();
    expect(screen.getByText("Запустить")).toBeInTheDocument();
  });
});
