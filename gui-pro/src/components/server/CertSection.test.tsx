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

  it("subtitle shows the cert type + the real server address", async () => {
    // CP-1c (16-12): the address is state.sshParams.host (the real server host);
    // for a domain server that equals the domain.
    const state = stateWith(sampleLetsEncryptCert, {
      sshParams: { host: "vpn.example.com", port: 22, user: "root", password: "" },
    } as Partial<ServerState>);
    render(<CertSection state={state} security={mockSecurity} />);
    await waitFor(() => {
      expect(screen.getByTestId("cert-summary-card")).toHaveTextContent(/Let's Encrypt/i);
      expect(screen.getByTestId("cert-summary-card")).toHaveTextContent(/vpn\.example\.com/);
    });
  });

  it("cert-type-aware address (CP-1d): LE → cert DOMAIN even when host is a bare IP; self-signed → the server IP", async () => {
    // Let's Encrypt: the SSH host is a bare IP, but an LE cert is for a DOMAIN → show the domain.
    const le = stateWith(sampleLetsEncryptCert, {
      sshParams: { host: "203.0.113.9", port: 22, user: "root", password: "" },
    } as Partial<ServerState>);
    const { unmount } = render(<CertSection state={le} security={mockSecurity} />);
    await waitFor(() => {
      const card = screen.getByTestId("cert-summary-card");
      expect(card).toHaveTextContent(/vpn\.example\.com/); // domain from the cert
      expect(card).not.toHaveTextContent(/203\.0\.113\.9/); // NOT the bare IP
    });
    unmount();
    // Self-signed: the cert CN is the internal «internal.local» placeholder → show the server IP.
    const ss = stateWith(sampleSelfSignedCert, {
      sshParams: { host: "203.0.113.141", port: 22, user: "root", password: "" },
    } as Partial<ServerState>);
    render(<CertSection state={ss} security={mockSecurity} />);
    await waitFor(() => {
      const card = screen.getByTestId("cert-summary-card");
      expect(card).toHaveTextContent(/13\.143\.139\.141/); // the server IP
      expect(card).not.toHaveTextContent(/internal\.local/); // NOT the fake CN
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

  it("UAT-6: «Подробнее» CTA disabled when a cert payload arrives but is unreadable (notAfter empty)", async () => {
    // A missing/unreadable cert can arrive as a non-null payload with an empty
    // notAfter. parseCertInfo then returns a non-null object (certType unknown),
    // so the old `disabled={!certInfo}` gate left the button ENABLED — opening a
    // details modal for a cert that is not there. The CTA must gate on
    // readability (certInfo.notAfter present), not on certInfo being non-null.
    const missingCert = { hostname: "vpn.example.com", notAfter: "", issuer: "", subject: "" };
    render(<CertSection state={stateWith(missingCert)} security={mockSecurity} />);
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

  it("self-signed cert subtitle shows the type + the real server address (not the .local subject CN)", async () => {
    // CP-1c (16-12): a self-signed cert's subject CN is the internal .local SNI;
    // the subtitle now shows the real server host (sshParams.host), not that CN.
    const state = stateWith(sampleSelfSignedCert, {
      sshParams: { host: "203.0.113.55", port: 22, user: "root", password: "" },
    } as Partial<ServerState>);
    render(<CertSection state={state} security={mockSecurity} />);
    await waitFor(() => {
      const card = screen.getByTestId("cert-summary-card");
      expect(card).toHaveTextContent(new RegExp(i18n.t("server.cert.self_signed"), "i"));
      expect(card).toHaveTextContent("203.0.113.55");
    });
    // The internal .local subject CN is not surfaced as the address.
    expect(screen.getByTestId("cert-summary-card").textContent ?? "").not.toContain("internal.local");
  });

  // ── CP-1c (16-12): cert TYPE + the REAL server address (IP), not .local ────

  it("CP-1c: self-signed subtitle shows the «Self-signed» type label + the REAL server IP, and NEVER trusttunnel.local", async () => {
    // A self-signed cert's subject CN is the internal SNI placeholder
    // «trusttunnel.local». The owner wants the REAL server address — the IP the
    // app connects to (state.sshParams.host = "203.0.113.141") — plus the type,
    // and NEVER the .local placeholder.
    const selfSigned = {
      present: true,
      hostname: "trusttunnel.local",
      notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      subject: "CN = trusttunnel.local",
      issuer: "CN = trusttunnel.local",
    };
    const state = stateWith(selfSigned, {
      sshParams: { host: "203.0.113.141", port: 22, user: "root", password: "" },
    } as Partial<ServerState>);
    render(<CertSection state={state} security={mockSecurity} />);
    const card = await screen.findByTestId("cert-summary-card");
    await waitFor(() => {
      // The certificate TYPE label is present.
      expect(card).toHaveTextContent(new RegExp(i18n.t("server.cert.self_signed"), "i"));
    });
    // The REAL server IP is shown as the address.
    expect(card).toHaveTextContent("203.0.113.141");
    // The internal .local SNI placeholder is NEVER rendered.
    expect(card.textContent ?? "").not.toContain("trusttunnel.local");
  });

  it("CP-1c: Let's Encrypt subtitle shows the «Let's Encrypt» type label + the real server address (= the domain)", async () => {
    // For a real domain server sshParams.host IS the domain, so showing
    // sshParams.host still reads as the domain. CP-1c: the address is always the
    // real server host, which for LE equals the domain the user entered.
    const state = stateWith(sampleLetsEncryptCert, {
      sshParams: { host: "vpn.example.com", port: 22, user: "root", password: "" },
    } as Partial<ServerState>);
    render(<CertSection state={state} security={mockSecurity} />);
    const card = await screen.findByTestId("cert-summary-card");
    await waitFor(() => {
      expect(card).toHaveTextContent(new RegExp(i18n.t("server.cert.lets_encrypt"), "i"));
      expect(card).toHaveTextContent(/vpn\.example\.com/);
    });
  });

  // ── R2-F06 / R2-F07 (Plan 09-36): missing-cert label + separated domain ────

  // A missing/unreadable cert now arrives with present:false + empty notAfter,
  // but the hostname (from hosts.toml) is still populated. The card must:
  //  - label it «Сертификат не найден / не читается» (NOT «Неизвестно»)
  //  - render the address as its own «Адрес сервера: <domain>» element instead
  //    of gluing the domain into the cert-state subtitle.
  const missingCert = {
    present: false,
    hostname: "vpn.example.com",
    notAfter: "",
    issuer: "",
    subject: "",
  };

  // A PRESENT but unrecognized cert (present:true, the cert is THERE but its
  // validity is unreadable → daysLeft null) must STILL read «Неизвестно» — the
  // new missing label must not swallow this legitimate present-but-unknown case.
  // (A present cert with a readable, valid notAfter shows the validity band
  // instead; «Неизвестно» is the present-but-unparsed-validity state.)
  const presentUnknownTypeCert = {
    present: true,
    hostname: "vpn.example.com",
    notAfter: "garbled-unparseable-date",
    issuer: "C = US, O = Some Other CA, CN = X9",
    subject: "CN = some.other.host",
  };

  it("R2-F06: a missing/unreadable cert reads «Сертификат не найден / не читается», not «Неизвестно»", async () => {
    render(<CertSection state={stateWith(missingCert)} security={mockSecurity} />);
    await waitFor(() => {
      expect(
        screen.getByLabelText(new RegExp(i18n.t("server.security.summary.cert_status_missing"), "i")),
      ).toBeInTheDocument();
    });
    // The ambiguous unknown label must NOT appear for a missing cert.
    expect(
      screen.queryByLabelText(new RegExp(`^${i18n.t("server.security.summary.cert_status_unknown")}$`, "i")),
    ).toBeNull();
  });

  it("R2-F06: a PRESENT cert of an unrecognized type still reads «Неизвестно»", async () => {
    render(<CertSection state={stateWith(presentUnknownTypeCert)} security={mockSecurity} />);
    await waitFor(() => {
      expect(
        screen.getByLabelText(new RegExp(`^${i18n.t("server.security.summary.cert_status_unknown")}$`, "i")),
      ).toBeInTheDocument();
    });
    // The missing label must NOT appear for a present-but-unknown-type cert.
    expect(
      screen.queryByLabelText(new RegExp(i18n.t("server.security.summary.cert_status_missing"), "i")),
    ).toBeNull();
  });

  it("R2-F07: a missing cert renders the address as its own «Адрес сервера: <domain>» element, not concatenated into the cert state", async () => {
    render(<CertSection state={stateWith(missingCert)} security={mockSecurity} />);
    const card = await screen.findByTestId("cert-summary-card");
    await waitFor(() => {
      // The dedicated neutral address element is present.
      expect(
        screen.getByText(
          new RegExp(i18n.t("server.security.summary.cert_address", { domain: "vpn\\.example\\.com" })),
        ),
      ).toBeInTheDocument();
    });
    // The cert-state subtitle must NOT glue the domain onto the cert state via
    // the «issuer • domain • …» bullet-join (the old contradictory shape).
    expect(card).not.toHaveTextContent(/•\s*vpn\.example\.com/);
  });

  // ── R3-F03 (Plan 09-39): VISIBLE missing-cert label alongside the address ──

  // The R2-F07 domain-separation (09-36) left the «не найден / не читается»
  // status ONLY as the small StatusIndicator aria/dot label (getByLabelText),
  // so the owner could not SEE the explicit text in the card — the prominent
  // text line became the address. R3-F03: render the missing label as a VISIBLE
  // text element (data-testid="cert-status-label") ALONGSIDE the address line so
  // BOTH are present.
  it("R3-F03: a missing cert shows the VISIBLE «Сертификат не найден / не читается» label AND the «Адрес сервера: <domain>» line", async () => {
    render(<CertSection state={stateWith(missingCert)} security={mockSecurity} />);
    await screen.findByTestId("cert-summary-card");
    await waitFor(() => {
      // The missing-cert status now renders as a VISIBLE text element, not only
      // as the StatusIndicator aria label.
      const label = screen.getByTestId("cert-status-label");
      expect(label).toBeVisible();
      expect(label).toHaveTextContent(
        new RegExp(i18n.t("server.security.summary.cert_status_missing")),
      );
    });
    // The address line is still present alongside the visible status label.
    expect(
      screen.getByText(
        new RegExp(i18n.t("server.security.summary.cert_address", { domain: "vpn\\.example\\.com" })),
      ),
    ).toBeInTheDocument();
  });

  it("R3-F03: a present-but-unknown-type cert still reads «Неизвестно» and renders NO visible missing label", async () => {
    render(<CertSection state={stateWith(presentUnknownTypeCert)} security={mockSecurity} />);
    await screen.findByTestId("cert-summary-card");
    await waitFor(() => {
      expect(
        screen.getByLabelText(new RegExp(`^${i18n.t("server.security.summary.cert_status_unknown")}$`, "i")),
      ).toBeInTheDocument();
    });
    // The new visible missing-cert label must NOT swallow the present-but-unknown
    // state — no cert-status-label element and no missing text at all.
    expect(screen.queryByTestId("cert-status-label")).toBeNull();
    expect(
      screen.queryByText(new RegExp(i18n.t("server.security.summary.cert_status_missing"))),
    ).toBeNull();
  });
});
