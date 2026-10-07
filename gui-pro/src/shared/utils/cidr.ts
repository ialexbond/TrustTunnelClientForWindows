/**
 * CIDR parsing and validation utilities.
 *
 * Frontend first-line validation. Backend (src-tauri/src/ssh/sanitize.rs::validate_cidr)
 * provides defense-in-depth — `isValidCidr` alone must stay synchronized with it (it is the
 * IPv4 CIDR validator for the server-side users CIDR field). The IPv6/IPv4-host helpers below
 * (isValidIpv4, isValidIpv6, isValidIpv6Cidr, isValidRouteAddress) serve only the local routing-
 * rule address field (AddRuleInput, MR3-06 / D-17) and have no backend mirror — sanitize.rs does
 * not validate routing-rule addresses.
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

/**
 * Plain IPv4 host address (no CIDR suffix): exactly 4 dot-separated decimal octets, 0-255.
 * MR3-06 / D-17 — feeds isValidRouteAddress; AddRuleInput's routing-rule field only.
 */
export function isValidIpv4(s: string): boolean {
  const octets = s.split(".");
  if (octets.length !== 4) return false;
  for (const oct of octets) {
    if (oct === "" || !/^\d+$/.test(oct)) return false;
    const n = Number.parseInt(oct, 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) return false;
  }
  return true;
}

/**
 * Hand-rolled structural IPv6 address check — no RFC 4291 embedded-IPv4-tail support (not
 * needed for a routing-rule field; such input is rejected here, same as before this fix).
 *
 * Rule: split on the FIRST "::" (at most one occurrence is legal — a second "::" means the
 * address is ambiguous and is rejected here via the >1-part split-count check); each side's
 * groups split on ":"; every group is 1-4 hex digits; a bare address (no "::") has exactly 8
 * groups, one with "::" has at most 7 (the "::" stands in for one or more all-zero groups).
 */
export function isValidIpv6(s: string): boolean {
  if (s === "") return false;
  if (!/^[0-9a-fA-F:]+$/.test(s)) return false;

  const doubleColonParts = s.split("::");
  if (doubleColonParts.length > 2) return false; // more than one "::" — ambiguous, reject

  const parseGroups = (part: string): string[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null; // empty or >4 hex digits
    }
    return groups;
  };

  if (doubleColonParts.length === 2) {
    const [left, right] = doubleColonParts;
    const leftGroups = parseGroups(left);
    const rightGroups = parseGroups(right);
    if (leftGroups === null || rightGroups === null) return false;
    return leftGroups.length + rightGroups.length <= 7;
  }

  const groups = parseGroups(doubleColonParts[0]);
  return groups !== null && groups.length === 8;
}

/**
 * IPv6 subnet: exactly one "/", left side a valid IPv6 address, right side a decimal prefix
 * length 0-128. MR3-06 / D-17.
 */
export function isValidIpv6Cidr(s: string): boolean {
  const slashIndex = s.indexOf("/");
  if (slashIndex === -1 || s.indexOf("/", slashIndex + 1) !== -1) return false;
  const ip = s.slice(0, slashIndex);
  const prefixStr = s.slice(slashIndex + 1);
  if (ip === "" || prefixStr === "" || !isValidIpv6(ip)) return false;
  if (!/^\d+$/.test(prefixStr)) return false;
  const prefix = Number.parseInt(prefixStr, 10);
  return Number.isFinite(prefix) && prefix >= 0 && prefix <= 128;
}

/**
 * The single decision AddRuleInput's validateEntry defers to for any digits/dots/colons/slash
 * input: a plain IPv4 host, an IPv4 CIDR (via isValidCidr — non-empty only, empty string has a
 * different meaning in the users-CIDR field this validator also serves), a plain IPv6 host, or
 * an IPv6 subnet. MR3-06 / D-17 / D-19.
 */
export function isValidRouteAddress(s: string): boolean {
  return (
    isValidIpv4(s) || (s !== "" && isValidCidr(s)) || isValidIpv6(s) || isValidIpv6Cidr(s)
  );
}
