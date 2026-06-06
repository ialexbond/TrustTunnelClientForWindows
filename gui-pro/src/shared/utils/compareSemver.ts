/**
 * compareSemver — the single semver-ish comparator for the whole app.
 *
 * Phase 04 Plan 05 dedup (PANEL-04, Service H-01 / Chrome M-01): four copy-paste
 * comparators used to live in the codebase, three descending and one ascending:
 *   - `ServiceTabSection.tsx`    `compareSemverDesc`   (descending, negative when a > b)
 *   - `ProtocolUpdateSection.tsx` `compareSemverDesc`  (descending)
 *   - `ControlPanelPage.tsx`     `compareSemverDescCP` (descending)
 *   - `useUpdateChecker.ts`      `compareVersions`     (ascending, +1 when a > b)
 * All four now import this one function. Per audit M-01 the canonical direction
 * is **ASCENDING**: the result is POSITIVE when `a > b`, negative when `a < b`,
 * and `0` when the two versions are numerically equal. Each former call site
 * keeps its observable behavior by adapting its sign (descending sites negate /
 * swap arguments) — see the one-line direction comment at each site.
 *
 * Parsing rules (preserved verbatim from the prior bodies so behavior is
 * byte-identical):
 *   - strip a single leading `v` (e.g. `"v1.2.3"` → `"1.2.3"`),
 *   - drop any pre-release suffix after the first `-` (`"2.1.1-test"` → `"2.1.1"`),
 *   - split the remaining string on `.`,
 *   - `parseInt(segment, 10) || 0` per segment (non-numeric / missing → 0),
 *   - pad the shorter list with zeros up to the longer length.
 *
 * Numeric, not lexicographic: `"1.10.0" > "1.9.0"`.
 *
 * @param a first version string
 * @param b second version string
 * @returns positive when `a > b`, negative when `a < b`, `0` when equal
 */
export function compareSemver(a: string, b: string): number {
  const parts = (s: string): number[] =>
    s
      .replace(/^v/, "")
      .split("-")[0]
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb; // ascending — positive when a > b
  }
  return 0;
}
