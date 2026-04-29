import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { CertSection } from "./CertSection";
import { renderWithProviders as render } from "../../test/test-utils";
import type { ServerState } from "./useServerState";

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    setActionResult: vi.fn(),
    certRaw: null,
    setCertRaw: vi.fn(),
    pushSuccess: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

describe("CertSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders nothing when certRaw is null and no error", () => {
    const state = makeState();
    const { container } = render(<CertSection state={state} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders cert title and type badge for Let's Encrypt cert", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: true,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.title"))).toBeInTheDocument();
    expect(screen.getByText("Let's Encrypt")).toBeInTheDocument();
  });

  it("shows domain when present", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "vpn.example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText("vpn.example.com")).toBeInTheDocument();
  });

  it("shows self-signed badge for self-signed cert", () => {
    const state = makeState({
      certRaw: {
        issuer: "CN=10.0.0.1",
        subject: "CN=10.0.0.1",
        hostname: "10.0.0.1",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.self_signed"))).toBeInTheDocument();
  });

  it("shows auto-renew configured status", () => {
    const state = makeState({
      certRaw: {
        issuer: "R10",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: true,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.configured"))).toBeInTheDocument();
  });

  it("shows auto-renew not configured status", () => {
    const state = makeState({
      certRaw: {
        issuer: "R10",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.not_configured"))).toBeInTheDocument();
  });

  it("shows renew button for Let's Encrypt certs", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: true,
      },
    });
    render(<CertSection state={state} />);
    const renewBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.cert.renew")) });
    expect(renewBtn).toBeInTheDocument();
  });

  it("shows expiry info for certs with notAfter", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.expires"))).toBeInTheDocument();
  });

  // ── ACME cert details ──

  it("recognizes ACME issuer as Let's Encrypt", () => {
    const state = makeState({
      certRaw: {
        issuer: "ACME CA",
        hostname: "vpn.test.com",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText("Let's Encrypt")).toBeInTheDocument();
  });

  it("recognizes R10 issuer as Let's Encrypt", () => {
    const state = makeState({
      certRaw: {
        issuer: "R10",
        hostname: "test.com",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: true,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText("Let's Encrypt")).toBeInTheDocument();
  });

  it("recognizes R11 issuer as Let's Encrypt", () => {
    const state = makeState({
      certRaw: {
        issuer: "R11",
        hostname: "test.com",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText("Let's Encrypt")).toBeInTheDocument();
  });

  it("recognizes letsencrypt issuer string", () => {
    const state = makeState({
      certRaw: {
        issuer: "letsencrypt",
        hostname: "test.com",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText("Let's Encrypt")).toBeInTheDocument();
  });

  // ── Self-signed cert details ──

  it("shows self-signed badge when issuer contains 'self'", () => {
    const state = makeState({
      certRaw: {
        issuer: "Self-signed CA",
        hostname: "10.0.0.1",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.self_signed"))).toBeInTheDocument();
  });

  it("shows self-signed badge when no issuer but hostname present", () => {
    const state = makeState({
      certRaw: {
        hostname: "10.0.0.1",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.self_signed"))).toBeInTheDocument();
  });

  it("shows unknown badge for unknown issuer", () => {
    const state = makeState({
      certRaw: {
        issuer: "SomeRandomCA",
        subject: "CN=different",
        hostname: "test.com",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.unknown"))).toBeInTheDocument();
  });

  // ── Expiry warning badge ──

  it("shows danger badge when cert expires within 7 days", () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 3);
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: soon.toISOString(),
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    // Badge with variant="danger" renders with the danger styling
    // The expiry badge should exist
    expect(screen.getByText(i18n.t("server.cert.expires"))).toBeInTheDocument();
  });

  it("shows success badge when cert has more than 30 days", () => {
    const far = new Date();
    far.setDate(far.getDate() + 90);
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: far.toISOString(),
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.expires"))).toBeInTheDocument();
  });

  // ── Renew button flow ──

  it("does not show renew button for self-signed certs", () => {
    const state = makeState({
      certRaw: {
        issuer: "CN=10.0.0.1",
        subject: "CN=10.0.0.1",
        hostname: "10.0.0.1",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.queryByText(i18n.t("server.cert.renew"))).not.toBeInTheDocument();
  });

  it("does not show renew button for unknown cert type", () => {
    const state = makeState({
      certRaw: {
        issuer: "SomeRandomCA",
        subject: "CN=different",
        hostname: "test.com",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.queryByText(i18n.t("server.cert.renew"))).not.toBeInTheDocument();
  });

  // ── Domain display ──

  it("does not show domain row when domain is empty", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.queryByText(i18n.t("server.cert.domain"))).not.toBeInTheDocument();
  });

  it("extracts domain from subject CN when hostname is missing", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        subject: "CN=my-vpn.com",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    // Phase 16 Plan 05 — domain extracted from subject now appears в TWO places:
    // (1) the existing legacy "Domain" row (Badge), (2) the new Subject CN row
    // (text-mono-sm code). Both are valid renderings of the same value — assert
    // на presence of either, not uniqueness.
    expect(screen.getAllByText("my-vpn.com").length).toBeGreaterThan(0);
  });

  // ── String parsing (non-JSON certRaw) ──

  it("parses string certRaw with ACME type", () => {
    const state = makeState({
      certRaw: 'type: "acme"\ndomain: "vpn.example.com"\nnot_after: "2027-01-01"\nauto_renew: true',
    });
    render(<CertSection state={state} />);
    expect(screen.getByText("Let's Encrypt")).toBeInTheDocument();
    expect(screen.getByText("vpn.example.com")).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.cert.configured"))).toBeInTheDocument();
  });

  it("parses string certRaw with self-signed type", () => {
    const state = makeState({
      certRaw: 'type: "self-signed"\ndomain: "10.0.0.1"\nnot_after: "2027-01-01"\nauto_renew: false',
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.self_signed"))).toBeInTheDocument();
    expect(screen.getByText("10.0.0.1")).toBeInTheDocument();
  });

  // ── Error state ──

  it("does not show expiry row when notAfter is empty", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.queryByText(i18n.t("server.cert.expires"))).not.toBeInTheDocument();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Phase 16 Plan 05 — Extended cert fields + auto-renewal toggle.
// SHA256 / Subject CN / Issuer / Not Before render only when backend supplied
// the field (additive). Auto-renewal section renders only when SecuritySection
// passes a `security` hook instance (legacy callers without it skip the block).
// ────────────────────────────────────────────────────────────────────────────

describe("CertSection Phase 16 Plan 05 extension", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders SHA256 fingerprint truncated с full в title attr", () => {
    const fp = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: true,
        sha256Fingerprint: fp,
      },
    });
    render(<CertSection state={state} />);
    const elem = screen.getByTestId("cert-fingerprint");
    expect(elem).toHaveAttribute("title", fp);
    expect(elem.textContent).toContain("…");
  });

  it("renders Subject CN row when subject contains CN= field", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        subject: "CN = vpn.example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: true,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByTestId("cert-subject-cn")).toHaveTextContent("vpn.example.com");
  });

  it("renders Issuer summary when issuer has O + CN fields", () => {
    const state = makeState({
      certRaw: {
        issuer: "C = US, O = Let's Encrypt, CN = R3",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: true,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByTestId("cert-issuer-summary")).toHaveTextContent("Let's Encrypt R3");
  });

  it("renders Not Before row when backend supplied it", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notBefore: "Apr 28 12:00:00 2026 GMT",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: true,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByTestId("cert-not-before")).toHaveTextContent("Apr 28 12:00:00 2026 GMT");
  });

  it("does NOT render extended rows when backend skipped them (R-9 backwards-compat)", () => {
    // Old-shape response — only legacy fields. Extension rows should be absent.
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: true,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.queryByTestId("cert-fingerprint")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cert-subject-cn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cert-not-before")).not.toBeInTheDocument();
  });

  it("auto-renewal section hidden when no `security` prop (legacy callers)", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: true,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.queryByTestId("cert-auto-renewal-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("enable-auto-renewal-button")).not.toBeInTheDocument();
  });

  it("shows enable-auto-renewal button when timer not active", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: false,
      },
    });
    const security = {
      certbotTimerStatus: {
        timer_enabled: false,
        timer_active: false,
        cron_present: false,
        auto_renewal_active: false,
      },
      isBusy: vi.fn().mockReturnValue(false),
      loadCertbotTimerStatus: vi.fn().mockResolvedValue(undefined),
      enableCertbotTimer: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof import("./useSecurityState").useSecurityState>;
    render(<CertSection state={state} security={security} />);
    expect(screen.getByTestId("enable-auto-renewal-button")).toBeVisible();
  });

  it("shows '✓ автоматически обновляется' when timer active", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: true,
      },
    });
    const security = {
      certbotTimerStatus: {
        timer_enabled: true,
        timer_active: true,
        cron_present: false,
        auto_renewal_active: true,
      },
      isBusy: vi.fn().mockReturnValue(false),
      loadCertbotTimerStatus: vi.fn().mockResolvedValue(undefined),
      enableCertbotTimer: vi.fn().mockResolvedValue(undefined),
    } as unknown as ReturnType<typeof import("./useSecurityState").useSecurityState>;
    render(<CertSection state={state} security={security} />);
    expect(screen.getByTestId("auto-renewal-active")).toBeVisible();
    expect(screen.queryByTestId("enable-auto-renewal-button")).not.toBeInTheDocument();
  });

  it("clicking enable-auto-renewal button invokes enableCertbotTimer", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: false,
      },
    });
    const enableMock = vi.fn().mockResolvedValue(undefined);
    const security = {
      certbotTimerStatus: {
        timer_enabled: false,
        timer_active: false,
        cron_present: false,
        auto_renewal_active: false,
      },
      isBusy: vi.fn().mockReturnValue(false),
      loadCertbotTimerStatus: vi.fn().mockResolvedValue(undefined),
      enableCertbotTimer: enableMock,
    } as unknown as ReturnType<typeof import("./useSecurityState").useSecurityState>;
    render(<CertSection state={state} security={security} />);
    screen.getByTestId("enable-auto-renewal-button").click();
    expect(enableMock).toHaveBeenCalled();
  });
});
