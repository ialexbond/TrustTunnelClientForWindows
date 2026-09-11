import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { CertificateFingerprintCard } from "./CertificateFingerprintCard";
import { renderWithProviders as render } from "../../test/test-utils";
import {
  activityLogSpy,
  installActivityLogSpy,
  expectNoSecretLogged,
} from "../../test/fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// Wire the SHARED named D-29 spy (instead of an anonymous vi.fn()) so the
// full-fingerprint-absent assertion can inspect what reached the activity log.
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: activityLogSpy }),
}));

const mockSshParams = {
  host: "192.168.1.1",
  port: 22,
  user: "root",
  password: "secret",
};

const defaultProps = {
  sshParams: mockSshParams,
  onFingerprintLoaded: vi.fn(),
  onClear: vi.fn(),
};

/**
 * Command-aware invoke mock. FIX-O added a mount-time `server_get_config` call
 * for auto-detecting the TLS port — if tests used `mockResolvedValueOnce` it
 * would be consumed by the unrelated auto-detect roundtrip instead of the
 * `server_fetch_endpoint_cert` call under test. This helper lets a test wire
 * per-command responses without worrying about call ordering.
 */
function mockInvokeByCommand(
  overrides: Record<string, unknown | Error> = {},
): void {
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd in overrides) {
      const v = overrides[cmd];
      if (v instanceof Error) throw v;
      return v;
    }
    if (cmd === "server_get_config") return "";
    return undefined;
  });
}

