import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { SecuritySection } from "./SecuritySection";
import type { ServerState } from "./useServerState";
import type {
  FirewallStatus,
  Fail2banStatus,
  JailInfo,
  SecurityStatus,
} from "./useSecurityState";
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

// ── Status builders (characterization helpers) ──────────────────────────────
// The component reads `security.status` (from useSecurityState, which invokes
// `security_get_status`). These builders shape the firewall/fail2ban variants
// the summary subtitles + StatusIndicator depend on.
function makeFirewall(overrides: Partial<FirewallStatus> = {}): FirewallStatus {
  return {
    installed: false,
    active: false,
    default_in: "deny",
    default_out: "allow",
    default_routed: "disabled",
    logging: "low",
    rules: [],
    current_ssh_port: 22,
    vpn_port: null,
    ...overrides,
  };
}

function makeJail(overrides: Partial<JailInfo> = {}): JailInfo {
  return {
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
  };
}

function makeFail2ban(overrides: Partial<Fail2banStatus> = {}): Fail2banStatus {
  return { installed: false, active: false, jails: [], ...overrides };
}

function makeStatus(overrides: Partial<SecurityStatus> = {}): SecurityStatus {
  return {
    firewall: makeFirewall(),
    fail2ban: makeFail2ban(),
    ...overrides,
  };
}

/** Wire `security_get_status` to resolve `status`; everything else null. */
function mockStatus(status: SecurityStatus): void {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "security_get_status") return status;
    return null;
  });
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
  // P UAT 2026-05-04: SSH-ключ card removed per user request — feature
  // не работала надёжно (false-positive uploads, lockout scenarios). Layout
  // now: Firewall + Fail2Ban + CertSection (3 cards).
  it("renders 3 cards: Firewall + Fail2Ban + CertSection", async () => {
    render(<SecuritySection state={makeServerState()} />);
    expect(await screen.findByTestId("firewall-summary-card")).toBeVisible();
    expect(screen.getByTestId("fail2ban-summary-card")).toBeVisible();
    // SSH-ключ card removed — see comment в SecuritySection.tsx
    // CertSection only renders when certRaw is provided. Passing null → no card.
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

  // P UAT 2026-05-04: SSH-ключ Configure button test removed (card удалён из UI).

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

// ════════════════════════════════════════════════════════════════════════════
// Phase 3 safety-net (stream 4a) — gap-fill cases (RESEARCH §3 stream 4):
// loading skeleton, firewall danger/warning/active + plural rule count,
// fail2ban not-installed/no-jail/preset/custom, tt:security-changed dispatch
// after a modal action, aria-live announce. Behavior/aria only (D-04); pins
// current behavior against unchanged production code (D-06).
// ════════════════════════════════════════════════════════════════════════════

describe("SecuritySection — loading skeleton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("shows skeleton placeholders while initial status fetch is in flight", () => {
    // Never-resolving invoke keeps useSecurityState in loading && status===null,
    // which is the `isInitialLoading` branch → skeleton grid.
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
    render(<SecuritySection state={makeServerState()} />);
    expect(screen.getByTestId("security-section-loading")).toBeInTheDocument();
    expect(screen.getByTestId("firewall-card-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("fail2ban-card-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("cert-card-skeleton")).toBeInTheDocument();
    // Real summary cards must NOT be present yet.
    expect(screen.queryByTestId("firewall-summary-card")).not.toBeInTheDocument();
  });

  it("loading wrapper carries aria-live=polite for screen-reader announce", () => {
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
    render(<SecuritySection state={makeServerState()} />);
    expect(screen.getByTestId("security-section-loading")).toHaveAttribute(
      "aria-live",
      "polite",
    );
  });
});

describe("SecuritySection — firewall status variants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  // Both firewall + fail2ban default to «Не установлен», so the status label
  // is asserted scoped WITHIN the firewall card (not the global label query).
  function statusLabelOf(card: HTMLElement): string | null {
    return (
      card.querySelector("[aria-label]")?.getAttribute("aria-label") ?? null
    );
  }

  it("not-installed firewall → danger status label + not-installed subtitle", async () => {
    mockStatus(makeStatus({ firewall: makeFirewall({ installed: false }) }));
    render(<SecuritySection state={makeServerState()} />);
    const card = await screen.findByTestId("firewall-summary-card");
    await waitFor(() => {
      expect(statusLabelOf(card)).toBe(
        i18n.t("server.security.summary.status_not_installed"),
      );
      expect(card).toHaveTextContent(
        i18n.t("server.security.summary.firewall_subtitle_not_installed"),
      );
    });
  });

  it("installed but inactive firewall → inactive status label + inactive subtitle", async () => {
    mockStatus(
      makeStatus({ firewall: makeFirewall({ installed: true, active: false }) }),
    );
    render(<SecuritySection state={makeServerState()} />);
    const card = await screen.findByTestId("firewall-summary-card");
    await waitFor(() => {
      expect(statusLabelOf(card)).toBe(
        i18n.t("server.security.summary.status_inactive"),
      );
      expect(card).toHaveTextContent(
        i18n.t("server.security.summary.firewall_subtitle_inactive"),
      );
    });
  });

  it("active firewall → active status label + pluralized rule count subtitle", async () => {
    // 3 rules → Russian plural «3 правила» (few form). Pins the pluralRu path.
    const rules = [1, 2, 3].map((n) => ({
      number: n,
      to: "any",
      from: "any",
      action: "allow",
      proto: "tcp",
      comment: "",
    }));
    mockStatus(
      makeStatus({
        firewall: makeFirewall({ installed: true, active: true, rules }),
      }),
    );
    render(<SecuritySection state={makeServerState()} />);
    const card = await screen.findByTestId("firewall-summary-card");
    await waitFor(() => {
      expect(statusLabelOf(card)).toBe(
        i18n.t("server.security.summary.status_active"),
      );
      // «3 правила» (few form) — proves pluralRu, not the static «N правил».
      expect(card).toHaveTextContent(/3 правила/);
    });
  });
});

