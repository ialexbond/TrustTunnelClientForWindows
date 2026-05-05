import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { SecuritySection } from "./SecuritySection";
import type { ServerState } from "./useServerState";
import { renderWithProviders as render } from "../../test/test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: vi.fn() }),
}));

const mockSshParams = {
  host: "192.168.1.100",
  port: 22,
  user: "root",
  password: "***",
};

function makeServerState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    sshParams: mockSshParams,
    pushSuccess: vi.fn(),
    onPortChanged: vi.fn(),
    certRaw: null,
    setCertRaw: vi.fn(),
    setActionResult: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

beforeEach(() => {
  vi.clearAllMocks();
  i18n.changeLanguage("ru");
  // Default: security_get_status returns minimal SecurityStatus shape (R-9
  // backwards-compat — only firewall + fail2ban). useSecurityState calls this
  // on mount.
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "security_get_status") {
      return {
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
        fail2ban: { installed: false, active: false, jails: [] },
      };
    }
    return null;
  });
});

describe("SecuritySection Phase 16 Plan 05 layout", () => {
  it("renders 4 cards: Firewall + Fail2Ban + SSH-ключ + CertSection", async () => {
    render(<SecuritySection state={makeServerState()} />);
    expect(await screen.findByTestId("firewall-summary-card")).toBeVisible();
    expect(screen.getByTestId("fail2ban-summary-card")).toBeVisible();
    expect(screen.getByTestId("ssh-key-summary-card")).toBeVisible();
    // CertSection only renders when certRaw is provided. Passing null → no card.
    // The 4th block presence is verified separately в next test.
  });

  it("renders CertSection card when certRaw provided (4th block)", async () => {
    const certRaw = {
      issuer: "C = US, O = Let's Encrypt, CN = R3",
      hostname: "vpn.example.com",
      subject: "CN = vpn.example.com",
      notAfter: "2027-06-15T00:00:00Z",
      notBefore: "Apr 28 12:00:00 2026 GMT",
      autoRenew: true,
      sha256Fingerprint:
        "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
    };
    render(<SecuritySection state={makeServerState({ certRaw })} />);
    expect(await screen.findByTestId("firewall-summary-card")).toBeVisible();
    // P1-9 + P1-10 #R+#3 — CertSection теперь summary card; detail (fingerprint,
    // subject CN) перенесены в CertModal. Здесь проверяем что summary card
    // рендерит и subtitle несёт subject CN.
    expect(await screen.findByTestId("cert-summary-card")).toBeVisible();
    await waitFor(() => {
      expect(screen.getByTestId("cert-summary-card")).toHaveTextContent(/vpn\.example\.com/);
    });
  });

  it("Configure button opens FirewallModal", async () => {
    render(<SecuritySection state={makeServerState()} />);
    fireEvent.click(await screen.findByTestId("firewall-configure-button"));
    // Modal title визуальный (FirewallModal uses heading text "Настройка Firewall")
    await waitFor(() =>
      expect(screen.getByText(/настройка брандмауэра/i)).toBeVisible(),
    );
  });

  it("Configure button opens Fail2banModal", async () => {
    render(<SecuritySection state={makeServerState()} />);
    fireEvent.click(await screen.findByTestId("fail2ban-configure-button"));
    // Fail2banModal title — "Настройка Fail2Ban"
    await waitFor(() =>
      expect(screen.getByText(/настройка fail2ban/i)).toBeVisible(),
    );
  });

  it("Configure button opens SshKeyModal", async () => {
    render(<SecuritySection state={makeServerState()} />);
    fireEvent.click(await screen.findByTestId("ssh-key-configure-button"));
    // SshKeyModal title — "SSH-ключ"
    await waitFor(() => {
      // Тут несколько SSH-ключ текстов на странице (card title + modal title) —
      // используем role=heading чтобы ограничить scope до Modal.
      const modalHeading = screen.getAllByRole("heading", { name: /ssh-ключ/i });
      expect(modalHeading.length).toBeGreaterThan(0);
    });
  });

  it("aria-live wrapper preserved on root (screen-reader announce status changes)", async () => {
    render(<SecuritySection state={makeServerState()} />);
    const wrapper = await screen.findByTestId("security-section");
    expect(wrapper).toHaveAttribute("aria-live", "polite");
  });

  it("status text reflects SecurityStatus.firewall.active state", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "security_get_status") {
        return {
          firewall: {
            installed: true,
            active: true,
            default_in: "deny",
            default_out: "allow",
            default_routed: "disabled",
            logging: "low",
            rules: [],
            current_ssh_port: 22,
            vpn_port: null,
          },
          fail2ban: { installed: true, active: true, jails: [] },
        };
      }
      return null;
    });
    render(<SecuritySection state={makeServerState()} />);
    // P UAT 2026-05-04: subtitle упрощён — теперь только rules count с правильной
    // плюрализацией (без «SSH порт 22 открыт» — useless info per user feedback).
    await waitFor(() => {
      // Firewall subtitle: «0 правил» (Russian plural for 0).
      expect(screen.getByText(/0\s*правил/i)).toBeVisible();
      // Fail2Ban: jails=[] → "no_jail" subtitle
      expect(screen.getByText(/jail для SSH не настроен/i)).toBeVisible();
    });
  });
});
