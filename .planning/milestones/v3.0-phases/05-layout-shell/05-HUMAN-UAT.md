---
status: partial
phase: 05-layout-shell
source: [05-VERIFICATION.md]
started: 2026-04-15T02:15:00Z
updated: 2026-04-15T02:15:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Visual seamlessness — no visible borders between shell components
expected: No visible borders between TitleBar, content area, TabBar. Separation only through spacing and background differences. Both light and dark themes.
result: [pending]

### 2. Roving focus in browser — arrow keys navigate between tabs
expected: ArrowLeft/ArrowRight/Home/End keys navigate between tab buttons in TabNavigation. Focus ring visible on focused tab.
result: [pending]

### 3. State preservation — ServerTabs state survives tab switch
expected: Switch between top-level tabs (e.g., Control Panel → Settings → Control Panel). ServerTabs content should retain state (scroll position, form inputs) without remounting.
result: [pending]

### 4. Add Server VPN safety (D-10) — button does not disconnect active VPN
expected: When VPN is connected, clicking "Add Server" button does NOT disconnect the active connection. Requires Tauri runtime.
result: [pending]

## Summary

total: 4
passed: 0
issues: 0
pending: 4
skipped: 0
blocked: 0

## Gaps