describe("CertificateFingerprintCard", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
    installActivityLogSpy(); // reset shared D-29 spy call history
    // Default: auto-detect returns empty so port stays at 443.
    mockInvokeByCommand();
  });

  it("renders fetch button in idle state", () => {
    render(<CertificateFingerprintCard {...defaultProps} />);
    expect(screen.getByTestId("cert-fetch-btn")).toBeInTheDocument();
  });

  it("renders loading state via _forceLoading prop", () => {
    render(<CertificateFingerprintCard {...defaultProps} _forceLoading />);
    expect(screen.getByText(/загрузка сертификата/i)).toBeInTheDocument();
    expect(screen.queryByTestId("cert-fetch-btn")).toBeNull();
  });

  it("renders error state via _forceError prop", () => {
    render(<CertificateFingerprintCard {...defaultProps} _forceError="Connection refused" />);
    expect(screen.getByText("Connection refused")).toBeInTheDocument();
    // Retry button should appear
    expect(screen.getByRole("button", { name: /попробовать снова/i })).toBeInTheDocument();
  });

  it("renders fingerprint state via _forceFingerprint prop", () => {
    const fp = "AA:BB:CC:DD:EE:FF:00:11";
    render(<CertificateFingerprintCard {...defaultProps} _forceFingerprint={fp} />);
    expect(screen.getByTestId("cert-fingerprint-value")).toHaveTextContent(fp);
  });

  it("CRIT-2: hydrates success state from initialFingerprint without re-probing", () => {
    // This is what the Edit modal does on reopen — it already has the saved
    // pin from users-advanced.toml, the card should skip the idle state and
    // surface SHA-256 + Отвязать/Обновить straight away.
    const fp = "11:22:33:44:55:66:77:88";
    render(
      <CertificateFingerprintCard
        {...defaultProps}
        initialFingerprint={fp}
        initialDerB64="MAMBAgM="
      />,
    );
    expect(screen.getByTestId("cert-fingerprint-value")).toHaveTextContent(fp);
    // Idle «Загрузить» gone, success-state actions visible.
    // UX-cert-refresh-removed: только «Отвязать» осталась.
    expect(screen.queryByTestId("cert-fetch-btn")).toBeNull();
    expect(screen.getByTestId("cert-unpin-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("cert-refresh-btn")).toBeNull();
  });

  it("calls server_fetch_endpoint_cert with correct params on fetch click", async () => {
    mockInvokeByCommand({
      server_fetch_endpoint_cert: {
        leaf_der_b64: "dGVzdA==",
        fingerprint_hex: "DE:AD:BE:EF",
        chain_len: 2,
      },
    });
    render(<CertificateFingerprintCard {...defaultProps} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_fetch_endpoint_cert", expect.objectContaining({
        host: "192.168.1.1",
        port: 22,
      }));
    });
  });

  it("calls onFingerprintLoaded after successful fetch", async () => {
    const onFingerprintLoaded = vi.fn();
    mockInvokeByCommand({
      server_fetch_endpoint_cert: {
        leaf_der_b64: "dGVzdA==",
        fingerprint_hex: "DE:AD:BE:EF",
        chain_len: 1,
        // FIX-OO-7: probe now returns is_system_verifiable; default false
        // means self-signed / untrusted — callback gets `false`.
        is_system_verifiable: false,
      },
    });
    render(<CertificateFingerprintCard {...defaultProps} onFingerprintLoaded={onFingerprintLoaded} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    await waitFor(() => {
      expect(onFingerprintLoaded).toHaveBeenCalledWith("dGVzdA==", "DE:AD:BE:EF", false);
    });
  });

  it("propagates is_system_verifiable=true flag when chain trusted by OS", async () => {
    const onFingerprintLoaded = vi.fn();
    mockInvokeByCommand({
      server_fetch_endpoint_cert: {
        leaf_der_b64: "dGVzdA==",
        fingerprint_hex: "DE:AD:BE:EF",
        chain_len: 2,
        is_system_verifiable: true,
      },
    });
    render(<CertificateFingerprintCard {...defaultProps} onFingerprintLoaded={onFingerprintLoaded} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    await waitFor(() => {
      expect(onFingerprintLoaded).toHaveBeenCalledWith("dGVzdA==", "DE:AD:BE:EF", true);
    });
  });

  it("shows localized timeout error when fetch fails with timeout", async () => {
    mockInvokeByCommand({ server_fetch_endpoint_cert: new Error("timeout") });
    render(<CertificateFingerprintCard {...defaultProps} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    // Localized (RU): «Превышено время ожидания (10с) — endpoint не отвечает»
    await waitFor(() => {
      expect(screen.getByText(/превышено время ожидания|endpoint не отвечает/i)).toBeInTheDocument();
    });
  });

  it("shows generic localized error with raw text for unmatched failures", async () => {
    mockInvokeByCommand({ server_fetch_endpoint_cert: new Error("unexpected failure") });
    render(<CertificateFingerprintCard {...defaultProps} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    await waitFor(() => {
      // Generic key interpolates the raw error — "Ошибка при загрузке сертификата: unexpected failure"
      expect(screen.getByText(/ошибка при загрузке сертификата/i)).toBeInTheDocument();
    });
  });

  it("shows fingerprint after successful fetch", async () => {
    mockInvokeByCommand({
      server_fetch_endpoint_cert: {
        leaf_der_b64: "dGVzdA==",
        fingerprint_hex: "AA:BB:CC",
        chain_len: 3,
      },
    });
    render(<CertificateFingerprintCard {...defaultProps} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("cert-fingerprint-value")).toHaveTextContent("AA:BB:CC");
    });
  });

  // FIX-P: success state now shows two distinct buttons: [Unpin] (ghost,
  // calls onClear) and [Refresh] (secondary, re-fetches the cert). The old
  // single misleading "Fetch" button that actually cleared is gone.
  it("calls onClear when Unpin button clicked after fingerprint loaded", async () => {
    const onClear = vi.fn();
    const fp = "AA:BB";
    render(
      <CertificateFingerprintCard
        {...defaultProps}
        _forceFingerprint={fp}
        onClear={onClear}
      />
    );
    fireEvent.click(screen.getByTestId("cert-unpin-btn"));
    expect(onClear).toHaveBeenCalled();
  });

  // UX-cert-refresh-removed: «Обновить» убрана — её re-probe дублировал
  // toggle Pin OFF → ON flow без Save, что вносило confusion'ы с одним и
  // тем же SHA-256 после нажатия.

  it("disables fetch button when disabled=true", () => {
    render(<CertificateFingerprintCard {...defaultProps} disabled />);
    const btn = screen.getByTestId("cert-fetch-btn");
    expect(btn).toBeDisabled();
  });

  // ── System-verifiable hint ─────────────────────────────────────────────────

  it("shows the system-verifiable hint when the chain is OS-trusted", async () => {
    mockInvokeByCommand({
      server_fetch_endpoint_cert: {
        leaf_der_b64: "dGVzdA==",
        fingerprint_hex: "DE:AD:BE:EF",
        chain_len: 2,
        is_system_verifiable: true,
      },
    });
    render(<CertificateFingerprintCard {...defaultProps} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("cert-system-verifiable-hint")).toBeInTheDocument();
    });
  });

  it("hides the system-verifiable hint for an untrusted (self-signed) chain", async () => {
    mockInvokeByCommand({
      server_fetch_endpoint_cert: {
        leaf_der_b64: "dGVzdA==",
        fingerprint_hex: "DE:AD:BE:EF",
        chain_len: 1,
        is_system_verifiable: false,
      },
    });
    render(<CertificateFingerprintCard {...defaultProps} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("cert-fingerprint-value")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("cert-system-verifiable-hint")).toBeNull();
  });

  // ── Copy to clipboard + label toggle ───────────────────────────────────────

  it("copies the fingerprint to clipboard and toggles the copy aria-label", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const fp = "AA:BB:CC:DD";
    render(<CertificateFingerprintCard {...defaultProps} _forceFingerprint={fp} />);
    // Before copy: the button advertises the «copy» aria-label.
    const copyBtn = screen.getByTestId("cert-fp-copy-btn");
    expect(copyBtn).toHaveAccessibleName(i18n.t("server.users.cert_fp_copy_aria"));
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalled();
      // After copy: label flips to «Скопировано».
      expect(screen.getByTestId("cert-fp-copy-btn")).toHaveAccessibleName(
        i18n.t("server.users.cert_fp_copied"),
      );
    });
  });

  // ── Auto port detection (FIX-O) ────────────────────────────────────────────

  it("auto-detects the TLS port from vpn.toml listen_address on mount", async () => {
    mockInvokeByCommand({
      server_get_config: 'listen_address = "0.0.0.0:8443"\n',
    });
    render(<CertificateFingerprintCard {...defaultProps} />);
    // The detected port (8443) prefills the editable port NumberInput.
    await waitFor(() => {
      const portInput = screen.getByLabelText(i18n.t("server.users.cert_port_label"));
      expect(portInput).toHaveValue("8443");
    });
  });

  it("keeps the default port when vpn.toml has no listen_address", async () => {
    mockInvokeByCommand({ server_get_config: "# no listen here\n" });
    render(<CertificateFingerprintCard {...defaultProps} />);
    await waitFor(() => {
      const portInput = screen.getByLabelText(i18n.t("server.users.cert_port_label"));
      expect(portInput).toHaveValue("443");
    });
  });

  // ── Invalid port ───────────────────────────────────────────────────────────

  it("blocks fetch and shows the invalid-port error for an out-of-range port", async () => {
    render(<CertificateFingerprintCard {...defaultProps} />);
    const portInput = screen.getByLabelText(i18n.t("server.users.cert_port_label"));
    fireEvent.change(portInput, { target: { value: "0" } });
    // Fetch button is disabled while the port is invalid (portValid=false).
    await waitFor(() => {
      expect(screen.getByTestId("cert-fetch-btn")).toBeDisabled();
    });
  });

  // ── Null backend response ──────────────────────────────────────────────────

  it("shows the invalid-response error when the backend returns null", async () => {
    mockInvokeByCommand({ server_fetch_endpoint_cert: null });
    render(<CertificateFingerprintCard {...defaultProps} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    await waitFor(() => {
      expect(
        screen.getByText(i18n.t("server.users.cert_fetch_error_invalid_response")),
      ).toBeInTheDocument();
    });
  });

  // ── Connection refused ─────────────────────────────────────────────────────

  it("maps a connection-refused failure to the localized hint", async () => {
    mockInvokeByCommand({
      server_fetch_endpoint_cert: new Error("tcp connect: connection refused"),
    });
    render(<CertificateFingerprintCard {...defaultProps} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    await waitFor(() => {
      expect(
        screen.getByText(i18n.t("server.users.cert_fetch_error_connection_refused")),
      ).toBeInTheDocument();
    });
  });

  // ── No refresh button in success state (explicit absence) ──────────────────

  it("does NOT render a cert-refresh-btn in the success state (UX-cert-refresh-removed)", async () => {
    mockInvokeByCommand({
      server_fetch_endpoint_cert: {
        leaf_der_b64: "dGVzdA==",
        fingerprint_hex: "AA:BB:CC",
        chain_len: 1,
      },
    });
    render(<CertificateFingerprintCard {...defaultProps} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("cert-unpin-btn")).toBeInTheDocument();
    });
    // Only «Отвязать» remains — the misleading «Обновить» re-probe was removed.
    expect(screen.queryByTestId("cert-refresh-btn")).toBeNull();
  });

  // ── D-29 security invariant (NEW spy) ──────────────────────────────────────

  it("D-29: full SHA-256 fingerprint is NEVER written to the activity log (only fp_prefix)", async () => {
    // T-03-04-01 (threat register): the card logs only the 8-char fp_prefix —
    // the full SHA-256 must never reach the activity-log channel. Build a
    // distinctive full hash whose tail cannot be confused with the 8-char
    // prefix, then assert the full string is ABSENT from every log call.
    const fullFingerprint =
      "AABBCCDD11223344556677889900AABBCCDDEEFF00112233445566778899AABB";
    const fpPrefix = fullFingerprint.slice(0, 8); // "AABBCCDD"
    mockInvokeByCommand({
      server_fetch_endpoint_cert: {
        leaf_der_b64: "dGVzdA==",
        fingerprint_hex: fullFingerprint,
        chain_len: 2,
        is_system_verifiable: false,
      },
    });
    render(<CertificateFingerprintCard {...defaultProps} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("cert-fingerprint-value")).toBeInTheDocument();
    });

    // Full hash must be ABSENT from the activity log (never assert its value
    // beyond absence — printing a secret would itself violate D-29).
    expectNoSecretLogged(fullFingerprint);

    // Positive control: the fetch DID log, and it logged the short prefix —
    // proving the absence above is meaningful (the log channel was exercised).
    const loggedStrings = activityLogSpy.mock.calls
      .flat()
      .filter((a): a is string => typeof a === "string");
    expect(loggedStrings.some((s) => s.includes(`fp_prefix=${fpPrefix}`))).toBe(true);
  });

  it("D-29: copy-to-clipboard logs only the fp_prefix, never the full fingerprint", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const fullFingerprint =
      "FFEEDDCCBBAA0099887766554433221100FFEEDDCCBBAA00998877665544332211";
    render(<CertificateFingerprintCard {...defaultProps} _forceFingerprint={fullFingerprint} />);
    fireEvent.click(screen.getByTestId("cert-fp-copy-btn"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    // Clipboard receives the full (formatted) fingerprint — that's the user's
    // intent — but the activity log must NOT carry the full hash.
    expectNoSecretLogged(fullFingerprint);
  });
});
