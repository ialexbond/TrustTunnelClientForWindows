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

describe("CertificateFingerprintCard", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
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

  it("calls server_fetch_endpoint_cert with correct params on fetch click", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      leaf_der_b64: "dGVzdA==",
      fingerprint_hex: "DE:AD:BE:EF",
      chain_len: 2,
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
    vi.mocked(invoke).mockResolvedValueOnce({
      leaf_der_b64: "dGVzdA==",
      fingerprint_hex: "DE:AD:BE:EF",
      chain_len: 1,
    });
    render(<CertificateFingerprintCard {...defaultProps} onFingerprintLoaded={onFingerprintLoaded} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    await waitFor(() => {
      expect(onFingerprintLoaded).toHaveBeenCalledWith("dGVzdA==", "DE:AD:BE:EF");
    });
  });

  it("shows error message when fetch fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("timeout"));
    render(<CertificateFingerprintCard {...defaultProps} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    await waitFor(() => {
      expect(screen.getByText(/timeout/i)).toBeInTheDocument();
    });
  });

  it("shows fingerprint after successful fetch", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      leaf_der_b64: "dGVzdA==",
      fingerprint_hex: "AA:BB:CC",
      chain_len: 3,
    });
    render(<CertificateFingerprintCard {...defaultProps} />);
    fireEvent.click(screen.getByTestId("cert-fetch-btn"));
    await waitFor(() => {
      expect(screen.getByTestId("cert-fingerprint-value")).toHaveTextContent("AA:BB:CC");
    });
  });

  it("calls onClear when re-fetch button clicked after fingerprint loaded", async () => {
    const onClear = vi.fn();
    const fp = "AA:BB";
    render(
      <CertificateFingerprintCard
        {...defaultProps}
        _forceFingerprint={fp}
        onClear={onClear}
      />
    );
    // When fingerprint is loaded, the button text changes to cert_fetch_btn (re-fetch)
    const reloadBtn = screen.getAllByRole("button")[0];
    fireEvent.click(reloadBtn);
    expect(onClear).toHaveBeenCalled();
  });

  it("disables fetch button when disabled=true", () => {
    render(<CertificateFingerprintCard {...defaultProps} disabled />);
    const btn = screen.getByTestId("cert-fetch-btn");
    expect(btn).toBeDisabled();
  });
});
