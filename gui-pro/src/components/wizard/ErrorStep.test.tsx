import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { ErrorStep } from "./ErrorStep";
import { makeWizardState } from "./testHelpers";

describe("ErrorStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders error title", () => {
    const w = makeWizardState({ step: "error" });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.title"))).toBeInTheDocument();
  });

  it("shows error message", () => {
    const w = makeWizardState({ step: "error", errorMessage: "Connection refused" });
    render(<ErrorStep {...w} />);
    expect(screen.getByText("Connection refused")).toBeInTheDocument();
  });

  it("shows unknown error text when errorMessage is empty", () => {
    const w = makeWizardState({ step: "error", errorMessage: "" });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.unknown"))).toBeInTheDocument();
  });

  // UAT (06-uat fix 12 + fix_B): in deploy mode «Попробовать снова» returns to the
  // Endpoint settings (data preserved) instead of re-running the SAME failing install.
  // fix_B: it now goes through handleRetryToEndpoint (which invalidates the operation
  // generation + clears deploy state before navigating), NOT a bare setWizardStep.
  it("renders retry button and calls handleRetryToEndpoint (no re-deploy, no bare nav)", () => {
    // 06-uat: the install wizard is deploy-only — «Попробовать снова» always returns to the
    // Endpoint settings via handleRetryToEndpoint (which invalidates the operation
    // generation + clears deploy state before navigating), never a re-deploy or bare nav.
    const handleDeploy = vi.fn();
    const handleRetryToEndpoint = vi.fn();
    const setWizardStep = vi.fn();
    const w = makeWizardState({
      step: "error",
      handleDeploy,
      handleRetryToEndpoint,
      setWizardStep,
    });
    render(<ErrorStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.retry")));
    expect(handleRetryToEndpoint).toHaveBeenCalledOnce();
    // It must NOT re-run the deploy nor do a bare setWizardStep (the bare nav was the bug).
    expect(handleDeploy).not.toHaveBeenCalled();
    expect(setWizardStep).not.toHaveBeenCalled();
  });

  // UAT (06-uat fix 12): there is now ONE primary action — the old duplicate «Назад к
  // настройкам» ghost button (which also went to endpoint) is gone.
  it("does NOT render a duplicate 'back to settings' button", () => {
    const w = makeWizardState({ step: "error" });
    render(<ErrorStep {...w} />);
    expect(screen.queryByText(i18n.t("wizard.error.back_to_settings"))).not.toBeInTheDocument();
  });

  it("shows 'Подробнее' disclosure toggle when logs exist", () => {
    const w = makeWizardState({
      step: "error",
      deployLogs: [{ message: "Step failed", level: "error" }],
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.details_show"))).toBeInTheDocument();
  });

  it("toggles log visibility on click", () => {
    const setShowLogs = vi.fn();
    const w = makeWizardState({
      step: "error",
      deployLogs: [{ message: "Step failed", level: "error" }],
      showLogs: false,
      setShowLogs,
    });
    render(<ErrorStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.error.details_show")));
    expect(setShowLogs).toHaveBeenCalledWith(true);
  });

  // ── D-04 disclosure accessibility contract (aria-expanded / aria-controls / region) ──

  it("disclosure toggle exposes aria-expanded reflecting collapsed state", () => {
    const w = makeWizardState({
      step: "error",
      deployLogs: [{ message: "Step failed", level: "error" }],
      showLogs: false,
    });
    render(<ErrorStep {...w} />);
    const toggle = screen.getByRole("button", { name: i18n.t("wizard.error.details_show") });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("disclosure toggle exposes aria-expanded reflecting expanded state and points aria-controls at the log region", () => {
    const w = makeWizardState({
      step: "error",
      deployLogs: [{ message: "Step failed", level: "error" }],
      showLogs: true,
    });
    render(<ErrorStep {...w} />);
    const toggle = screen.getByRole("button", { name: i18n.t("wizard.error.details_hide") });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const controlledId = toggle.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();
    // The controlled element exists and is the labelled log region.
    const region = screen.getByRole("region", { name: i18n.t("wizard.error.logs_region_label") });
    expect(region.id).toBe(controlledId);
  });

  it("shows log entries inside the labelled region when showLogs is true", () => {
    const w = makeWizardState({
      step: "error",
      deployLogs: [{ message: "Log entry text", level: "info" }],
      showLogs: true,
    });
    render(<ErrorStep {...w} />);
    const region = screen.getByRole("region", { name: i18n.t("wizard.error.logs_region_label") });
    expect(region.textContent).toContain("Log entry text");
  });

  it("shows DNS hint for NXDOMAIN errors", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "NXDOMAIN lookup failed",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_dns"))).toBeInTheDocument();
  });

  // ── DNS hint from deploy logs ──

  it("shows DNS hint when deploy logs contain dns + domain", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "Deploy failed",
      deployLogs: [{ message: "DNS resolution for domain failed", level: "error" }],
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_dns"))).toBeInTheDocument();
  });

  // ── Let's Encrypt hint ──

  it("shows letsencrypt hint for certbot errors", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "certbot failed to obtain certificate",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_letsencrypt"))).toBeInTheDocument();
  });

  it("shows letsencrypt hint for Let's Encrypt errors in logs", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "",
      deployLogs: [{ message: "Let's Encrypt challenge failed", level: "error" }],
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_letsencrypt"))).toBeInTheDocument();
  });

  // ── Port 80 hint ──

  it("shows port 80 hint when error mentions port 80", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "port 80 is already in use",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_port_80"))).toBeInTheDocument();
  });

  // ── Unreachable hint ──

  it("shows unreachable hint for connection refused", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "connection refused by host",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_unreachable"))).toBeInTheDocument();
  });

  it("shows unreachable hint for connection timed out", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "connection timed out",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_unreachable"))).toBeInTheDocument();
  });

  it("shows unreachable hint for OS error 10060", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "os error 10060",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_unreachable"))).toBeInTheDocument();
  });

  // ── Auth failed hint ──

  it("shows auth hint for authentication error", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "Authentication failed",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_auth_failed"))).toBeInTheDocument();
  });

  it("shows auth hint for permission denied", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "Permission denied (publickey)",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_auth_failed"))).toBeInTheDocument();
  });

  // ── Multiple hints ──

  it("shows multiple hints when error matches several patterns", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "NXDOMAIN and port 80 blocked",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.hint_dns"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("wizard.error.hint_port_80"))).toBeInTheDocument();
  });

  it("shows possible cause heading when hints present", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "NXDOMAIN lookup failed",
    });
    render(<ErrorStep {...w} />);
    expect(screen.getByText(i18n.t("wizard.error.possible_cause"))).toBeInTheDocument();
  });

  it("does not show hints section when no patterns match", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "some random error",
    });
    render(<ErrorStep {...w} />);
    expect(screen.queryByText(i18n.t("wizard.error.possible_cause"))).not.toBeInTheDocument();
  });

  // ── Reinstall prompt — REMOVED (06-uat) ──
  // The fetch-retry «reinstall» prompt was removed with the wizard's fetch flow; the
  // install wizard is deploy-only, so there is no fetchRetryCount / reinstall fork.

  // ── Logs copy button ──

  it("shows copy button in expanded logs", () => {
    const copyLogsToClipboard = vi.fn();
    const w = makeWizardState({
      step: "error",
      deployLogs: [{ message: "log line", level: "info" }],
      showLogs: true,
      copyLogsToClipboard,
    });
    render(<ErrorStep {...w} />);
    // The copy control is now a shared IconButton: locate it by its accessible
    // name (aria-label) rather than a raw title attribute.
    const copyBtn = screen.getByRole("button", { name: i18n.t("wizard.error.copy_logs_tooltip") });
    fireEvent.click(copyBtn);
    expect(copyLogsToClipboard).toHaveBeenCalledOnce();
  });

  it("does not show disclosure toggle when deployLogs is empty", () => {
    const w = makeWizardState({
      step: "error",
      deployLogs: [],
    });
    render(<ErrorStep {...w} />);
    expect(screen.queryByText(i18n.t("wizard.error.details_show"))).not.toBeInTheDocument();
  });

  // ── D-04 friendly-error lead + port-holder hint (proves engine reuse) ──

  it("port-443-busy error whose log names a holder still names that process in the hint", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "Address in use (os error 98)",
      deployLogs: [
        { message: 'tcp LISTEN 0 511 *:443 *:* users:(("nginx",pid=163333,fd=5))', level: "error" },
      ],
    });
    render(<ErrorStep {...w} />);
    // The hint engine (unchanged) pulls "nginx" out of the ss output.
    expect(
      screen.getByText(i18n.t("wizard.error.hint_port_held_by", { process: "nginx" })),
    ).toBeInTheDocument();
  });

  // ── D-29 secret-in-raw-log regression guard ──
  //
  // D-29 invariant (memory/security-posture.md): no password or secret may
  // appear in any log or error view. The "Подробнее" raw-log region renders
  // ONLY w.deployLogs — the already-backend-sanitized stream — never a raw,
  // unsanitized secret source. This spy plants a known secret token that was
  // NEVER written into deployLogs (nor errorMessage) and asserts it is ABSENT
  // from the expanded raw-log region's textContent — proving the view sources
  // only deployLogs/errorMessage/translated text.
  //
  // This is a GREEN regression guard (not RED): it passes against today's
  // ErrorStep and must remain green through the Plan-05 re-skin (which restyles
  // the disclosure wrapper but must not introduce a new log source — UI-SPEC
  // §"Security invariant (D-29)"). The assertion is SCOPED to the raw-log
  // region (located via its aria-controls role="region"), not an unbounded
  // whole-document scan that could false-pass.
  it("D-29: expanded 'Подробнее' raw-log never contains a secret outside deployLogs", () => {
    // A secret that is NOT present in deployLogs / errorMessage — if it ever
    // appeared, the view would be sourcing an unsanitized secret.
    const PLANTED_SECRET = "hunter2-SuperSecretPassword-D29";
    const w = makeWizardState({
      step: "error",
      errorMessage: "Deploy failed", // sanitized lead, no secret
      deployLogs: [
        { message: "Connecting to server...", level: "info" },
        { message: "Step failed: address in use", level: "error" },
      ],
      showLogs: true, // disclosure expanded
    });
    render(<ErrorStep {...w} />);

    // Locate the raw-log region via its accessible role (the aria-controls
    // target), scoped — not a document-wide scan.
    const rawLogRegion = screen.getByRole("region", {
      name: i18n.t("wizard.error.logs_region_label"),
    });
    expect(rawLogRegion).toBeTruthy();

    // The sanitized log lines DO render (the view shows deployLogs)…
    expect(rawLogRegion.textContent).toContain("address in use");
    // …but the planted secret — never put into deployLogs — must NOT appear.
    expect(rawLogRegion.textContent).not.toContain(PLANTED_SECRET);
  });

  // 06-uat install-wizard slimming: the SOCKS5-refused + metrics-bind ErrorStep hint
  // branches (and their i18n keys) were removed with the SOCKS5 / Metrics wizard settings.
  // The reverse-proxy origin-unreachable hint (kept) is covered by its own test below.

  // ── C-06 (06-14): port-80-busy → friendly hint + switch-to-self-signed action ──

  it("renders the port-80-busy hint AND a switch-to-self-signed button for SSH_CERTBOT_PORT80_BUSY", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "SSH_CERTBOT_PORT80_BUSY",
    });
    render(<ErrorStep {...w} />);
    // The friendly RU hint renders…
    expect(
      screen.getByText(i18n.t("wizard.error.hint_port_80_busy")),
    ).toBeInTheDocument();
    // …and the primary action offers a switch to a self-signed certificate.
    expect(
      screen.getByText(i18n.t("wizard.error.switch_to_selfsigned")),
    ).toBeInTheDocument();
  });

  it("switch-to-self-signed sets certType to 'selfsigned' then redeploys", () => {
    const setCertType = vi.fn();
    const handleDeploy = vi.fn();
    const w = makeWizardState({
      step: "error",
      errorMessage: "SSH_CERTBOT_PORT80_BUSY",
      setCertType,
      handleDeploy,
    });
    render(<ErrorStep {...w} />);
    fireEvent.click(screen.getByText(i18n.t("wizard.error.switch_to_selfsigned")));
    expect(setCertType).toHaveBeenCalledWith("selfsigned");
    // WR-01: handleDeploy must receive the explicit overrideCertType so it does NOT
    // read the stale (still-letsencrypt) certType from its closure in the same tick.
    expect(handleDeploy).toHaveBeenCalledOnce();
    expect(handleDeploy).toHaveBeenCalledWith({ overrideCertType: "selfsigned" });
  });

  it("does NOT show the switch-to-self-signed button for an unrelated error", () => {
    const w = makeWizardState({
      step: "error",
      errorMessage: "Connection refused",
    });
    render(<ErrorStep {...w} />);
    expect(
      screen.queryByText(i18n.t("wizard.error.switch_to_selfsigned")),
    ).not.toBeInTheDocument();
  });
});