describe("SecuritySection — fail2ban status variants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("not-installed fail2ban → not-installed subtitle", async () => {
    mockStatus(makeStatus({ fail2ban: makeFail2ban({ installed: false }) }));
    render(<SecuritySection state={makeServerState()} />);
    await screen.findByTestId("fail2ban-summary-card");
    await waitFor(() => {
      expect(
        screen.getByText(
          i18n.t("server.security.summary.fail2ban_subtitle_not_installed"),
        ),
      ).toBeVisible();
    });
  });

  it("active fail2ban with no sshd jail → no-jail subtitle", async () => {
    mockStatus(
      makeStatus({
        fail2ban: makeFail2ban({ installed: true, active: true, jails: [] }),
      }),
    );
    render(<SecuritySection state={makeServerState()} />);
    await screen.findByTestId("fail2ban-summary-card");
    await waitFor(() => {
      expect(
        screen.getByText(
          i18n.t("server.security.summary.fail2ban_subtitle_no_jail"),
        ),
      ).toBeVisible();
    });
  });

  it("active fail2ban matching a preset → preset name in subtitle", async () => {
    // FAIL2BAN_PRESETS.balanced = { maxretry: 5, bantime: "600", findtime: "600" }.
    // durationsEqual normalizes "600" → matched preset = «Сбалансированная».
    mockStatus(
      makeStatus({
        fail2ban: makeFail2ban({
          installed: true,
          active: true,
          jails: [
            makeJail({ maxretry: 5, bantime: "600", findtime: "600" }),
          ],
        }),
      }),
    );
    render(<SecuritySection state={makeServerState()} />);
    await screen.findByTestId("fail2ban-summary-card");
    await waitFor(() => {
      const card = screen.getByTestId("fail2ban-summary-card");
      // Subtitle: «{preset} • {retries} попыток до бана» — preset is the
      // localized «Сбалансированная», retries echoes maxretry=5.
      expect(card).toHaveTextContent(
        i18n.t("server.security.fail2ban.presets.balanced"),
      );
      expect(card).toHaveTextContent(/5\s*попыток до бана/i);
    });
  });

  it("active fail2ban with non-preset config → custom preset name in subtitle", async () => {
    // maxretry 7 matches NO preset → presetId "custom" → «Своя конфигурация».
    mockStatus(
      makeStatus({
        fail2ban: makeFail2ban({
          installed: true,
          active: true,
          jails: [
            makeJail({ maxretry: 7, bantime: "999", findtime: "123" }),
          ],
        }),
      }),
    );
    render(<SecuritySection state={makeServerState()} />);
    await screen.findByTestId("fail2ban-summary-card");
    await waitFor(() => {
      const card = screen.getByTestId("fail2ban-summary-card");
      expect(card).toHaveTextContent(
        i18n.t("server.security.fail2ban.presets.custom"),
      );
      expect(card).toHaveTextContent(/7\s*попыток до бана/i);
    });
  });
});

describe("SecuritySection — tt:security-changed dispatch + aria-live", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("dispatches `tt:security-changed` after a firewall action in the modal", async () => {
    // Firewall installed but inactive → clicking the modal toggle calls
    // startFirewall() (no confirm) → onSecurityChanged() → window.dispatchEvent.
    mockStatus(
      makeStatus({ firewall: makeFirewall({ installed: true, active: false }) }),
    );
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<SecuritySection state={makeServerState()} />);

    fireEvent.click(await screen.findByTestId("firewall-configure-button"));
    const toggle = await screen.findByTestId("ufw-toggle-button");
    fireEvent.click(toggle);

    await waitFor(() => {
      const fired = dispatchSpy.mock.calls.some(
        ([ev]) => ev instanceof CustomEvent && ev.type === "tt:security-changed",
      );
      expect(fired).toBe(true);
    });
    dispatchSpy.mockRestore();
  });

  it("rendered root carries aria-live=polite (status changes announced)", async () => {
    mockStatus(makeStatus());
    render(<SecuritySection state={makeServerState()} />);
    const root = await screen.findByTestId("security-section");
    expect(root).toHaveAttribute("aria-live", "polite");
  });
});
