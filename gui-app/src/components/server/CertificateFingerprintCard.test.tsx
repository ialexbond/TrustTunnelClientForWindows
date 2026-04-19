import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { CertificateFingerprintCard } from "./CertificateFingerprintCard";
import { renderWithProviders as render } from "../../test/test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: vi.fn() }),
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
    expect(screen.queryByTestId("cert-fetch-btn")).toBeNull();
    expect(screen.getByTestId("cert-unpin-btn")).toBeInTheDocument();
    expect(screen.getByTestId("cert-refresh-btn")).toBeInTheDocument();
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

  it("calls fetch again when Refresh button clicked after fingerprint loaded", async () => {
    mockInvokeByCommand({
      server_fetch_endpoint_cert: {
        leaf_der_b64: "ZnJlc2g=",
        fingerprint_hex: "FR:ES:H",
        chain_len: 1,
      },
    });
    const fp = "STALE:FP";
    render(
      <CertificateFingerprintCard
        {...defaultProps}
        _forceFingerprint={fp}
      />
    );
    fireEvent.click(screen.getByTestId("cert-refresh-btn"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "server_fetch_endpoint_cert",
        expect.any(Object),
      );
    });
  });

  it("disables fetch button when disabled=true", () => {
    render(<CertificateFingerprintCard {...defaultProps} disabled />);
    const btn = screen.getByTestId("cert-fetch-btn");
    expect(btn).toBeDisabled();
  });
});
