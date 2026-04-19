/**
 * Per-user advanced TLV parameters persisted on the server in
 * `users-advanced.toml` — FIX-NN (14.1-HANDOFF).
 *
 * The upstream TrustTunnel protocol does not persist display_name /
 * custom_sni / upstream_protocol / skip_verification / pin_certificate /
 * dns_upstreams — they were session-scoped. This sidecar keeps them so
 * Edit / FileText reopen / Download .toml all reflect what the user
 * last saved.
 */

/** UI-shape advanced params. Mirrors `DeeplinkFields` minus cidr, which
 * still lives in rules.toml. */
export interface UserAdvancedParams {
  displayName: string;
  customSni: string;
  upstreamProtocol: "auto" | "h2" | "h3";
  skipVerification: boolean;
  pinCert: boolean;
  /** Base64-encoded DER leaf certificate. Source of truth is the server file. */
  certDerB64: string | null;
  /**
   * Lowercase SHA-256 hex of the DER bytes. Backend doesn't persist this —
   * it's derivable from `certDerB64` via `server_fetch_endpoint_cert` or
   * an equivalent probe if the user opens the card.
   */
  certFingerprint: string | null;
  dnsUpstreams: string[];
  antiDpi: boolean;
}

/**
 * Raw shape returned by `server_get_user_advanced` (Rust struct
 * `UserAdvanced` serialized with default snake_case). `null` fields map
 * to `None` on the Rust side.
 */
export interface UserAdvancedServerResponse {
  username: string;
  display_name: string | null;
  custom_sni: string | null;
  upstream_protocol: string | null;
  skip_verification: boolean;
  pin_cert_der_b64: string | null;
  dns_upstreams: string[];
  anti_dpi: boolean;
}

/**
 * Accept `undefined`, `null`, or `string`. Rust serializes `Option::None`
 * with `skip_serializing_if = "Option::is_none"` → the key is OMITTED from
 * the JSON, not set to `null`. Earlier revisions only accepted explicit
 * null, which meant every user whose advanced entry had ANY missing
 * optional (display_name, custom_sni, upstream_protocol, pin_cert_der_b64)
 * failed shape validation → UserModal Edit mode fell back to
 * DEFAULT_DEEPLINK → every field looked empty.
 */
function isOptionalString(v: unknown): boolean {
  return v === undefined || v === null || typeof v === "string";
}

function isUserAdvancedServerResponse(v: unknown): v is UserAdvancedServerResponse {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.username === "string" &&
    isOptionalString(r.display_name) &&
    isOptionalString(r.custom_sni) &&
    isOptionalString(r.upstream_protocol) &&
    typeof r.skip_verification === "boolean" &&
    isOptionalString(r.pin_cert_der_b64) &&
    Array.isArray(r.dns_upstreams) &&
    r.dns_upstreams.every((d) => typeof d === "string") &&
    typeof r.anti_dpi === "boolean"
  );
}

/**
 * Map the server-side snake_case shape → UI camelCase shape. Returns
 * `null` when the server has no entry (`null` itself) or the payload
 * failed shape validation — caller should fall back to UI defaults.
 */
export function fromServerResponse(raw: unknown): UserAdvancedParams | null {
  if (raw === null || raw === undefined) return null;
  if (!isUserAdvancedServerResponse(raw)) return null;
  const proto = raw.upstream_protocol;
  const upstreamProtocol: UserAdvancedParams["upstreamProtocol"] =
    proto === "h2" || proto === "h3" ? proto : "auto";
  return {
    displayName: raw.display_name ?? "",
    customSni: raw.custom_sni ?? "",
    upstreamProtocol,
    skipVerification: raw.skip_verification,
    // Presence of cert bytes on the server implies the user previously
    // opted into pinning. The fingerprint isn't persisted — the cert card
    // can recompute on demand, but we don't auto-fire a TLS probe here.
    pinCert: !!raw.pin_cert_der_b64,
    certDerB64: raw.pin_cert_der_b64,
    certFingerprint: null,
    dnsUpstreams: raw.dns_upstreams,
    antiDpi: raw.anti_dpi,
  };
}

