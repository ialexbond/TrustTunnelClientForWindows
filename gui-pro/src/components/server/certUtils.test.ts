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
