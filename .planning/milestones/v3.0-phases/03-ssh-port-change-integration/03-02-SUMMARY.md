---
phase: 03-ssh-port-change-integration
plan: 02
subsystem: frontend
tags: [ssh-port, auto-reconnect, reset-button, i18n, tests]
dependency_graph:
  requires: [03-01]
  provides: [frontend-port-change-flow, reset-button, port-change-i18n]
  affects: [ControlPanelPage, ServerPanel, useServerState, SecuritySection, useSecurityState, SshPortSection]
tech_stack:
  added: []
  patterns: [callback-chain, useEffect-dependency-reload, custom-invoke-flow]
key_files:
  created:
    - gui-app/src/components/server/SshPortSection.test.tsx
  modified:
    - gui-app/src/components/server/useSecurityState.ts
    - gui-app/src/components/server/useSecurityState.test.ts
    - gui-app/src/components/server/SshPortSection.tsx
    - gui-app/src/components/server/SecuritySection.tsx
    - gui-app/src/components/server/useServerState.ts
    - gui-app/src/components/ServerPanel.tsx
    - gui-app/src/components/ControlPanelPage.tsx
    - gui-app/src/shared/i18n/locales/ru.json
    - gui-app/src/shared/i18n/locales/en.json
decisions:
  - Custom changeSshPort flow instead of generic run() to avoid stale sshParams in load()
  - Rely on useEffect dependency chain for auto-reload instead of direct load() call
metrics:
  duration: 8m
  completed: 2026-04-12
  tasks: 3
  files: 10
---

# Phase 03 Plan 02: SSH Port Change Frontend Integration Summary

Frontend auto-reconnect flow after SSH port change via onPortChanged callback chain, Reset button with confirmation dialog, i18n keys for both languages, and comprehensive test coverage for PORT-05/06/07.

## Task Summary

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 0 | Test scaffolds for SshPortSection and extended useSecurityState tests | 949d0a1e | SshPortSection.test.tsx, useSecurityState.test.ts |
| 1 | onPortChanged callback chain and custom changeSshPort flow | 82efe91a | ControlPanelPage.tsx, ServerPanel.tsx, useServerState.ts, SecuritySection.tsx, useSecurityState.ts |
| 2 | Reset button and i18n keys | 3ba3e1d7 | SshPortSection.tsx, SshPortSection.test.tsx, ru.json, en.json |

## What Was Built

### PORT-05: Auto-reconnect after port change
- `handlePortChanged` callback in ControlPanelPage updates `creds.port` and persists via `invoke("save_ssh_credentials")`
- Callback threaded through: ControlPanelPage -> ServerPanel -> useServerState -> SecuritySection -> useSecurityState
- `changeSshPort` in useSecurityState uses custom flow (not generic `run()`) that calls `onPortChanged?.(actualPort)` after success
- Auto-reload happens via useEffect dependency chain: creds.port changes -> sshParams reconstructed -> load useCallback updates -> useEffect fires load() with new port

### PORT-06: Current port display
- Already implemented in Phase 2; confirmed working via test coverage in SshPortSection.test.tsx

### PORT-07: Reset button
- Reset button with RotateCcw icon in SshPortSection, visible only when `currentPort !== 22 && state.status !== null`
- Triggers ConfirmDialog via `state.setConfirm()` with warning variant
- On confirm: calls `state.changeSshPort(22)` which uses the same safe backend flow

### i18n Keys Added
- `ssh_port.reset`: "Reset to 22" / "Сбросить на 22"
- `confirm.reset_port_title`: "Reset SSH Port" / "Сброс SSH порта"
- `confirm.reset_port_message`: Full explanation in both languages
- `snack.port_reset`: "SSH port reset to 22" / "SSH порт сброшен на 22"

## Test Coverage

- **SshPortSection.test.tsx** (new, 5 tests): port display, reset visibility (3 cases), reset action via confirm
- **useSecurityState.test.ts** (3 new tests): onPortChanged callback invoked, useEffect reload on port change, no direct load() call after changeSshPort
- **Total**: 1285 tests passing across 90 test files

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed SshPortSection test mock for i18n t() function**
- **Found during:** Task 2 verification
- **Issue:** The passthrough `t` mock returned only the key string without interpolating params, causing PORT-06 test to fail (couldn't find "2222" in rendered output)
- **Fix:** Enhanced mock to append param values to key: `t("key", {port: 2222})` returns `"key [2222]"`
- **Files modified:** SshPortSection.test.tsx
- **Commit:** 3ba3e1d7

## Known Stubs

None -- all data paths are wired end-to-end.

## Decisions Made

1. **Custom changeSshPort flow vs generic run()**: The generic `run()` helper calls `load()` immediately after success, but `load()` would use stale `sshParams` (React state hasn't updated yet). Custom flow calls `onPortChanged` which triggers parent state update, which reconstructs sshParams, which triggers useEffect auto-reload.

2. **useEffect dependency chain for auto-reload**: Instead of directly calling `load()` after port change (which would use old port), rely on the existing `useEffect(() => { void load(); }, [load])` which fires when `load` changes due to its dependency on `port` via `useCallback`.
