import { compareSemver } from "./compareSemver";

/**
 * latestSemver — pick the numerically GREATEST version from a list.
 *
 * Phase 09 Plan 09-13 (E-17): the sidecar-update cascade used to treat
 * `githubReleases[0]` as "latest", but the GitHub releases feed is ordered by
 * PUBLISH time, not by semver. A hotfix for an older minor can be published
 * AFTER a newer minor (e.g. `1.0.34` released, then `1.0.33-hotfix` published
 * later), so `[0]` is not reliably the highest version. This helper derives
 * "latest" by semver-max instead, so the update dot/arrow compare against the
 * real newest release.
 *
 * Built ON `compareSemver` (the single app-wide comparator) so the parse rules
 * stay single-sourced and never diverge:
 *   - strip a single leading `v` (`"v1.2.3"` → `"1.2.3"`),
 *   - drop any pre-release suffix after the first `-` (`"2.1.1-rc1"` → `"2.1.1"`),
 *   - numeric, not lexicographic (`"1.10.0" > "1.9.0"`).
 *
 * The returned value is the matching INPUT element verbatim (with its original
 * `v` prefix / casing), so the caller decides how to display it. compareSemver
 * is ASCENDING (positive when a > b), so the max is the element for which
 * `compareSemver(candidate, current) > 0`.
 *
 * Shared helper: imported by `useSidecarUpdateCascade` (this plan) and by
 * `ServiceTabSection` (Plan 09-21) — one helper, no per-site re-implementation.
 *
 * @param versions list of version strings (any order)
 * @returns the semver-max element, or `""` for an empty list
 */
export function latestSemver(versions: string[]): string {
  if (versions.length === 0) return "";
  return versions.reduce((max, v) => (compareSemver(v, max) > 0 ? v : max));
}
