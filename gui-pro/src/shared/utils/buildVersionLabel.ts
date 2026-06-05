// T-13 — build version label helper.
//
// Produces the string shown in the About screen's version pill. When a build
// hash was injected at build time (VITE_BUILD_HASH → __BUILD_HASH__ via the vite
// `define` global) we render `<version>-<hash>` so a tester can confirm the exact
// build (CLAUDE.md «Метка сборки»). When no hash is set (plain dev run, hash is
// an empty string) we fall back to the bare `<version>` — the graceful fallback.
//
// Pulled out of the component as a pure function so the both-renders behaviour
// can be unit-tested with explicit args (the `__BUILD_HASH__` global is inlined
// as a literal by vite `define`, so it cannot be flipped from a test at runtime;
// testing this pure helper proves the present/absent branches instead).
export function buildVersionLabel(version: string, buildHash: string): string {
  return buildHash ? `${version}-${buildHash}` : version;
}
