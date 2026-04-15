---
phase: 01-infrastructure-release-setup
reviewed: 2026-04-13T12:00:00Z
depth: standard
files_reviewed: 15
files_reviewed_list:
  - gui-app/.storybook/main.ts
  - gui-app/.storybook/preview.ts
  - gui-app/.storybook/tauri-mocks/api-core.ts
  - gui-app/.storybook/tauri-mocks/api-event.ts
  - gui-app/.storybook/tauri-mocks/api-app.ts
  - gui-app/.storybook/tauri-mocks/api-window.ts
  - gui-app/.storybook/tauri-mocks/plugin-dialog.ts
  - gui-app/.storybook/tauri-mocks/plugin-shell.ts
  - gui-app/src/docs/Colors.mdx
  - gui-app/src/docs/Typography.mdx
  - gui-app/src/docs/Spacing.mdx
  - gui-app/src/docs/Shadows.mdx
  - gui-app/src-tauri/Cargo.toml
  - gui-app/package.json
  - gui-app/src-tauri/tauri.conf.json
findings:
  critical: 0
  warning: 1
  info: 3
  total: 4
status: issues_found
---

# Phase 01: Code Review Report

**Reviewed:** 2026-04-13T12:00:00Z
**Depth:** standard
**Files Reviewed:** 15
**Status:** issues_found

## Summary

This changeset introduces Storybook 10 infrastructure for the v3.0 redesign: configuration (`main.ts`, `preview.ts`), Tauri API mocks for browser-based component development, design foundation documentation pages (Colors, Typography, Spacing, Shadows in MDX), and package.json updates for Storybook dependencies and scripts. Three files (`Cargo.toml`, `tauri.conf.json`, `eslint.config.js`) were in scope but unchanged on this branch or had only minor reformatting.

Overall quality is good. The Tauri mock strategy is well-structured with clean alias-based module replacement. The MDX documentation pages are thorough. One warning: a missing explicit dependency declaration for `@storybook/addon-essentials`. Three informational items regarding TypeScript type usage in mocks and hardcoded version in a mock file.

## Warnings

### WR-01: Missing explicit dependency for @storybook/addon-essentials

**File:** `gui-app/.storybook/main.ts:14`
**Issue:** The `addons` array references `@storybook/addon-essentials`, but this package is not listed in `package.json` devDependencies. In Storybook 10, `addon-essentials` may be re-exported by the core `storybook` package, but relying on transitive/implicit dependencies is fragile. If the `storybook` package changes its internal bundling in a patch or minor version, the build would break with a confusing "module not found" error.
**Fix:** Add it explicitly to devDependencies:
```json
"@storybook/addon-essentials": "^10.3.5",
```

## Info

### IN-01: Use of TypeScript `Function` type in mock signatures

**File:** `gui-app/.storybook/tauri-mocks/api-event.ts:2`
**File:** `gui-app/.storybook/tauri-mocks/api-window.ts:9-10`
**Issue:** The `Function` type is used for callback parameters (`_handler: Function`). The `Function` type provides no type safety -- it accepts any callable and its arguments/return types are unchecked. The `@typescript-eslint/ban-types` rule (part of recommended configs) typically flags this. While acceptable in mock/stub code that will never execute real logic, it sets a poor pattern if copied into production code.
**Fix:** Replace with more specific signatures, for example:
```typescript
// api-event.ts
export const listen = async (_event: string, _handler: (...args: unknown[]) => void): Promise<() => void> => {
  return () => {};
};

// api-window.ts
onCloseRequested: async (_handler: (...args: unknown[]) => void) => () => {},
listen: async (_event: string, _handler: (...args: unknown[]) => void) => () => {},
```

### IN-02: Hardcoded version string in mock

**File:** `gui-app/.storybook/tauri-mocks/api-app.ts:3`
**Issue:** The `getVersion` mock returns a hardcoded `'3.0.0'` string. This will drift from the actual version in `tauri.conf.json` (currently `2.7.0`) and `package.json`. While this is a mock and the exact value may not matter for visual testing, it could cause confusion when stories display version information.
**Fix:** Either return a clearly-mock value like `'0.0.0-storybook'` to make it obvious this is not real, or add a comment explaining the intentional mismatch:
```typescript
// Returns future target version for v3.0 redesign stories
export const getVersion = async (): Promise<string> => '3.0.0';
```

### IN-03: Hardcoded HMR port in Storybook Vite config

**File:** `gui-app/.storybook/main.ts:21`
**Issue:** The HMR configuration hardcodes `port: 6007`. If this port is already in use, HMR will silently fail without a clear error message. This is a minor developer experience concern, not a bug.
**Fix:** Consider adding a comment documenting the port choice, or omitting the `hmr` block to let Vite auto-negotiate:
```typescript
// Port 6007 chosen to avoid conflict with Storybook dev server (6006)
// and Tauri dev server (1420)
hmr: { host: 'localhost', port: 6007, protocol: 'ws' },
```

---

_Reviewed: 2026-04-13T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
