/**
 * Compare two filesystem paths for "same file" after normalizing away the cosmetic
 * differences that make a raw `===` lie on Windows: path-separator style (`\` vs `/`),
 * drive-letter / general casing, and the extended-length (verbatim) prefix.
 *
 * Why this exists: the «Подключение» tab joins the live VPN status to a config card by path.
 * `activeConfigPath` comes from localStorage `tt_config_path` (written by the connect flow)
 * while a manifest entry's `path` comes from Rust `list_configs` — the SAME file routinely
 * arrives in different string forms (`C:\app\x.toml` vs `C:/app/x.toml`, `c:` vs `C:`). A
 * byte comparison then silently fails, so the connected card paints disconnected and its
 * button label inverts (11-UAT gaps B/C). Normalizing both sides fixes the match.
 *
 * The Windows extended-length prefix (`\\?\C:\…`, `\\?\UNC\srv\share\…`) is what
 * `std::fs::canonicalize` returns for an ordinary path. It is cosmetic for identity: the
 * prefixed and plain spellings name one file, so a path that crossed the Rust boundary in
 * canonical form must still find its card (gap G-03.1-5).
 *
 * This is a presentation-layer identity check, NOT a security boundary — path validation
 * against the portable data dir stays in Rust (V12). Windows filesystems are case-insensitive
 * so lowercasing is the correct equality here.
 */
export function samePath(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  if (!a || !b) return false;
  return normalizePath(a) === normalizePath(b);
}

/**
 * Trim, unify separators (`\` → `/`), lowercase, then drop the extended-length prefix
 * (`//?/unc/` becomes `//`, a bare `//?/` is removed). Exported so callers that need a stable
 * map/dedup key derive it the same way `samePath` compares.
 *
 * The prefix is stripped from the already-unified form, so both the `\\?\` and the `//?/`
 * spellings are accepted and the function is idempotent. `lifecycle::canonical_path_key` in
 * Rust performs the same steps in the same order; `pathIdentityCases.json` is the contract
 * both sides are tested against.
 */
export function normalizePath(p: string): string {
  const unified = p.trim().replace(/\\/g, "/").toLowerCase();
  if (unified.startsWith("//?/unc/")) return `//${unified.slice("//?/unc/".length)}`;
  if (unified.startsWith("//?/")) return unified.slice("//?/".length);
  return unified;
}
