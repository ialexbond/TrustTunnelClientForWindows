import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { CertSection } from "./CertSection";
import { renderWithProviders as render } from "../../test/test-utils";
import type { ServerState } from "./useServerState";
import { makeCertState, mockSecurityFactory } from "../../test/fixtures";

// CertSection auto-fetches `server_get_cert_info` on mount when certRaw === null
// (see CertSection.tsx mount effect). Mock the Tauri bridge so the loading →
// loaded transition and the error → pushSuccess path are observable.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

/**
 * P1-9 + P1-10 #R+#3 — CertSection rewritten как summary card matching
 * 4-cards pattern (Firewall/Fail2Ban/SSH-key). Detail UI moved в CertModal —
 * detail-level tests live в CertModal.test.tsx (separate file).
 *
 * These tests cover the summary card behavior + the mount lifecycle:
 *   - Skeleton while the initial cert fetch is in flight
 *   - Auto-fetch `server_get_cert_info` on mount when certRaw is null
 *   - Error → `state.pushSuccess(_, "error")` when the fetch rejects
 *   - certbot timer pre-fetch (`loadCertbotTimerStatus`) on mount
 *   - Status pill variant reflects daysLeft (success/warning/danger/expired)
 *   - «Подробнее» CTA enabled/disabled by certInfo presence + opens Modal
 *
 * D-04: assertions are role/aria/text/testid only — never class selectors.
 */

// Use the shared Wave-0 cert/security fixtures (RESEARCH §3 stream 4 / §4.1)
// instead of re-declaring local mocks. `makeCertState()` defaults to an
// ok-band Let's Encrypt cert object; override `certRaw` for other bands.

const mockSecurity = mockSecurityFactory();

// Day-band cert literals (objects — parseCertInfo accepts both object + string).
// notAfter relative to now drives the StatusIndicator tone band.
function certDaysFromNow(daysFromNow: number): unknown {
  return {
    hostname: "vpn.example.com",
    notAfter: new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString(),
    notBefore: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    subject: "CN = vpn.example.com",
    issuer: "C = US, O = Let's Encrypt, CN = R3",
  };
}

const sampleLetsEncryptCert = certDaysFromNow(67); // ok band (> 30 days)
const sampleWarningCert = certDaysFromNow(20); // warning band (8–30 days)
const sampleExpiringCert = certDaysFromNow(5); // danger band (≤ 7 days)
const sampleExpiredCert = certDaysFromNow(-3); // expired (≤ 0 days)
const sampleSelfSignedCert = {
  hostname: "internal.local",
  notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  subject: "CN = internal.local",
  issuer: "CN = internal.local",
};

function stateWith(certRaw: unknown, overrides: Partial<ServerState> = {}): ServerState {
  return makeCertState({ certRaw, ...overrides } as Partial<ServerState>);
}

