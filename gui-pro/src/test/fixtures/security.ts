import { vi } from "vitest";
import type { ServerState } from "../../components/server/useServerState";
import type { useSecurityState } from "../../components/server/useSecurityState";

/**
 * Cert / security fixtures (Phase 3 safety-net, Wave 0).
 *
 * Dedupes the cert-state + security-status setup currently duplicated across
 * CertSection.test.tsx / CertModal.test.tsx (RESEARCH §3 stream 4 fixtures
 * note / §4.1). All values are placeholder / non-secret — these fixtures must
 * never carry a real credential.
 */

// ────────────────────────────────────────────────────────────────────────────
// Cert raw payloads
// ────────────────────────────────────────────────────────────────────────────

/**
 * Shape `server_get_cert_info` returns and `state.certRaw` carries. Mirrors the
 * `CertInfoResponse` shape parsed by `parseCertInfo` in certUtils.ts (issuer /
 * subject / notAfter / notBefore / hostname). All optional so callers build
 * partial certs for specific tone bands.
 */
export interface CertRawFixture {
  hostname?: string;
  notAfter?: string;
  notBefore?: string;
  subject?: string;
  issuer?: string;
  sha256Fingerprint?: string;
}

/**
 * Build a raw cert whose `notAfter` is `daysFromNow` days from now, serialized
 * to a JSON string. `parseCertInfo` (certUtils.ts) JSON-parses string input,
 * then `daysUntil(parsed.notAfter)` derives the tone band per the overview spec
 * (memory/v3/screens/control-panel-overview.md §TLS состояния):
 *
 *   ok       > 14 days
 *   warning  8–14 days
 *   danger   1–7 days
 *   expired  ≤ 0 days
 *
 * `makeCertRaw(20)` → ~20 days left (ok); `makeCertRaw(-1)` → expired.
 * Defaults to a Let's Encrypt issuer string so `parseCertInfo` classifies
 * `certType: "lets_encrypt"`. Override any field via the second arg.
 *
 * NOTE returns a STRING (per plan signature). The cert object literals used by
 * the existing CertSection/CertModal tests are still valid `certRaw` (the
 * parser accepts both object and string) — this helper covers the
 * day-band-driven cases the streams need.
 */
export function makeCertRaw(
  daysFromNow: number,
  overrides: Partial<CertRawFixture> = {},
): string {
  const notAfter = new Date(
    Date.now() + daysFromNow * 24 * 60 * 60 * 1000,
  ).toISOString();
  const cert: CertRawFixture = {
    hostname: "vpn.example.com",
    notAfter,
    notBefore: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    subject: "CN = vpn.example.com",
    issuer: "C = US, O = Let's Encrypt, CN = R3",
    ...overrides,
  };
  return JSON.stringify(cert);
}

/**
 * Build a `ServerState` slice carrying a cert payload, for CertSection /
 * CertModal tests. Equivalent to `makeState`-style partial focused on the cert
 * fields those surfaces read (`certRaw`, `setCertRaw`, `sshParams`,
 * `setActionResult`, `pushSuccess`). Defaults to an ok-band Let's Encrypt cert
 * object (the literal the existing tests use); override `certRaw` for other
 * bands (e.g. `makeCertState({ certRaw: makeCertRaw(-1) })`).
 */
export function makeCertState(
  overrides: Partial<ServerState> = {},
): ServerState {
  return {
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    setActionResult: vi.fn(),
    certRaw: {
      hostname: "vpn.example.com",
      notAfter: new Date(Date.now() + 67 * 24 * 60 * 60 * 1000).toISOString(),
      notBefore: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      subject: "CN = vpn.example.com",
      issuer: "C = US, O = Let's Encrypt, CN = R3",
    },
    setCertRaw: vi.fn(),
    pushSuccess: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

// ────────────────────────────────────────────────────────────────────────────
// Security status (useSecurityState) mock factory
// ────────────────────────────────────────────────────────────────────────────

type SecurityState = ReturnType<typeof useSecurityState>;

/**
 * Minimal `useSecurityState` mock the cert surfaces require as a `security`
 * prop (CertSection / CertModal). Mirrors the inline `mockSecurity` literal
 * duplicated across both test files: a null certbot timer, no-op async loaders,
 * and `isBusy() === false`. Override any field for busy / timer-active cases.
 */
export function mockSecurityFactory(
  overrides: Partial<SecurityState> = {},
): SecurityState {
  return {
    certbotTimerStatus: null,
    loadCertbotTimerStatus: vi.fn().mockResolvedValue(undefined),
    enableCertbotTimer: vi.fn().mockResolvedValue(undefined),
    isBusy: vi.fn().mockReturnValue(false),
    ...overrides,
  } as unknown as SecurityState;
}
