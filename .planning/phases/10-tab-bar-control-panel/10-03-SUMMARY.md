---
phase: 10-tab-bar-control-panel
plan: "03"
subsystem: control-panel
tags: [skeleton, credentials-persistence, ux, loading-state]
dependency_graph:
  requires: []
  provides: [skeleton-loading-on-first-connect, credentials-persist-after-disconnect, onPanelReady-callback]
  affects: [ControlPanelPage, ServerPanel, SshConnectForm]
tech_stack:
  added: []
  patterns: [overlay-skeleton, display-none-while-loading, localStorage-persistence, optional-callback-prop]
key_files:
  created: []
  modified:
    - gui-app/src/components/ServerPanel.tsx
    - gui-app/src/components/server/SshConnectForm.tsx
    - gui-app/src/components/ControlPanelPage.tsx
decisions:
  - "Skeleton as overlay + ServerPanel behind display:none — ensures ServerPanel mounts immediately to start SSH calls while skeleton shows as visual placeholder"
  - "onPanelReady is optional prop — existing callers unaffected, zero breaking change"
  - "localStorage keys tt_ssh_last_host/user/port store only non-secret data (hostname, username, port)"
  - "D-16 verified as already fixed — auth-button inactive state correctly uses bg-[var(--color-input-bg)]"
metrics:
  duration: "~7m"
  completed: "2026-04-15T13:29:54Z"
  tasks_completed: 2
  files_modified: 3
---

# Phase 10 Plan 03: Skeleton Loading + Credentials Persistence Summary

**One-liner:** Skeleton overlay during first SSH connect with ServerPanel behind display:none + localStorage-persisted host/user/port restored to form after disconnect.

---

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | ServerPanel onPanelReady + SshConnectForm initial props | e439a561 | ServerPanel.tsx, SshConnectForm.tsx |
| 2 | ControlPanelPage skeleton loading + credentials persist | 75349612 | ControlPanelPage.tsx |

---

## What Was Built

### Task 1 — ServerPanel & SshConnectForm

**ServerPanel.tsx:**
- Added `onPanelReady?: () => void` to `ServerPanelProps` interface
- Added `useEffect` import
- Added `useEffect` that fires `props.onPanelReady()` when `state.panelDataLoaded` becomes `true`
- Existing callers unaffected (optional prop)

**SshConnectForm.tsx:**
- Added `initialHost?`, `initialUser?`, `initialPort?` to Props interface
- Updated function signature to destructure new props
- `useState` initializers use `??` operator: `useState(initialHost ?? "")`, etc.
- Password and keyPath remain always `""` on mount — only non-secret fields pre-fill

**D-16 verification:** Auth-button inactive state already uses `bg-[var(--color-input-bg)]` — no change needed.

### Task 2 — ControlPanelPage

**Skeleton component:**
- `ServerPanelSkeleton` function component added before `ControlPanelPage`
- Structure: header row (address bar + button), 5 tab pill skeletons, content area (card + 3 lines)
- Uses `Skeleton` component from `shared/ui/Skeleton` with `variant="line"` and `variant="card"`

**State additions:**
- `isFirstConnect: boolean` — set to `true` on `handleConnect`, cleared by `onPanelReady`
- `lastHost/lastUser/lastPort: string` — initialized from `localStorage.getItem("tt_ssh_last_*")`

**handleConnect updates:**
- Sets `isFirstConnect(true)` before mounting ServerPanel
- Saves `tt_ssh_last_host`, `tt_ssh_last_user`, `tt_ssh_last_port` to localStorage

**handleDisconnect updates:**
- Sets `isFirstConnect(false)` on disconnect
- Does NOT clear `lastHost/lastUser/lastPort` (D-10 — credentials persist)

**Render:**
- `SshConnectForm` receives `initialHost={lastHost}`, `initialUser={lastUser}`, `initialPort={lastPort}`
- When `creds` exists: skeleton renders when `isFirstConnect=true`, ServerPanel is always mounted but `display:none` while skeleton shows
- `onPanelReady={() => setIsFirstConnect(false)}` triggers skeleton dismissal when `panelDataLoaded` fires in `useServerState`

---

## Test Results

All 57 tests pass across 3 test files:
- `ServerPanel.test.tsx` — 20 tests pass
- `SshConnectForm.test.tsx` — 20 tests pass
- `ControlPanelPage.test.tsx` — 17 tests pass

---

## Deviations from Plan

None — plan executed exactly as written.

---

## Known Stubs

None — no placeholder data or hardcoded empty values introduced.

---

## Threat Surface Scan

No new network endpoints, auth paths, or trust boundary changes introduced. localStorage usage is scoped to non-secret data (hostname, username, port) as documented in threat model T-10-05/T-10-06.

---

## Self-Check: PASSED

- FOUND: gui-app/src/components/ControlPanelPage.tsx
- FOUND: gui-app/src/components/ServerPanel.tsx
- FOUND: gui-app/src/components/server/SshConnectForm.tsx
- FOUND: .planning/phases/10-tab-bar-control-panel/10-03-SUMMARY.md
- FOUND commit: e439a561 (Task 1)
- FOUND commit: 75349612 (Task 2)
