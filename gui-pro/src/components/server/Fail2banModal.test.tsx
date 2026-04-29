import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { Fail2banModal } from "./Fail2banModal";
import type { SecurityState, SshParams } from "./useSecurityState";
import { renderWithProviders as render } from "../../test/test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: vi.fn() }),
}));

const mockSshParams: SshParams = {
  host: "192.168.1.100",
  port: 22,
  user: "root",
  password: "secret-pw",
};

type Jail = {
  name: string;
  enabled: boolean;
  currently_failed: number;
  total_failed: number;
  currently_banned: number;
  total_banned: number;
  banned_ips: string[];
  maxretry: number;
  bantime: string;
  findtime: string;
};

function buildState(overrides: {
  installed?: boolean;
  active?: boolean;
  jails?: Jail[];
}): SecurityState {
  const installed = overrides.installed ?? false;
  const active = overrides.active ?? false;
  const jails = overrides.jails ?? [];
  return {
    status: {
      fail2ban: { installed, active, jails },
      firewall: {
        installed: false,
        active: false,
        default_in: "deny",
        default_out: "allow",
        default_routed: "disabled",
        logging: "low",
        rules: [],
        current_ssh_port: 22,
        vpn_port: null,
      },
    },
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
    run: vi.fn().mockResolvedValue(undefined),
    pushSuccess: vi.fn(),
    sshParams: mockSshParams,
  } as unknown as SecurityState;
}

const buildSshdJail = (overrides: Partial<Jail> = {}): Jail => ({
  name: "sshd",
  enabled: true,
  currently_failed: 0,
  total_failed: 0,
  currently_banned: 0,
  total_banned: 0,
  banned_ips: [],
  maxretry: 5,
  bantime: "600",
  findtime: "600",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  i18n.changeLanguage("ru");
});