/**
 * Build the `params` payload for `server_set_user_advanced`.
 *
 * FIX-OO-12: always persist `pin_cert_der_b64` when the user toggled Pin
 * Certificate ON, regardless of whether the chain is system-verifiable.
 * Earlier revisions (FIX-OO-10) stripped the bytes on persist to keep
 * the downloaded TOML clean, but that also wiped the toggle state —
 * Edit-reopen read `pin_cert_der_b64 = null`, derived `pinCert = false`,
 * and the toggle snapped OFF. Users reasonably expected it to stay ON.
 *
 * The "don't bloat the deeplink / downloaded TOML with a CA chain"
 * invariant is enforced elsewhere:
 *   - deeplink-encoder gate in UserModal.handleAdd / handleSave
 *     (`pinCert && !certIsSystemVerifiable`)
 *   - overlay's multi-block-PEM heuristic in
 *     `inject_advanced_into_endpoint` (> 1 `-----BEGIN CERTIFICATE-----`
 *     block ⇒ strip `certificate` from exported TOML)
 *
 * Both run on every export and make the correct decision from the bytes
 * alone, so storage can safely keep the full chain.
 */
export function toServerPayload(
  p: UserAdvancedParams,
  username: string,
): UserAdvancedServerResponse {
  return {
    username,
    display_name: p.displayName.length > 0 ? p.displayName : null,
    custom_sni: p.customSni.length > 0 ? p.customSni : null,
    upstream_protocol: p.upstreamProtocol !== "auto" ? p.upstreamProtocol : null,
    skip_verification: p.skipVerification,
    pin_cert_der_b64: p.pinCert ? p.certDerB64 : null,
    dns_upstreams: p.dnsUpstreams,
    anti_dpi: p.antiDpi,
  };
}

/**
 * Heuristic: a base64-encoded DER cert bundle larger than ~2.5 KB is
 * almost certainly a CA-issued chain (leaf + intermediate[+ root]). A
 * self-signed single leaf is typically 1–2 KB DER (≈ 1.3–2.7 KB base64).
 *
 * Used to recover the `certIsSystemVerifiable` flag on Edit-reopen when
 * the stored `pin_cert_der_b64` is the only surviving artifact of the
 * probe. The runtime result matches
 * `rustls_platform_verifier` (FIX-OO-7) closely enough that deeplink
 * regeneration + `.toml` overlay both make the right embed/skip choice
 * without a dedicated persisted flag.
 */
export function isLikelyCaChain(certDerB64: string | null): boolean {
  if (!certDerB64) return false;
  return certDerB64.length > 2500;
}

/**
 * CRIT-2 follow-up: derive the SHA-256 fingerprint locally from stored DER
 * bytes. Backend's `UserAdvanced` does NOT persist the hash — only the raw
 * DER. When UserModal's Edit mode reloads, `certFingerprint` comes back
 * `null`, and without this helper the CertificateFingerprintCard cannot
 * hydrate its success state (it needs BOTH fingerprint AND DER).
 *
 * Format matches `server_fetch_endpoint_cert` output: uppercase hex octets
 * joined with `:` (AA:BB:CC:...). Uses the WebCrypto SubtleCrypto API that
 * ships with every modern browser engine and the Tauri WebView.
 */
export async function deriveFingerprintFromDerB64(
  derB64: string,
): Promise<string> {
  const bin = atob(derB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  // C-cert-format: match backend `format_fingerprint_hex` (cert_probe.rs:326)
  // — lowercase hex, no separators. A display helper inserts `:` only at
  // render time, so the internal representation stays single-source.
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Normalize a SHA-256 fingerprint for display regardless of what format the
 * source gave us. Accepts:
 *   - `"aabbcc..."`       (backend server_fetch_endpoint_cert output)
 *   - `"AA:BB:CC:..."`    (pre-C legacy derivation)
 *   - `"aa:bb:cc:..."`    (any other colon-separated variant)
 *
 * Returns `"AA:BB:CC:..."` uppercase, byte-grouped — reads well in the UI.
 * Non-hex chars (spaces, dashes, colons) are stripped before grouping so a
 * paste from a command-line tool with random whitespace still displays ok.
 */
export function formatFingerprintForDisplay(raw: string | null | undefined): string {
  if (!raw) return "";
  const hex = raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (!hex) return "";
  return hex.match(/.{1,2}/g)?.join(":") ?? "";
}
