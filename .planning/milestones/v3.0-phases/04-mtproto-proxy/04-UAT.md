---
status: complete
phase: 04-mtproto-proxy
source: [04-01-SUMMARY.md, 04-02-SUMMARY.md, 04-03-SUMMARY.md, 04-04-SUMMARY.md, 04-05-SUMMARY.md, 04-06-SUMMARY.md]
started: 2026-04-14T22:58:00.000Z
updated: 2026-04-14T23:15:00.000Z
---

## Current Test

[testing complete]

## Tests

### 1. TitleBar branding and drag region
expected: Top of window shows compact bar (32px) with Shield icon + "TrustTunnel" + PRO badge. Dragging the title bar moves the window. Background is seamless (no separate color).
result: pass

### 2. Bottom tab navigation — all 5 tabs visible
expected: Bottom of window shows 5 tabs: Панель управления, Подключение, Маршрутизация, Настройки, О программе. Each has an icon + label. All tabs are clickable regardless of config state.
result: pass

### 3. Active tab indicator and hover effect
expected: Active tab has elevated background pill (120x44px) with accent color icon/text. Hovering inactive tabs shows same-size background pill. All hover pills are identical in size.
result: issue
reported: "Кликабельная область больше, чем ховер эффект. Кликабельная область должна быть равна ширине ховер эффекта."
severity: cosmetic
fix: 622d03fa — outer button→div, inner pill is now the button

### 4. WindowControls — minimize, maximize, close
expected: Three buttons in top-right corner: minimize, maximize, close. Buttons are rounded squares. Close button turns red on hover. All three function correctly.
result: pass

### 5. Startup tab logic
expected: First launch (no config): opens on "Панель управления" tab. With saved config: opens on "Подключение" tab. No tab restore from previous session.
result: pass

### 6. Keyboard shortcuts — Ctrl+1..5
expected: Ctrl+1..5 switches to corresponding tab.
result: pass

### 7. Seamless background design
expected: Entire window has one uniform background color — no visible seams between components.
result: pass
note: User also requested hiding ServerSidebar when no servers exist (logged in todo_control_panel_ux.md)

### 8. ServerSidebar — server list and status dots
expected: On control tab, left sidebar shows server list with color-coded status dots.
result: issue
reported: "Status dot всегда зелёный, не отражает реальный статус VPN/протокола. Бесполезна при одном сервере. Кнопка 'Добавить сервер' разрывает активное подключение."
severity: cosmetic
note: Logged in todo_sidebar_status_dots.md + todo_control_panel_ux.md for multi-server phase

### 9. Dark/Light theme switching
expected: All shell components correctly switch between dark and light themes.
result: pass

### 10. Connection tab — EmptyState when no config
expected: Without VPN config, Connection tab shows centered EmptyState placeholder.
result: issue
reported: "EmptyState прижат к верху, а должен быть по центру."
severity: cosmetic
fix: 552ea74c — added flex-1 to center EmptyState

### 11. Control tab — no SetupWizard
expected: Control tab always shows ControlPanelPage. SetupWizard "Welcome" screen no longer appears.
result: pass

### 12. Storybook — shell component stories
expected: Storybook shows stories for TitleBar, TabNavigation, WindowControls, ServerSidebar, AppShell.
result: pass
note: User reminded about ServerSidebar visual softness (already in todo_visual_softness.md)

## Summary

total: 12
passed: 9
issues: 3
pending: 0
skipped: 0

## Gaps

- truth: "Click area should equal hover pill size"
  status: fixed
  reason: "User reported: clickable area wider than hover effect"
  severity: cosmetic
  test: 3
  fix_commit: 622d03fa

- truth: "Status dots should reflect real server state"
  status: deferred
  reason: "User reported: dots always green, meaningless with one server, add-server breaks active connection"
  severity: cosmetic
  test: 8
  deferred_to: todo_sidebar_status_dots.md, todo_control_panel_ux.md

- truth: "EmptyState should be vertically centered"
  status: fixed
  reason: "User reported: EmptyState top-aligned instead of centered"
  severity: cosmetic
  test: 10
  fix_commit: 552ea74c