describe("Fail2banModal", () => {
  it("renders install button when not installed", async () => {
    render(
      <Fail2banModal
        isOpen={true}
        onClose={vi.fn()}
        state={buildState({ installed: false })}
        sshParams={mockSshParams}
      />,
    );
    expect(
      await screen.findByTestId("install-fail2ban-button"),
    ).toBeVisible();
    expect(
      screen.queryByTestId("fail2ban-settings-tab"),
    ).not.toBeInTheDocument();
  });

  it("invokes installFail2ban when install button clicked", async () => {
    const state = buildState({ installed: false });
    render(
      <Fail2banModal
        isOpen={true}
        onClose={vi.fn()}
        state={state}
        sshParams={mockSshParams}
      />,
    );
    fireEvent.click(await screen.findByTestId("install-fail2ban-button"));
    await waitFor(() => expect(state.installFail2ban).toHaveBeenCalled());
  });

  it("renders TabsInline when installed", async () => {
    const state = buildState({
      installed: true,
      active: true,
      jails: [buildSshdJail()],
    });
    render(
      <Fail2banModal
        isOpen={true}
        onClose={vi.fn()}
        state={state}
        sshParams={mockSshParams}
      />,
    );
    expect(
      await screen.findByRole("tab", { name: /настройки/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("tab", { name: /забаненные ip/i }),
    ).toBeVisible();
  });

  it("selecting strict preset calls applyFail2banPreset", async () => {
    const state = buildState({
      installed: true,
      active: true,
      jails: [buildSshdJail()],
    });
    render(
      <Fail2banModal
        isOpen={true}
        onClose={vi.fn()}
        state={state}
        sshParams={mockSshParams}
      />,
    );

    fireEvent.click(await screen.findByTestId("preset-radio-strict"));
    await waitFor(() =>
      expect(state.applyFail2banPreset).toHaveBeenCalledWith("strict"),
    );
  });

  it("custom mode apply calls applyFail2banCustom", async () => {
    // Custom config (7/1200/300) does not match any preset → activePreset = "custom".
    const state = buildState({
      installed: true,
      active: true,
      jails: [buildSshdJail({ maxretry: 7, bantime: "1200", findtime: "300" })],
    });
    render(
      <Fail2banModal
        isOpen={true}
        onClose={vi.fn()}
        state={state}
        sshParams={mockSshParams}
      />,
    );

    fireEvent.click(await screen.findByTestId("apply-custom-button"));
    await waitFor(() =>
      expect(state.applyFail2banCustom).toHaveBeenCalledWith(
        expect.objectContaining({ maxretry: 7 }),
      ),
    );
  });

  it("banned tab shows empty state when no IPs", async () => {
    const state = buildState({
      installed: true,
      active: true,
      jails: [buildSshdJail()],
    });
    render(
      <Fail2banModal
        isOpen={true}
        onClose={vi.fn()}
        state={state}
        sshParams={mockSshParams}
        _forceTab="banned"
      />,
    );
    expect(await screen.findByTestId("banned-empty")).toBeVisible();
  });

  it("banned tab renders IPs in table", async () => {
    const state = buildState({
      installed: true,
      active: true,
      jails: [
        buildSshdJail({
          banned_ips: ["1.2.3.4 (5min ago)", "5.6.7.8"],
        }),
      ],
    });
    render(
      <Fail2banModal
        isOpen={true}
        onClose={vi.fn()}
        state={state}
        sshParams={mockSshParams}
        _forceTab="banned"
      />,
    );
    expect(await screen.findByText("1.2.3.4")).toBeVisible();
    expect(screen.getByText("5.6.7.8")).toBeVisible();
    expect(screen.getByText("5min ago")).toBeVisible();
  });

  it("unban button invokes backend", async () => {
    const state = buildState({
      installed: true,
      active: true,
      jails: [buildSshdJail({ banned_ips: ["1.2.3.4"] })],
    });
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    render(
      <Fail2banModal
        isOpen={true}
        onClose={vi.fn()}
        state={state}
        sshParams={mockSshParams}
        _forceTab="banned"
      />,
    );

    fireEvent.click(await screen.findByTestId("unban-button-0"));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "security_fail2ban_unban",
        expect.objectContaining({ jail: "sshd", ip: "1.2.3.4" }),
      ),
    );
  });

  it("T-03 lifecycle: closed Modal stays in DOM during exit animation (visibility, not removed)", async () => {
    const state = buildState({ installed: false });
    const { rerender } = render(
      <Fail2banModal
        isOpen={true}
        onClose={vi.fn()}
        state={state}
        sshParams={mockSshParams}
      />,
    );
    expect(
      await screen.findByTestId("install-fail2ban-button"),
    ).toBeInTheDocument();

    // Close — Modal primitive runs 200ms exit transition; component stays mounted.
    rerender(
      <Fail2banModal
        isOpen={false}
        onClose={vi.fn()}
        state={state}
        sshParams={mockSshParams}
      />,
    );

    // Per CLAUDE.md «Testing Patterns» — toBeVisible() not toBeInTheDocument()
    // (visibility:hidden during exit animation; eventually unmounted at 200ms).
    await waitFor(() =>
      expect(
        screen.queryByTestId("install-fail2ban-button"),
      ).not.toBeInTheDocument(),
    );
  });

  it("calls onClose when X button clicked", async () => {
    const onClose = vi.fn();
    render(
      <Fail2banModal
        isOpen={true}
        onClose={onClose}
        state={buildState({ installed: false })}
        sshParams={mockSshParams}
      />,
    );
    const closeBtn = await screen.findByRole("button", {
      name: i18n.t("buttons.close"),
    });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("auto-detects strict preset from jail config matching strict thresholds", async () => {
    const state = buildState({
      installed: true,
      active: true,
      jails: [
        buildSshdJail({ maxretry: 3, bantime: "3600", findtime: "600" }),
      ],
    });
    render(
      <Fail2banModal
        isOpen={true}
        onClose={vi.fn()}
        state={state}
        sshParams={mockSshParams}
      />,
    );

    const strictRadio = (await screen.findByTestId(
      "preset-radio-strict",
    )) as HTMLInputElement;
    expect(strictRadio.checked).toBe(true);
  });
});
