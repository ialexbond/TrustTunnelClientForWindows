// Cert helpers — extracted from CertSection.tsx so OverviewSection can reuse
// without violating react-refresh/only-export-components.

export interface CertInfo {
  certType: "self_signed" | "lets_encrypt" | "unknown";
  domain: string;
  notAfter: string;
  autoRenew: boolean;
  // Phase 16 Plan 05 — additive fields populated by extended backend response
  // (Phase 16 Plan 02 — `server_get_cert_info` returns sha256Fingerprint /
  // notBefore / issuer / subject alongside existing notAfter/autoRenew).
  // All optional — older backend responses skipping these still parse cleanly.
  notBefore?: string;
  sha256Fingerprint?: string;
  subjectCn?: string;
  issuerSummary?: string;
  // R2-F06 (Plan 09-36) — explicit cert-presence flag, mirrored from the
  // backend `present` (= openssl exit code 0). Lets consumers distinguish a
  // MISSING/unreadable cert (present === false) from a present-but-
  // unrecognized-type one (present === true, certType "unknown"). Optional:
  // an old backend that omits the key leaves this `undefined`, and callers
  // fall back to the notAfter-based readability heuristic (no regression).
  present?: boolean;
}

interface CertInfoResponse {
  hostname?: string;
  certPath?: string;
  notAfter?: string;
  notBefore?: string;
  issuer?: string;
  subject?: string;
  autoRenew?: boolean;
  sha256Fingerprint?: string;
  // R2-F06 (Plan 09-36) — backend `present` flag (cert_code == 0). Absent on
  // older backends → parsed as undefined.
  present?: boolean;
}

export function parseCertInfo(data: unknown): CertInfo {
  const result: CertInfo = {
    certType: "unknown",
    domain: "",
    notAfter: "",
    autoRenew: false,
  };

  let parsed: unknown = data;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch {
      const str = data as string;
      const typeMatch = str.match(/type\s*[:=]\s*"?([^"\n]+)"?/i);
      if (typeMatch) {
        const val = typeMatch[1].trim().toLowerCase();
        if (val.includes("let") || val.includes("acme")) result.certType = "lets_encrypt";
        else if (val.includes("self")) result.certType = "self_signed";
      }
      const domainMatch = str.match(/domain\s*[:=]\s*"?([^"\n]+)"?/i);
      if (domainMatch) result.domain = domainMatch[1].trim();
      const expiryMatch = str.match(/not_?after\s*[:=]\s*"?([^"\n]+)"?/i);
      if (expiryMatch) result.notAfter = expiryMatch[1].trim();
      const renewMatch = str.match(/auto_?renew\s*[:=]\s*(true|false)/i);
      if (renewMatch) result.autoRenew = renewMatch[1].toLowerCase() === "true";
      return result;
    }
  }

  if (parsed && typeof parsed === "object") {
    const obj = parsed as CertInfoResponse;
    const issuer = (obj.issuer || "").toLowerCase();
    const subject = (obj.subject || "").toLowerCase();
    if (issuer.includes("let's encrypt") || issuer.includes("acme") || issuer.includes("letsencrypt") || issuer.includes("r3") || issuer.includes("r10") || issuer.includes("r11")) {
      result.certType = "lets_encrypt";
    } else if (
      // UAT-F12: self_signed now requires positive evidence — either the issuer
      // literally names itself ("self"), or issuer and subject are both present
      // and equal. The old middle clause `(!obj.issuer && obj.hostname)` laundered
      // a MISSING cert into self_signed: a missing/unreadable cert returns an empty
      // issuer, but hostname stays populated from hosts.toml (a different source),
      // so an absent cert looked self-signed. An all-empty payload now falls
      // through to the neutral `unknown` branch.
      issuer.includes("self") ||
      (issuer && subject && issuer === subject)
    ) {
      result.certType = "self_signed";
    }
    result.domain = obj.hostname || obj.subject?.replace(/^CN\s*=\s*/, "") || "";
    result.notAfter = obj.notAfter || "";
    result.autoRenew = obj.autoRenew ?? false;

    // R2-F06 (Plan 09-36) — carry the backend `present` flag verbatim. Leave it
    // `undefined` when the key is absent (old backend) so consumers can detect
    // "presence unknown" and fall back to the notAfter heuristic. Only assign
    // when the backend actually sent a boolean.
    if (typeof obj.present === "boolean") {
      result.present = obj.present;
    }

    // Phase 16 Plan 05 — additive cert fields. All optional → only populate
    // when backend provided values, otherwise leave undefined so renderers
    // can short-circuit row display.
    if (obj.subject && typeof obj.subject === "string") {
      const cnMatch = obj.subject.match(/CN\s*=\s*([^,]+)/i);
      if (cnMatch) result.subjectCn = cnMatch[1].trim();
    }
    if (obj.issuer && typeof obj.issuer === "string") {
      // Extract Organization (O) — это user-facing name CA. CN suffix
      // (e.g. "R3", "E8") = intermediate cert serial — useless для end-user
      // (P UAT 2026-05-04: «нахуя там E8, нахуя пользователю»).
      // Используем O если есть, иначе fallback на CN.
      const oMatch = obj.issuer.match(/O\s*=\s*([^,]+)/i);
      const cnMatch = obj.issuer.match(/CN\s*=\s*([^,]+)/i);
      if (oMatch) {
        result.issuerSummary = oMatch[1].trim();
      } else if (cnMatch) {
        result.issuerSummary = cnMatch[1].trim();
      }
    }
    if (obj.notBefore && typeof obj.notBefore === "string") {
      result.notBefore = obj.notBefore;
    }
    if (obj.sha256Fingerprint && typeof obj.sha256Fingerprint === "string") {
      result.sha256Fingerprint = obj.sha256Fingerprint;
    }
  }

  return result;
}

/**
 * Truncate SHA256 fingerprint for inline display.
 *
 * Standard SHA256 fingerprint is 32 octets separated by colons (~95 chars).
 * Show first 8 + ellipsis + last 8 octets so the value is identifiable
 * without overflowing card width. Full value is exposed via `title` attribute
 * on the rendered `<code>` element so users can hover/copy the complete hash.
 *
 * Returns empty string for `undefined` input — caller can `{fp && truncate(fp)}`.
 * Returns input as-is when colon-count < 16 (non-standard format) so caller
 * can display whatever was passed without losing data.
 */
export function truncateFingerprint(full: string | undefined): string {
  if (!full) return "";
  if (full.length <= 30) return full;
  const parts = full.split(":");
  if (parts.length < 16) return full;
  return parts.slice(0, 8).join(":") + " … " + parts.slice(-8).join(":");
}

export function daysUntil(dateStr: string): number | null {
  try {
    const target = new Date(dateStr);
    if (isNaN(target.getTime())) return null;
    const now = new Date();
    const diff = target.getTime() - now.getTime();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  } catch {
    return null;
  }
}

// PA-6: `pluralRu` moved to `shared/lib/pluralRu.ts` (a generic count-declension
// primitive, not a cert concern) so «Подключение» stops reaching into the «Сервер»
// feature. In-feature callers (CertModal / CertSection / SecuritySection) import it
// from `shared/lib/pluralRu` directly — no re-export kept here (true relocation).
