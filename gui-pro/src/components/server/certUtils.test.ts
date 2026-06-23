import { describe, it, expect } from "vitest";
import { parseCertInfo, truncateFingerprint } from "./certUtils";

describe("certUtils Phase 16 Plan 05 extension", () => {
  it("parses subject CN from openssl-formatted string", () => {
    const data = { subject: "CN = vpn.example.com" };
    const result = parseCertInfo(data);
    expect(result.subjectCn).toBe("vpn.example.com");
  });

  it("parses subject CN with extra DN fields surrounding", () => {
    const data = { subject: "C = US, ST = CA, CN = vpn.example.com, O = Acme" };
    const result = parseCertInfo(data);
    expect(result.subjectCn).toBe("vpn.example.com");
  });

  it("builds issuerSummary from O (CN intermediate suffix dropped per UAT 2026-05-04)", () => {
    // CN suffix («R3», «E8») = intermediate cert serial — useless для
    // end-user. Возвращаем только Organization name.
    const data = { issuer: "C = US, O = Let's Encrypt, CN = R3" };
    const result = parseCertInfo(data);
    expect(result.issuerSummary).toBe("Let's Encrypt");
  });

  it("falls back to CN when O is missing", () => {
    const data = { issuer: "CN = R3" };
    const result = parseCertInfo(data);
    expect(result.issuerSummary).toBe("R3");
  });

  it("passes notBefore + sha256Fingerprint through additively", () => {
    const data = {
      notBefore: "Apr 28 12:00:00 2026 GMT",
      sha256Fingerprint: "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
    };
    const result = parseCertInfo(data);
    expect(result.notBefore).toBe("Apr 28 12:00:00 2026 GMT");
    expect(result.sha256Fingerprint).toContain("AA:BB:CC");
  });

  it("leaves new optional fields undefined when backend skips them (R-9 backwards-compat)", () => {
    // Bare "R3" issuer string has neither O= nor CN= → issuerSummary stays undefined.
    // OverviewSection consumes only existing certType/domain/notAfter/autoRenew → unaffected.
    const data = {
      issuer: "R3",
      hostname: "example.com",
      notAfter: "2027-06-15T00:00:00Z",
      autoRenew: true,
    };
    const result = parseCertInfo(data);
    expect(result.subjectCn).toBeUndefined();
    expect(result.issuerSummary).toBeUndefined();
    expect(result.notBefore).toBeUndefined();
    expect(result.sha256Fingerprint).toBeUndefined();
    // Existing fields still populated (R-9 invariant).
    expect(result.certType).toBe("lets_encrypt");
    expect(result.domain).toBe("example.com");
    expect(result.notAfter).toBe("2027-06-15T00:00:00Z");
    expect(result.autoRenew).toBe(true);
  });

  it("UAT-F12: a missing cert (empty issuer, empty subject, populated hostname) is NOT laundered into self_signed", () => {
    // Root cause: a missing/unreadable cert returns an empty issuer, but
    // hostname stays populated from hosts.toml (a different source). The old
    // `(!obj.issuer && obj.hostname)` clause laundered this no-cert payload
    // into self_signed. It must now fall through to `unknown`.
    const data = { issuer: "", subject: "", hostname: "vpn.example.com" };
    const result = parseCertInfo(data);
    expect(result.certType).toBe("unknown");
  });

  it("positive guard: a real self-signed cert (issuer === subject, both non-empty) still classifies as self_signed", () => {
    const data = {
      issuer: "C = US, CN = vpn.example.com",
      subject: "C = US, CN = vpn.example.com",
      hostname: "vpn.example.com",
    };
    const result = parseCertInfo(data);
    expect(result.certType).toBe("self_signed");
  });

  it("positive guard: a canonical Let's Encrypt issuer still classifies as lets_encrypt", () => {
    const data = {
      issuer: "C = US, O = Let's Encrypt, CN = R3",
      subject: "CN = vpn.example.com",
      hostname: "vpn.example.com",
    };
    const result = parseCertInfo(data);
    expect(result.certType).toBe("lets_encrypt");
  });

  // ── R2-F06: backend `present` flag (cert_code == 0) ──────────────────────
  // The async get_cert_info wrapper now emits `present` = (openssl exit 0).
  // parseCertInfo carries it through so the consuming components can tell a
  // MISSING cert (present:false) from a present-but-unrecognized-type one
  // (present:true, certType "unknown"). Old backends omitting the key parse
  // with present === undefined (callers fall back to the notAfter heuristic).

  it("R2-F06: a payload with present:true and a readable cert carries present === true", () => {
    const data = {
      present: true,
      hostname: "vpn.example.com",
      issuer: "C = US, O = Let's Encrypt, CN = R3",
      notAfter: "2027-06-15T00:00:00Z",
    };
    const result = parseCertInfo(data);
    expect(result.present).toBe(true);
  });

  it("R2-F06: a missing-cert payload (present:false, empty cert fields, hostname set) carries present === false and a domain from hostname", () => {
    // The backend keeps hostname/certPath from hosts.toml even when openssl
    // fails to read the cert. present:false flags the absence explicitly; the
    // domain survives (it is a different source), the cert state does not.
    const data = {
      present: false,
      hostname: "vpn.example.com",
      issuer: "",
      subject: "",
      notAfter: "",
    };
    const result = parseCertInfo(data);
    expect(result.present).toBe(false);
    expect(result.domain).toBe("vpn.example.com");
  });

  it("R2-F06: a payload omitting present (old backend) parses with present === undefined (backwards-compat)", () => {
    const data = {
      hostname: "example.com",
      issuer: "C = US, O = Let's Encrypt, CN = R3",
      notAfter: "2027-06-15T00:00:00Z",
    };
    const result = parseCertInfo(data);
    expect(result.present).toBeUndefined();
    // No regression to the existing parse path.
    expect(result.certType).toBe("lets_encrypt");
    expect(result.domain).toBe("example.com");
  });

  it("truncates standard SHA256 fingerprint to first/last 8 octets", () => {
    const fp = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
    const truncated = truncateFingerprint(fp);
    expect(truncated).toMatch(/^AA:BB:CC:DD:EE:FF:00:11/);
    expect(truncated).toMatch(/22:33:44:55:66:77:88:99$/);
    expect(truncated).toContain("…");
  });

  it("returns empty string for undefined fingerprint", () => {
    expect(truncateFingerprint(undefined)).toBe("");
  });

  it("returns short fingerprints unchanged (≤ 30 chars)", () => {
    expect(truncateFingerprint("AA:BB:CC")).toBe("AA:BB:CC");
  });

  it("returns non-standard-format fingerprint unchanged when colon count < 16", () => {
    const odd = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
    expect(truncateFingerprint(odd)).toBe(odd);
  });
});
