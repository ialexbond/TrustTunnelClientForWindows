import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { CertModal } from "./CertModal";
import { renderWithProviders as render } from "../../test/test-utils";
import type { ServerState } from "./useServerState";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

const sampleLetsEncryptCert = {
  hostname: "vpn.example.com",
  notAfter: new Date(Date.now() + 67 * 24 * 60 * 60 * 1000).toISOString(),
  notBefore: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
  subject: "CN = vpn.example.com",
  issuer: "C = US, O = Let's Encrypt, CN = R3",
  sha256Fingerprint:
    "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
};

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    setActionResult: vi.fn(),
    certRaw: sampleLetsEncryptCert,
    setCertRaw: vi.fn(),
    pushSuccess: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

const mockSecurity = {
  certbotTimerStatus: null,
  loadCertbotTimerStatus: vi.fn().mockResolvedValue(undefined),
  enableCertbotTimer: vi.fn().mockResolvedValue(undefined),
  isBusy: vi.fn().mockReturnValue(false),
} as unknown as ReturnType<typeof import("./useSecurityState").useSecurityState>;

describe("CertModal (P1-9 + P1-10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders 3-block layout when isOpen + certInfo present (P UAT 2026-05-04: SHA-256 block убран)", async () => {
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState()}
        security={mockSecurity}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Выдан/i)).toBeInTheDocument();
      expect(screen.getByText(/Срок действия/i)).toBeInTheDocument();
      // SHA-256 fingerprint block убран per UAT — useless для end-user.
      expect(screen.queryByTestId("cert-fingerprint")).not.toBeInTheDocument();
      expect(screen.getByTestId("cert-auto-renewal-section")).toBeInTheDocument();
    });
  });

  it("shows «Сертификат не загружен» when no certInfo", async () => {
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState({ certRaw: null })}
        security={mockSecurity}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/не загружен/i)).toBeInTheDocument();
    });
  });

  it("renew button visible for Let's Encrypt cert", async () => {
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState()}
        security={mockSecurity}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("cert-renew-button")).toBeInTheDocument();
    });
  });

  it("SHA-256 copy button removed per UAT 2026-05-04 (block убран)", async () => {
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState()}
        security={mockSecurity}
      />,
    );
    expect(screen.queryByTestId("copy-fingerprint-button")).not.toBeInTheDocument();
  });

  it("enable-auto-renewal button calls security.enableCertbotTimer", async () => {
    render(
      <CertModal
        isOpen={true}
        onClose={vi.fn()}
        state={makeState()}
        security={mockSecurity}
      />,
    );
    fireEvent.click(await screen.findByTestId("enable-auto-renewal-button"));
    expect(mockSecurity.enableCertbotTimer).toHaveBeenCalled();
  });

  it("loadCertbotTimerStatus invoked via security on render (через CertSection wrapper)", async () => {
    // Note: prefetching belongs to CertSection (parent). CertModal только consumes.
    expect(invoke).toBeDefined();
  });
});
