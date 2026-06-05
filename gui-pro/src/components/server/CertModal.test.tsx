import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { CertModal } from "./CertModal";
import { renderWithProviders as render } from "../../test/test-utils";
import type { ServerState } from "./useServerState";
import {
  makeCertState,
  mockSecurityFactory,
  installActivityLogSpy,
  expectNoSecretLogged,
} from "../../test/fixtures";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

// CertModal itself does not consume useActivityLog (renew errors go to the
// SnackBar toast via state.pushSuccess, and the certbot output is rendered in
// the expandable `cert-renew-output` <pre>). We still wire the shared named
// activity-log spy so the D-29 renew-error assertion can prove the certbot
// error output NEVER reaches the activity-log channel from this surface.
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: installActivityLogSpy().spy }),
}));

const sampleLetsEncryptCert = {
  hostname: "vpn.example.com",
  notAfter: new Date(Date.now() + 67 * 24 * 60 * 60 * 1000).toISOString(),
  notBefore: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  subject: "CN = vpn.example.com",
  issuer: "C = US, O = Let's Encrypt, CN = R3",
};

// Self-signed cert (issuer === subject, no Let's Encrypt marker) → certType
// "self_signed" → renew action footer is hidden (certbot only renews LE certs).
const sampleSelfSignedCert = {
  hostname: "internal.local",
  notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
  notBefore: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  subject: "CN = internal.local",
  issuer: "CN = internal.local",
};

// Cert with no notBefore → validity block renders the «до <notAfter>» fallback
// instead of the «from — to» range (BUG-12 path).
const sampleNoNotBeforeCert = {
  hostname: "vpn.example.com",
  notAfter: new Date(Date.now() + 67 * 24 * 60 * 60 * 1000).toISOString(),
  subject: "CN = vpn.example.com",
  issuer: "C = US, O = Let's Encrypt, CN = R3",
};

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return makeCertState({ certRaw: sampleLetsEncryptCert, ...overrides } as Partial<ServerState>);
}

/**
 * The renew flow opens a ConfirmDialog (rendered by ConfirmDialogProvider from
 * renderWithProviders). Both the modal footer and the dialog carry a button
 * labelled «Обновить сертификат», so we scope to the dialog via its unique
 * confirm message text, then click the confirm button inside that dialog.
 */
async function clickConfirmDialogRenew(): Promise<void> {
  const message = await screen.findByText(i18n.t("server.cert.renew_confirm_message"));
  // The dialog button row is a sibling of the message within the same dialog
  // content wrapper (ConfirmDialog: h3 + p[message] + div[buttons]).
  const dialogBody = message.parentElement as HTMLElement;
  const confirmBtn = within(dialogBody).getByRole("button", {
    name: new RegExp(i18n.t("server.cert.renew")),
  });
  fireEvent.click(confirmBtn);
}