describe("CertSection summary card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("renders summary card title", async () => {
    render(<CertSection state={stateWith(sampleLetsEncryptCert)} security={mockSecurity} />);
    expect(await screen.findByTestId("cert-summary-card")).toBeVisible();
    expect(screen.getByText(/TLS Сертификат/i)).toBeVisible();
  });

  it("subtitle shows issuer + subject (compact)", async () => {
    render(<CertSection state={stateWith(sampleLetsEncryptCert)} security={mockSecurity} />);
    await waitFor(() => {
      expect(screen.getByTestId("cert-summary-card")).toHaveTextContent(/Let's Encrypt/i);
      expect(screen.getByTestId("cert-summary-card")).toHaveTextContent(/vpn\.example\.com/);
    });
  });

  it("status pill aria-label says «Действителен N дней» for valid cert", async () => {
    render(<CertSection state={stateWith(sampleLetsEncryptCert)} security={mockSecurity} />);
    // StatusIndicator renders label as aria-label (not visible text), so query
    // by aria-label rather than text content.
    await waitFor(() => {
      expect(screen.getByLabelText(/Действителен/i)).toBeInTheDocument();
    });
  });

  // ── Mount lifecycle ──────────────────────────────────────────────────────

  it("shows the loading skeleton while the initial cert fetch is in flight", () => {
    // Pending invoke (never resolves) keeps the component in the pre-fetch
    // skeleton branch (certFetched === false → cert-summary-card-loading).
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));
    render(<CertSection state={stateWith(null)} security={mockSecurity} />);
    expect(screen.getByTestId("cert-summary-card-loading")).toBeInTheDocument();
    // Real card not yet mounted while loading.
    expect(screen.queryByTestId("cert-summary-card")).toBeNull();
  });

  it("auto-fetches server_get_cert_info on mount when certRaw is null", async () => {
    const setCertRaw = vi.fn();
    const fetched = certDaysFromNow(40);
    vi.mocked(invoke).mockResolvedValueOnce(fetched);
    render(
      <CertSection
        state={stateWith(null, { setCertRaw })}
        security={mockSecurity}
      />,
    );
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "server_get_cert_info",
        expect.objectContaining({ host: "10.0.0.1" }),
      );
    });
    // The successful response is pushed back up via setCertRaw.
    await waitFor(() => expect(setCertRaw).toHaveBeenCalledWith(fetched));
  });

  it("reports a fetch failure via state.pushSuccess(_, 'error')", async () => {
    const pushSuccess = vi.fn();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("ssh dial failed"));
    render(
      <CertSection
        state={stateWith(null, { pushSuccess })}
        security={mockSecurity}
      />,
    );
    await waitFor(() => {
      expect(pushSuccess).toHaveBeenCalledWith(expect.any(String), "error");
    });
    // After the fetch settles (error), the real card replaces the skeleton.
    await waitFor(() =>
      expect(screen.getByTestId("cert-summary-card")).toBeInTheDocument(),
    );
  });

  it("pre-fetches the certbot timer status on mount (loadCertbotTimerStatus)", async () => {
    // RESEARCH §3 stream 4: the real loadCertbotTimerStatus assertion belongs
    // in CertSection (the parent that prefetches), NOT CertModal — this
    // replaces the former CertModal:118 empty test.
    const security = mockSecurityFactory();
    render(<CertSection state={stateWith(sampleLetsEncryptCert)} security={security} />);
    await waitFor(() => {
      expect(security.loadCertbotTimerStatus).toHaveBeenCalled();
    });
  });

  // ── Tone bands ───────────────────────────────────────────────────────────

  it("renders warning-band cert (8–30 days) without crash", async () => {
    render(<CertSection state={stateWith(sampleWarningCert)} security={mockSecurity} />);
    await waitFor(() => {
      expect(screen.getByTestId("cert-summary-card")).toBeVisible();
      expect(screen.getByLabelText(/Действителен/i)).toBeInTheDocument();
    });
  });

  it("renders without crash for danger-zone cert (≤7 days)", async () => {
    render(<CertSection state={stateWith(sampleExpiringCert)} security={mockSecurity} />);
    await waitFor(() => {
      expect(screen.getByTestId("cert-summary-card")).toBeVisible();
    });
    // Visual variant smoke check — StatusIndicator color принадлежит его unit test.
  });

  it("shows «Истёк» status for an expired cert (≤0 days)", async () => {
    render(<CertSection state={stateWith(sampleExpiredCert)} security={mockSecurity} />);
    await waitFor(() => {
      expect(screen.getByLabelText(new RegExp(i18n.t("server.security.summary.cert_status_expired"), "i"))).toBeInTheDocument();
    });
  });

  // ── CTA ──────────────────────────────────────────────────────────────────

  it("«Подробнее» CTA disabled when no cert", async () => {
    // Resolve the auto-fetch with null so certInfo stays null but the skeleton
    // clears (certFetched flips true) and the disabled CTA renders.
    vi.mocked(invoke).mockResolvedValue(null);
    render(<CertSection state={stateWith(null)} security={mockSecurity} />);
    const btn = await screen.findByTestId("cert-configure-button");
    expect(btn).toBeDisabled();
  });

  it("«Подробнее» CTA opens Modal when clicked", async () => {
    render(<CertSection state={stateWith(sampleLetsEncryptCert)} security={mockSecurity} />);
    const btn = await screen.findByTestId("cert-configure-button");
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    // Modal opens — Card title (h3) + Modal title (h2) = 2 instances of «TLS Сертификат».
    await waitFor(() => {
      const headings = screen.getAllByText(/TLS Сертификат/i);
      expect(headings.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("self-signed cert shown in subtitle", async () => {
    render(<CertSection state={stateWith(sampleSelfSignedCert)} security={mockSecurity} />);
    await waitFor(() => {
      expect(screen.getByTestId("cert-summary-card")).toHaveTextContent(/internal\.local/);
    });
  });
});
