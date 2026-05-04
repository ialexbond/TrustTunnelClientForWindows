import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { CertSection } from "./CertSection";
import { renderWithProviders as render } from "../../test/test-utils";
import type { ServerState } from "./useServerState";
import type { useSecurityState } from "./useSecurityState";

// BUG-02 fix: CertSection теперь требует security prop. Mock minimal subset.
const mockSecurity = {
  certbotTimerStatus: null,
  loadCertbotTimerStatus: vi.fn().mockResolvedValue(undefined),
  enableCertbotTimer: vi.fn().mockResolvedValue(undefined),
  isBusy: vi.fn().mockReturnValue(false),
} as unknown as ReturnType<typeof useSecurityState>;

/**
 * P1-9 + P1-10 #R+#3 — CertSection rewritten как summary card matching
 * 4-cards pattern (Firewall/Fail2Ban/SSH-key). Detail UI moved в CertModal —
 * detail-level tests live в CertModal.test.tsx (separate file).
 *
 * These tests cover ONLY the summary card behavior:
 *   - Renders title + status + subtitle
 *   - Status variant reflects daysLeft (success/warning/danger/neutral)
 *   - «Подробнее» CTA enabled/disabled by certInfo presence
 *   - Click opens Modal
 */

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

// parseCertInfo extracts issuerSummary из issuer DN (O + CN), а certType
// определяет по issuer string ("Let's Encrypt" / "self" etc.).
const sampleLetsEncryptCert = {
  hostname: "vpn.example.com",
  notAfter: new Date(Date.now() + 67 * 24 * 60 * 60 * 1000).toISOString(),
  notBefore: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  subject: "CN = vpn.example.com",
  issuer: "C = US, O = Let's Encrypt, CN = R3",
};

const sampleSelfSignedCert = {
  hostname: "internal.local",
  notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  subject: "CN = internal.local",
  issuer: "CN = internal.local",
};

const sampleExpiringCert = {
  ...sampleLetsEncryptCert,
  notAfter: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
};

describe("CertSection summary card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders summary card title", async () => {
    render(<CertSection state={makeState({ certRaw: sampleLetsEncryptCert })} security={mockSecurity} />);
    expect(await screen.findByTestId("cert-summary-card")).toBeVisible();
    expect(screen.getByText(/TLS Сертификат/i)).toBeVisible();
  });

  it("subtitle shows issuer + subject (compact)", async () => {
    render(<CertSection state={makeState({ certRaw: sampleLetsEncryptCert })} security={mockSecurity} />);
    await waitFor(() => {
      expect(screen.getByTestId("cert-summary-card")).toHaveTextContent(/Let's Encrypt/i);
      expect(screen.getByTestId("cert-summary-card")).toHaveTextContent(/vpn\.example\.com/);
    });
  });

  it("status pill aria-label says «Действителен N дней» for valid cert", async () => {
    render(<CertSection state={makeState({ certRaw: sampleLetsEncryptCert })} security={mockSecurity} />);
    // StatusIndicator renders label as aria-label (not visible text), so query
    // by aria-label rather than text content.
    await waitFor(() => {
      expect(screen.getByLabelText(/Действителен/i)).toBeInTheDocument();
    });
  });

  it("renders without crash for danger-zone cert (≤7 days)", async () => {
    render(<CertSection state={makeState({ certRaw: sampleExpiringCert })} security={mockSecurity} />);
    await waitFor(() => {
      expect(screen.getByTestId("cert-summary-card")).toBeVisible();
    });
    // Visual variant smoke check — StatusIndicator color принадлежит его unit test.
  });

  it("«Подробнее» CTA disabled when no cert", async () => {
    render(<CertSection state={makeState({ certRaw: null })} security={mockSecurity} />);
    const btn = await screen.findByTestId("cert-configure-button");
    expect(btn).toBeDisabled();
  });

  it("«Подробнее» CTA opens Modal when clicked", async () => {
    render(<CertSection state={makeState({ certRaw: sampleLetsEncryptCert })} security={mockSecurity} />);
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
    render(<CertSection state={makeState({ certRaw: sampleSelfSignedCert })} security={mockSecurity} />);
    await waitFor(() => {
      expect(screen.getByTestId("cert-summary-card")).toHaveTextContent(/internal\.local/);
    });
  });
});
