/**
 * CIDR parsing and validation utilities.
 *
 * Frontend first-line validation. Backend (src-tauri/src/ssh/sanitize.rs::validate_cidr)
 * provides defense-in-depth — the two validators must stay synchronized.
 *
 * Semantic: empty string = no CIDR restriction (rules.toml rule omits `cidr =` key).
 *           "0.0.0.0/0" = explicit allow-all (rules.toml writes `cidr = "0.0.0.0/0"`).
 * See: 14.1-RESEARCH.md Pitfall 6 (0.0.0.0/0 vs empty semantics).
 */

export interface CidrParts {
  octets: [string, string, string, string];
  prefix: string;
}

/**
 * Accept empty (no restriction) OR well-formed `X.X.X.X/N` with octets 0..=255
 * and prefix 0..=32. Char whitelist rejects shell metacharacters.
 */
export function isValidCidr(s: string): boolean {
  if (s === "") return true;
  if (s.length > 18) return false;
  if (!/^[0-9./]+$/.test(s)) return false;
  const parts = s.split("/");
  if (parts.length !== 2) return false;
  const octets = parts[0].split(".");
  if (octets.length !== 4) return false;
  for (const oct of octets) {
    if (oct === "") return false;
    if (!/^\d+$/.test(oct)) return false;
    const n = Number.parseInt(oct, 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) return false;
  }
  if (parts[1] === "" || !/^\d+$/.test(parts[1])) return false;
  const prefix = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return false;
  return true;
}

/**
 * Split a CIDR string into octet+prefix parts. Returns null if empty or invalid.
 */
export function parseCidr(s: string): CidrParts | null {
  if (s === "" || !isValidCidr(s)) return null;
  const [ip, prefix] = s.split("/");
  const [o1, o2, o3, o4] = ip.split(".");
  return { octets: [o1, o2, o3, o4], prefix };
}

/**
 * Build a CIDR string from parts. Returns "" if any field is empty (partial state).
 * Does NOT validate the numeric ranges — caller uses isValidCidr() separately.
 */
export function formatCidr(octets: string[], prefix: string): string {
  if (octets.length !== 4) return "";
  if (octets.some((o) => o.trim() === "")) return "";
  if (prefix.trim() === "") return "";
  return `${octets[0]}.${octets[1]}.${octets[2]}.${octets[3]}/${prefix}`;
}

/**
 * Human-readable preview. Returns either an i18n key name (for fixed phrases)
 * OR a literal range description. Caller is responsible for feeding i18n keys
 * into t() and passing literal strings through directly.
 */
export function describeCidr(s: string): string {
  if (s === "") return "server.users.cidr_empty_any";
  if (s === "0.0.0.0/0") return "server.users.cidr_zero_all";
  if (!isValidCidr(s)) return "";
  const parts = parseCidr(s);
  if (!parts) return "";
  const { octets, prefix } = parts;
  const prefixN = Number.parseInt(prefix, 10);
  const hostBits = 32 - prefixN;
  const addresses = hostBits >= 32 ? "2^32" : String(2 ** hostBits);
  const startIp = octets.join(".");
  // Rough last-IP computation for display; exact if prefix on octet boundary
  const prefixOctet = Math.floor(prefixN / 8);
  const remainder = prefixN % 8;
  const endOctets = [...octets];
  if (prefixOctet < 4) {
    if (remainder === 0) {
      // Prefix falls exactly on an octet boundary:
      // the current octet and all following octets become 255.
      for (let i = 3; i >= prefixOctet; i--) {
        endOctets[i] = "255";
      }
    } else {
      // Prefix falls within an octet: octets after it are 255,
      // the partial octet gets its host bits ORed.
      for (let i = 3; i > prefixOctet; i--) {
        endOctets[i] = "255";
      }
      const mask = (0xff >> remainder) & 0xff;
      const startN = Number.parseInt(endOctets[prefixOctet], 10);
      endOctets[prefixOctet] = String(startN | mask);
    }
  }
  const endIp = endOctets.join(".");
  return `${startIp} – ${endIp} (${addresses} addresses)`;
}
