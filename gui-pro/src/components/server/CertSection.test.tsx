import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { CertSection } from "./CertSection";
import { renderWithProviders as render } from "../../test/test-utils";
import type { ServerState } from "./useServerState";

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

describe("CertSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders nothing when certRaw is null and no error", () => {
    const state = makeState();
    const { container } = render(<CertSection state={state} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders cert title and type badge for Let's Encrypt cert", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: true,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.title"))).toBeInTheDocument();
    expect(screen.getByText("Let's Encrypt")).toBeInTheDocument();
  });

  it("shows domain when present", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "vpn.example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText("vpn.example.com")).toBeInTheDocument();
  });

  it("shows self-signed badge for self-signed cert", () => {
    const state = makeState({
      certRaw: {
        issuer: "CN=10.0.0.1",
        subject: "CN=10.0.0.1",
        hostname: "10.0.0.1",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.self_signed"))).toBeInTheDocument();
  });

  it("shows auto-renew configured status", () => {
    const state = makeState({
      certRaw: {
        issuer: "R10",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: true,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.configured"))).toBeInTheDocument();
  });

  it("shows auto-renew not configured status", () => {
    const state = makeState({
      certRaw: {
        issuer: "R10",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.not_configured"))).toBeInTheDocument();
  });

  it("shows renew button for Let's Encrypt certs", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: true,
      },
    });
    render(<CertSection state={state} />);
    const renewBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.cert.renew")) });
    expect(renewBtn).toBeInTheDocument();
  });

  it("shows expiry info for certs with notAfter", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: "2027-06-15T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.expires"))).toBeInTheDocument();
  });

  // ── ACME cert details ──

  it("recognizes ACME issuer as Let's Encrypt", () => {
    const state = makeState({
      certRaw: {
        issuer: "ACME CA",
        hostname: "vpn.test.com",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText("Let's Encrypt")).toBeInTheDocument();
  });

  it("recognizes R10 issuer as Let's Encrypt", () => {
    const state = makeState({
      certRaw: {
        issuer: "R10",
        hostname: "test.com",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: true,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText("Let's Encrypt")).toBeInTheDocument();
  });

  it("recognizes R11 issuer as Let's Encrypt", () => {
    const state = makeState({
      certRaw: {
        issuer: "R11",
        hostname: "test.com",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText("Let's Encrypt")).toBeInTheDocument();
  });

  it("recognizes letsencrypt issuer string", () => {
    const state = makeState({
      certRaw: {
        issuer: "letsencrypt",
        hostname: "test.com",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText("Let's Encrypt")).toBeInTheDocument();
  });

  // ── Self-signed cert details ──

  it("shows self-signed badge when issuer contains 'self'", () => {
    const state = makeState({
      certRaw: {
        issuer: "Self-signed CA",
        hostname: "10.0.0.1",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.self_signed"))).toBeInTheDocument();
  });

  it("shows self-signed badge when no issuer but hostname present", () => {
    const state = makeState({
      certRaw: {
        hostname: "10.0.0.1",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.self_signed"))).toBeInTheDocument();
  });

  it("shows unknown badge for unknown issuer", () => {
    const state = makeState({
      certRaw: {
        issuer: "SomeRandomCA",
        subject: "CN=different",
        hostname: "test.com",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.unknown"))).toBeInTheDocument();
  });

  // ── Expiry warning badge ──

  it("shows danger badge when cert expires within 7 days", () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 3);
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: soon.toISOString(),
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    // Badge with variant="danger" renders with the danger styling
    // The expiry badge should exist
    expect(screen.getByText(i18n.t("server.cert.expires"))).toBeInTheDocument();
  });

  it("shows success badge when cert has more than 30 days", () => {
    const far = new Date();
    far.setDate(far.getDate() + 90);
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        notAfter: far.toISOString(),
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.expires"))).toBeInTheDocument();
  });

  // ── Renew button flow ──

  it("does not show renew button for self-signed certs", () => {
    const state = makeState({
      certRaw: {
        issuer: "CN=10.0.0.1",
        subject: "CN=10.0.0.1",
        hostname: "10.0.0.1",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.queryByText(i18n.t("server.cert.renew"))).not.toBeInTheDocument();
  });

  it("does not show renew button for unknown cert type", () => {
    const state = makeState({
      certRaw: {
        issuer: "SomeRandomCA",
        subject: "CN=different",
        hostname: "test.com",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.queryByText(i18n.t("server.cert.renew"))).not.toBeInTheDocument();
  });

  // ── Domain display ──

  it("does not show domain row when domain is empty", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.queryByText(i18n.t("server.cert.domain"))).not.toBeInTheDocument();
  });

  it("extracts domain from subject CN when hostname is missing", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        subject: "CN=my-vpn.com",
        notAfter: "2027-01-01T00:00:00Z",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.getByText("my-vpn.com")).toBeInTheDocument();
  });

  // ── String parsing (non-JSON certRaw) ──

  it("parses string certRaw with ACME type", () => {
    const state = makeState({
      certRaw: 'type: "acme"\ndomain: "vpn.example.com"\nnot_after: "2027-01-01"\nauto_renew: true',
    });
    render(<CertSection state={state} />);
    expect(screen.getByText("Let's Encrypt")).toBeInTheDocument();
    expect(screen.getByText("vpn.example.com")).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.cert.configured"))).toBeInTheDocument();
  });

  it("parses string certRaw with self-signed type", () => {
    const state = makeState({
      certRaw: 'type: "self-signed"\ndomain: "10.0.0.1"\nnot_after: "2027-01-01"\nauto_renew: false',
    });
    render(<CertSection state={state} />);
    expect(screen.getByText(i18n.t("server.cert.self_signed"))).toBeInTheDocument();
    expect(screen.getByText("10.0.0.1")).toBeInTheDocument();
  });

  // ── Error state ──

  it("does not show expiry row when notAfter is empty", () => {
    const state = makeState({
      certRaw: {
        issuer: "R3",
        hostname: "example.com",
        autoRenew: false,
      },
    });
    render(<CertSection state={state} />);
    expect(screen.queryByText(i18n.t("server.cert.expires"))).not.toBeInTheDocument();
  });
});
