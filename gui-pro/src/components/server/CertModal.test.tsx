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
  activityLogSpy,
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
//
// 09-23 H-5: wire the NAMED `activityLogSpy` DIRECTLY here — NOT
// `installActivityLogSpy().spy`. The old factory called installActivityLogSpy()
// (which `mockReset()`s the spy) on EVERY `useActivityLog()` call, so the spy's
// recorded calls were wiped on each render → the D-29 assertion was VACUOUS.
// With the named spy wired directly, calls accumulate; `beforeEach` resets it
// exactly once so each test starts clean and the assertion is meaningful.
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: activityLogSpy }),
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

// R2-F04 (Plan 09-36): a Let's Encrypt cert whose notAfter is unparseable →
// the static pre-click renew hint renders the no-date variant.
const sampleUnparseableNotAfterCert = {
  hostname: "vpn.example.com",
  notAfter: "not-a-real-date",
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

  // ── a11y dialog semantics (Phase-9 review a11y-3) ──────────────────────────
  // The Modal primitive now applies an UNCONDITIONAL focus-trap to every modal,
  // so a modal that omits role/aria-modal/aria-labelledby traps keyboard focus
  // inside a generic <div> that assistive tech neither announces as a dialog nor
  // names. This asserts the modal is exposed as a NAMED dialog (role + accessible
  // name via aria-labelledby → the visible heading), the user-facing property.
  it("is exposed as a named dialog (role + accessible name)", async () => {
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState()}
        security={mockSecurityFactory()}
      />,
    );
    expect(
      await screen.findByRole("dialog", { name: i18n.t("server.cert.title") }),
    ).toBeInTheDocument();
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
    // Scope to the validity section: the new R2-F04 static renew hint copy also
    // contains «до» («Действителен до …»), so an unscoped getByText(/до/) now
    // matches in two places. The «до <date>» fallback we assert here is the
    // validity-block prefix specifically (a leading-anchored match inside the
    // «Срок действия» section).
    await waitFor(() => {
      const validityLabel = screen.getByText(i18n.t("server.cert.block_validity"));
      const section = validityLabel.closest("section") as HTMLElement;
      // The «до» prefix lives in its own <span> (the date is a sibling text
      // node), so after whitespace normalization the span text is exactly «до».
      expect(
        within(section).getByText(new RegExp(`^${i18n.t("server.cert.until_prefix")}$`)),
      ).toBeInTheDocument();
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

  // ── R2-F04: static pre-click renew hint ───────────────────────────────────
  // The not_due message only appeared UNDER the «Обновить сейчас» button AFTER
  // a click. Add a STATIC hint (using the pre-computed renewNotDueDate/daysLeft)
  // ABOVE the button so the user sees renew guidance BEFORE clicking.

  it("R2-F04: renders the static renew hint with the valid-until date BEFORE any click (renewOutput null)", async () => {
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState()}
        security={mockSecurityFactory()}
      />,
    );
    // Present on initial render — no click, renewOutput is null.
    const hint = await screen.findByTestId("cert-renew-hint");
    expect(hint).toBeInTheDocument();
    // The date variant carries the «~30 дней» / «~30 days» guidance copy.
    expect(hint).toHaveTextContent(/30/);
    // The post-click not-due confirmation is NOT shown before any click.
    expect(screen.queryByTestId("cert-renew-not-due")).toBeNull();
  });

  it("R2-F04: renders the no-date renew hint variant when notAfter is unparseable", async () => {
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState({ certRaw: sampleUnparseableNotAfterCert })}
        security={mockSecurityFactory()}
      />,
    );
    const hint = await screen.findByTestId("cert-renew-hint");
    expect(hint).toHaveTextContent(i18n.t("server.cert.renew_hint_no_date"));
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

  // ── UAT-F09: truthful no-op renew message ─────────────────────────────────
  // certbot renew without --force-renewal is a correct no-op while >30 days
  // remain (commit cb7adb2c removed --force-renewal to spare Let's Encrypt
  // limits). The modal must NOT show the green «Сертификат успешно обновлён»
  // toast in that case (owner decision 6.11) — it must show a neutral not-due
  // message instead. No force-renew button is added.

  it("F09 / R3-F04: certbot no-op (not due) suppresses the green success toast and renders NO post-click block (pre-click hint stays)", async () => {
    // certbot prints a recognizable "not yet due for renewal" line when nothing
    // was renewed. R3-F04 (owner 2026-06-23): the redundant post-click no-op
    // block is DROPPED — the pre-click `cert-renew-hint` already conveys «ещё
    // действителен». The no-op DETECTION + toast-suppression are preserved: the
    // false green «Сертификат успешно обновлён» toast must still never fire.
    vi.mocked(invoke).mockResolvedValue(
      "Certificate not yet due for renewal\nThe following certificates are not due for renewal yet:\n  /etc/letsencrypt/live/vpn.example.com/fullchain.pem expires on 2026-08-29 (skipped)\nNo renewals were attempted.",
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
    // The pre-click hint is present up front (kept by R3-F04).
    expect(await screen.findByTestId("cert-renew-hint")).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId("cert-renew-button"));
    await clickConfirmDialogRenew();
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_renew_cert", expect.objectContaining({ host: "10.0.0.1" }));
    });
    // Wait out the 2s settle so any (now-removed) post-click rendering would have
    // had a chance to mount — then assert the green toast is suppressed.
    await waitFor(
      () => expect(invoke).toHaveBeenCalledWith("server_get_cert_info", expect.anything()),
      { timeout: 4000 },
    );
    // The redundant post-click no-op block no longer exists (R3-F04 drop).
    expect(screen.queryByTestId("cert-renew-not-due")).toBeNull();
    // The pre-click hint is still present after the no-op.
    expect(screen.getByTestId("cert-renew-hint")).toBeInTheDocument();
    // The green success toast is NEVER fired on a no-op (suppression preserved).
    expect(pushSuccess).not.toHaveBeenCalledWith(i18n.t("server.cert.renewed"));
  }, 10000);

  it("F09: an actual renewal still shows the green success toast", async () => {
    // certbot prints a "successfully renewed" line on a real renewal.
    vi.mocked(invoke).mockResolvedValue(
      "Congratulations, all renewals succeeded:\n  /etc/letsencrypt/live/vpn.example.com/fullchain.pem (success)",
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
    await waitFor(
      () => expect(pushSuccess).toHaveBeenCalledWith(i18n.t("server.cert.renewed")),
      { timeout: 4000 },
    );
    // The neutral not-due block is NOT rendered for a real renewal.
    expect(screen.queryByTestId("cert-renew-not-due")).toBeNull();
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

  // 09-23 H-5: the 09-03 Wave-0->Wave-3 timing-bridge `it.skip` is REMOVED — the
  // assertion runs again and is non-vacuous. The mock factory now wires the
  // NAMED `activityLogSpy` directly (no per-render reset) and `beforeEach`
  // resets it exactly once, so the spy faithfully records every log call across
  // the renew flow. If CertModal ever routed the certbot error output into the
  // activity-log channel this test would catch it; CertModal does not consume
  // useActivityLog at all today, so the spy stays empty and the invariant holds.
  it("D-29: certbot renew-error output is NEVER written to the activity log", async () => {
    // T-03-04-02 (threat register): the certbot renew-error output may echo
    // server-side diagnostics; it is shown in the in-modal <pre> and the
    // SnackBar toast, but it must NEVER reach the activity-log channel. This
    // spy proves the surface routes nothing of the error output into the log.
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
    // Belt & suspenders: nothing at all was logged by this surface — asserted
    // against the same shared named spy the factory wires, so this is real.
    expect(activityLogSpy).not.toHaveBeenCalled();
  }, 10000);

  // ── Security H-04 (unmount-setter) regression ─────────────────────────────

  it("H-04: unmounting during the post-renew 2s settle does NOT fire setters on the dead modal", async () => {
    // audit/04-security.md H-04: handleRenew's `finally` runs an unconditional 2s
    // setTimeout, then calls loadCert() (mutates parent cert state via
    // setCertRaw), setRenewLoading(false), and state.pushSuccess(renewed) — all
    // WITHOUT any cancellation/mounted guard. If the modal is closed/unmounted
    // during that 2s window, those setters run on a dead modal: a ghost success
    // toast fires and the parent cert state is mutated after the user left. The
    // fix guards the post-settle block behind a mounted ref so unmount cancels it.
    vi.mocked(invoke).mockResolvedValue("certbot renewal succeeded");
    const pushSuccess = vi.fn();
    const setCertRaw = vi.fn();
    const { unmount } = render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState({ pushSuccess, setCertRaw })}
        security={mockSecurityFactory()}
      />,
    );

    fireEvent.click(await screen.findByTestId("cert-renew-button"));
    await clickConfirmDialogRenew();

    // Wait until server_renew_cert has been invoked — we are now inside the 2s
    // `finally` settle window.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "server_renew_cert",
        expect.objectContaining({ host: "10.0.0.1" }),
      ),
    );

    // User closes the server tab / modal: unmount mid-settle.
    unmount();

    // Let the full 2s settle elapse (plus margin) on real timers.
    await new Promise((r) => setTimeout(r, 2300));

    // The dead modal must NOT have fired the success toast, the cert reload
    // (server_get_cert_info), nor mutated the parent cert state.
    expect(pushSuccess).not.toHaveBeenCalledWith(i18n.t("server.cert.renewed"));
    expect(setCertRaw).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith("server_get_cert_info", expect.anything());
  }, 10000);
});
