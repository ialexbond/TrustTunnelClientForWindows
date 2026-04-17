// Cert helpers — extracted from CertSection.tsx so OverviewSection can reuse
// without violating react-refresh/only-export-components.

export interface CertInfo {
  certType: "self_signed" | "lets_encrypt" | "unknown";
  domain: string;
  notAfter: string;
  autoRenew: boolean;
}

interface CertInfoResponse {
  hostname?: string;
  certPath?: string;
  notAfter?: string;
  issuer?: string;
  subject?: string;
  autoRenew?: boolean;
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
      issuer.includes("self") ||
      (!obj.issuer && obj.hostname) ||
      (issuer && subject && issuer === subject)
    ) {
      result.certType = "self_signed";
    }
    result.domain = obj.hostname || obj.subject?.replace(/^CN\s*=\s*/, "") || "";
    result.notAfter = obj.notAfter || "";
    result.autoRenew = obj.autoRenew ?? false;
  }

  return result;
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