describe("CertModal (P1-9 + P1-10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installActivityLogSpy(); // reset shared spy call history each test
    i18n.changeLanguage("ru");
  });

  // ── Layout (FIXED false greens :47 / :93) ─────────────────────────────────

  it("renders the 3 informative blocks when open + certInfo present", async () => {
    // FIX false-green CertModal:47 — the old test asserted a tautological
    // negative (`queryByTestId("cert-fingerprint")` for a testid that never
    // existed, so it trivially passed). Now we assert the blocks that DO
    // render: «Выдан» (issuer), «Срок действия» (validity), auto-renewal.
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState()}
        security={mockSecurityFactory()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(i18n.t("server.cert.block_issued_by"))).toBeInTheDocument();
      expect(screen.getByText(i18n.t("server.cert.block_validity"))).toBeInTheDocument();
      expect(screen.getByTestId("cert-auto-renewal-section")).toBeInTheDocument();
    });
  });

  it("issuer block shows Let's Encrypt + subject CN", async () => {
    // FIX false-green CertModal:93 — replaces the second tautological negative
    // (`copy-fingerprint-button` testid that never existed) with a real
    // assertion on the issuer block content that actually renders.
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState()}
        security={mockSecurityFactory()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Let's Encrypt/i)).toBeInTheDocument();
      expect(screen.getByText(/vpn\.example\.com/)).toBeInTheDocument();
    });
  });

  it("shows «Сертификат не загружен» when no certInfo", async () => {
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState({ certRaw: null })}
        security={mockSecurityFactory()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/не загружен/i)).toBeInTheDocument();
    });
  });

  it("has a close button with the localized aria-label", async () => {
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState()}
        security={mockSecurityFactory()}
      />,
    );
    expect(
      await screen.findByRole("button", { name: i18n.t("buttons.close") }),
    ).toBeInTheDocument();
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(
      <CertModal
        isOpen={true}
        onClose={onClose}
        state={makeState()}
        security={mockSecurityFactory()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("buttons.close") }));
    expect(onClose).toHaveBeenCalled();
  });

  // ── Validity block ────────────────────────────────────────────────────────

  it("validity block renders the from — to range when notBefore present", async () => {
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState()}
        security={mockSecurityFactory()}
      />,
    );
    // The «from — to» variant renders an em-dash separator and NOT the «до»
    // prefix (which is the missing-notBefore fallback).
    await waitFor(() => {
      const validityLabel = screen.getByText(i18n.t("server.cert.block_validity"));
      const section = validityLabel.closest("section");
      expect(section).not.toBeNull();
      expect(within(section as HTMLElement).queryByText(new RegExp(`^${i18n.t("server.cert.until_prefix")} `))).toBeNull();
    });
  });

  it("validity block falls back to «до <date>» when notBefore is missing", async () => {
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState({ certRaw: sampleNoNotBeforeCert })}
        security={mockSecurityFactory()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(new RegExp(i18n.t("server.cert.until_prefix")))).toBeInTheDocument();
    });
  });

  // ── Auto-renewal block ────────────────────────────────────────────────────

  it("shows the auto-renewal-active state when certbot timer is active", async () => {
    const security = mockSecurityFactory({
      certbotTimerStatus: { auto_renewal_active: true },
    } as never);
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState()}
        security={security}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("auto-renewal-active")).toBeInTheDocument();
      expect(screen.getByText(i18n.t("server.cert.auto_renewal_enabled"))).toBeInTheDocument();
    });
    // The enable button is NOT rendered while auto-renewal is already active.
    expect(screen.queryByTestId("enable-auto-renewal-button")).toBeNull();
  });

  it("enable-auto-renewal button calls security.enableCertbotTimer when not active", async () => {
    const security = mockSecurityFactory();
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState()}
        security={security}
      />,
    );
    fireEvent.click(await screen.findByTestId("enable-auto-renewal-button"));
    expect(security.enableCertbotTimer).toHaveBeenCalled();
  });

  // ── Renew action footer ───────────────────────────────────────────────────

  it("renew button visible for Let's Encrypt cert", async () => {
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState()}
        security={mockSecurityFactory()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("cert-renew-button")).toBeInTheDocument();
    });
  });

  it("renew action footer is hidden for a self-signed cert (certbot can't renew)", async () => {
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState({ certRaw: sampleSelfSignedCert })}
        security={mockSecurityFactory()}
      />,
    );
    await waitFor(() => {
      // Self-signed badge present, renew button absent.
      expect(screen.getByText(i18n.t("server.cert.self_signed"))).toBeInTheDocument();
    });
    expect(screen.queryByTestId("cert-renew-button")).toBeNull();
  });

  it("renew confirm → server_renew_cert success path", async () => {
    vi.mocked(invoke).mockResolvedValue("certbot renewal succeeded");
    const pushSuccess = vi.fn();
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState({ pushSuccess })}
        security={mockSecurityFactory()}
      />,
    );
    fireEvent.click(await screen.findByTestId("cert-renew-button"));
    await clickConfirmDialogRenew();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_renew_cert", expect.objectContaining({ host: "10.0.0.1" }));
    });
    // Success toast eventually fires (after the 2s settle + reload).
    await waitFor(
      () => expect(pushSuccess).toHaveBeenCalledWith(i18n.t("server.cert.renewed")),
      { timeout: 4000 },
    );
  }, 10000);

  it("renew error path surfaces an expandable «Подробности» details block", async () => {
    // Backend error format: "SSH_CERT_RENEW_FAILED|<code>\x1F<output_tail>".
    const certbotErrorOutput = "certbot: rate limit exceeded for vpn.example.com";
    vi.mocked(invoke).mockRejectedValue(
      `SSH_CERT_RENEW_FAILED|2${certbotErrorOutput}`,
    );
    const pushSuccess = vi.fn();
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState({ pushSuccess })}
        security={mockSecurityFactory()}
      />,
    );
    fireEvent.click(await screen.findByTestId("cert-renew-button"));
    await clickConfirmDialogRenew();

    // Error toast fired (rate-limit mapping).
    await waitFor(() =>
      expect(pushSuccess).toHaveBeenCalledWith(i18n.t("server.cert.error_rate_limit"), "error"),
    );

    // Expandable details block appears; expand it to reveal the certbot output.
    const details = await screen.findByTestId("cert-renew-details");
    const toggle = within(details).getByRole("button", {
      name: new RegExp(i18n.t("server.cert.renew_error_details_label")),
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("cert-renew-output")).toHaveTextContent(certbotErrorOutput);
    });
  }, 10000);

  // ── D-29 security invariant (NEW spy) ─────────────────────────────────────

  it("D-29: certbot renew-error output is NEVER written to the activity log", async () => {
    // T-03-04-02 (threat register): the certbot renew-error output may echo
    // server-side diagnostics; it is shown in the in-modal <pre> and the
    // SnackBar toast, but it must NEVER reach the activity-log channel. This
    // spy proves the surface routes nothing of the error output into the log.
    const handle = installActivityLogSpy();
    const certbotErrorOutput = "certbot-secret-diagnostic-blob-DO-NOT-LOG";
    vi.mocked(invoke).mockRejectedValue(
      `SSH_CERT_RENEW_FAILED|1${certbotErrorOutput}`,
    );
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState({ pushSuccess: vi.fn() })}
        security={mockSecurityFactory()}
      />,
    );
    fireEvent.click(await screen.findByTestId("cert-renew-button"));
    await clickConfirmDialogRenew();

    // Wait until the error has been processed (details block rendered).
    await screen.findByTestId("cert-renew-details");

    // Assert the certbot error output never reached the activity-log channel.
    expectNoSecretLogged(certbotErrorOutput);
    // Belt & suspenders: nothing at all was logged by this surface.
    expect(handle.spy).not.toHaveBeenCalled();
  }, 10000);
});
