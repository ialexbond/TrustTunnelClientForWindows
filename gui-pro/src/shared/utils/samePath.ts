/**
 * Compare two filesystem paths for "same file" after normalizing away the cosmetic
 * differences that make a raw `===` lie on Windows: path-separator style (`\` vs `/`) and
 * drive-letter / general casing.
 *
 * Why this exists: the «Подключение» tab joins the live VPN status to a config card by path.
 * `activeConfigPath` comes from localStorage `tt_config_path` (written by the connect flow)
 * while a manifest entry's `path` comes from Rust `list_configs` — the SAME file routinely
 * arrives in different string forms (`C:\app\x.toml` vs `C:/app/x.toml`, `c:` vs `C:`). A
 * byte comparison then silently fails, so the connected card paints disconnected and its
 * button label inverts (11-UAT gaps B/C). Normalizing both sides fixes the match.
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
 * Lowercase + unify separators (`\` → `/`) + trim. Exported so callers that need a stable
 * map/dedup key derive it the same way `samePath` compares.
 */
export function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").toLowerCase();
}
