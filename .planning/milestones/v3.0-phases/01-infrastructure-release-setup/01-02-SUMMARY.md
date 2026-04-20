---
phase: 01-infrastructure-release-setup
plan: 02
subsystem: storybook
tags: [storybook, tauri-mocks, theme-toggle, infrastructure]
dependency_graph:
  requires: [01-01]
  provides: [storybook-infrastructure, tauri-api-mocks, theme-toggle]
  affects: [all-subsequent-phases-using-storybook]
tech_stack:
  added:
    - storybook@10.3.5
    - "@storybook/react-vite@10.3.5"
    - "@storybook/addon-themes@10.3.5"
    - "eslint-plugin-storybook@10.3.5"
  patterns:
    - viteFinal resolve aliases for Tauri API mocking in Storybook
    - withThemeByDataAttribute decorator for data-theme toggle
    - ESM fileURLToPath pattern for __dirname in .storybook/main.ts
key_files:
  created:
    - gui-pro/.storybook/main.ts
    - gui-pro/.storybook/preview.ts
    - gui-pro/.storybook/tauri-mocks/api-core.ts
    - gui-pro/.storybook/tauri-mocks/api-event.ts
    - gui-pro/.storybook/tauri-mocks/api-app.ts
    - gui-pro/.storybook/tauri-mocks/api-window.ts
    - gui-pro/.storybook/tauri-mocks/plugin-dialog.ts
    - gui-pro/.storybook/tauri-mocks/plugin-shell.ts
  modified:
    - gui-pro/package.json
    - gui-pro/package-lock.json
    - gui-pro/.gitignore
    - gui-pro/eslint.config.js
decisions:
  - "Used --skip-install flag (not --no-install, which does not exist in Storybook 10) + manual npm install --legacy-peer-deps"
  - "HMR override on port 6007 (not 6006) to avoid conflict with Storybook UI port"
  - "Used fileURLToPath(import.meta.url) for ESM-compatible __dirname in main.ts"
  - "npm install --legacy-peer-deps required due to eslint-plugin-react-hooks@^7 peer conflict"
metrics:
  duration: ~8m
  completed: "2026-04-13T16:31:54Z"
  tasks_completed: 1
  tasks_total: 1
---

# Phase 01 Plan 02: Storybook 10 Installation Summary

Storybook 10 installed for Tauri 2 + React 19 + Vite desktop app with global Tauri API mocks via viteFinal aliases, dark/light theme toggle via addon-themes, HMR override, and CSS token loading.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Install Storybook 10 and configure with Tauri mocks, theme toggle, HMR | 3dab219c | .storybook/main.ts, .storybook/preview.ts, .storybook/tauri-mocks/* (6 files), package.json, package-lock.json, .gitignore, eslint.config.js |

## Changes Made

### Storybook 10 Configuration

**`.storybook/main.ts`** — Framework config with:
- `@storybook/react-vite` framework
- `@storybook/addon-essentials` + `@storybook/addon-themes` addons
- `viteFinal` function with HMR override (port 6007, localhost, ws protocol)
- 6 resolve aliases mapping `@tauri-apps/*` to mock files
- ESM-compatible `__dirname` via `fileURLToPath(import.meta.url)`

**`.storybook/preview.ts`** — Global decorators with:
- `withThemeByDataAttribute` decorator — dark/light themes via `data-theme` attribute
- Default theme: dark
- Imports `../src/shared/styles/tokens.css` + `../src/index.css` for full CSS in Storybook iframe
- `backgrounds: { disable: true }` (themes addon handles backgrounds)

### Tauri API Mock Files (6 files)

Plain ESM exports — NOT vi.fn() (Storybook context, not Vitest):

| File | Exports |
|------|---------|
| `api-core.ts` | `invoke` — logs warning, returns null |
| `api-event.ts` | `listen`, `emit` — no-op async functions |
| `api-app.ts` | `getVersion` — returns '3.0.0' |
| `api-window.ts` | `getCurrentWindow`, `Window` class — full window mock |
| `plugin-dialog.ts` | `open` — returns null |
| `plugin-shell.ts` | `open` — returns undefined |

### Infrastructure Changes

- **package.json** — Added `storybook` and `build-storybook` scripts; storybook + addon-themes + eslint-plugin-storybook in devDependencies
- **eslint.config.js** — Added `eslint-plugin-storybook` in flat config format
- **.gitignore** — Added `*storybook.log` and `storybook-static` patterns
- **Scaffold stories removed** — `gui-pro/src/stories/` deleted entirely

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Wrong init flag `--no-install`**
- **Found during:** Task 1, Step 1
- **Issue:** Plan specified `--no-install` flag which does not exist in Storybook 10. The correct flag is `--skip-install`.
- **Fix:** Used `npx storybook@latest init --skip-install --no-dev --yes --type react --builder vite --disable-telemetry --no-features`
- **Files modified:** None (process correction)
- **Commit:** N/A (fix applied before commit)

**2. [Rule 3 - Blocking] npm peer dependency conflict**
- **Found during:** Task 1, npm install
- **Issue:** `eslint-plugin-react-hooks@^7.0.1` in devDependencies conflicts with storybook peer deps requiring an older version. Standard `npm install` fails.
- **Fix:** Used `npm install --legacy-peer-deps` for both `@storybook/addon-themes` install and main `npm install`
- **Files modified:** package-lock.json
- **Commit:** 3dab219c

## Verification Results

All automated checks passed:

- `.storybook/main.ts` exists, contains `@storybook/react-vite`, `addon-themes`, `hmr:`, 6 tauri-apps aliases, `fileURLToPath`
- `.storybook/preview.ts` exists, contains `withThemeByDataAttribute`, both CSS imports, `defaultTheme: 'dark'`, `attributeName: 'data-theme'`
- All 6 mock files exist with correct exports
- `src/stories/` does not exist (scaffold removed)
- `package.json` has `storybook` and `build-storybook` scripts
- `package.json` devDependencies includes `@storybook/react-vite` and `@storybook/addon-themes`
- **1285 vitest tests passed** (90 test files, 3 skipped) — well above the 83+ requirement (QA-03)

## Known Stubs

None — this is infrastructure-only setup. No component rendering, no data sources.

## Self-Check: PASSED
