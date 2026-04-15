# Phase 3: Control Panel - Context

**Gathered:** 2026-04-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 3 полностью переделывает Control Panel и StatusPanel на новую дизайн-систему Phase 1-2 — proof-of-concept что токены + компоненты работают на реальном экране. Полный визуальный редизайн, не swap токенов.

Скоуп:
- ControlPanelPage.tsx — обёртка, header, управление состояниями
- SshConnectForm.tsx — форма SSH-подключения (точка входа, первое что видит пользователь)
- StatusPanel.tsx — отображение VPN-статуса с новым StatusBadge
- Storybook stories для всех мигрированных компонентов
- memory/v3/screens/ — полная поведенческая спецификация Control Panel

НЕ входит: ServerPanel и его 13+ секций (SCR-05, Phase 4), Sidebar (Phase 5)

</domain>

<decisions>
## Implementation Decisions

### Границы редизайна
- **D-01:** SshConnectForm включена в Phase 3 — это точка входа Control Panel, первое что видит пользователь
- **D-02:** Полный визуальный редизайн всего в скоупе — не swap токенов, а по-настоящему новый вид. "Всё нужно изменить, чтобы выглядело по-новому и свежо"
- **D-03:** ServerPanel (13+ секций) остаётся в Phase 4 — Phase 3 мигрирует только обёртку ControlPanelPage

### StatusPanel
- **D-04:** StatusPanel формат (strip vs expanded block) — Claude's discretion, в рамках сдержанной элегантности
- **D-05:** Заменить legacy Badge на StatusBadge (Phase 2) для отображения VPN-состояний
- **D-06:** 6 VPN-состояний: connected, connecting, disconnecting, recovering, error, disconnected

### Отображение ошибок
- **D-07:** Комбо-подход: SnackBar для коротких уведомлений/success (auto-dismiss) + ErrorBanner для длинных/критичных ошибок (dismiss вручную, expandable)
- **D-08:** Никакого inline для ошибок — всё через SnackBar или ErrorBanner. Стильно и в тему

### Визуальная структура
- **D-09:** SshConnectForm layout — Claude's discretion (Card по центру как login-экран Linear/Raycast или full-screen)
- **D-10:** Header — полный редизайн: bg, border, spacing из tokens.css, новый Button(ghost), свежий вид

### Storybook и документация
- **D-11:** Storybook stories strategy — Claude's discretion (компоненты отдельно vs полная страница)
- **D-12:** Поведенческая спецификация — полная: все состояния, переходы, крайние случаи, ссылки на компоненты. Задаёт шаблон для Phase 4

### Claude's Discretion
- StatusPanel визуальный формат (strip vs expanded)
- SshConnectForm layout (Card centered vs full-screen vs other)
- Storybook stories стратегия (component-level vs page-level)
- Конкретные spacing, размеры, анимации — в рамках token-системы Phase 1
- Реализация переходов между состояниями (no creds → connected)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 1-2 Design Decisions (locked)
- `.planning/phases/01-infrastructure-release-setup/01-CONTEXT.md` — D-01 to D-13: visual direction, restrained elegance, near-monochrome, Linear/Raycast reference, no glow
- `.planning/phases/02-ssh-port-change-core-engine/02-CONTEXT.md` — D-01 to D-19: CVA + Tailwind, full redesign approach, shadcn/ui reference, component conventions

### Design System Foundation
- `gui-app/src/shared/styles/tokens.css` — Two-tier token system (primitives + semantics), slate-teal accent
- `gui-app/src/shared/styles/fonts/` — Geist Sans + Geist Mono
- `gui-app/src/index.css` — Global styles, animations, scrollbars

### Design Philosophy
- `memory/decisions/v3-philosophy.md` — Contract-first development process
- `memory/decisions/v3-design-guidelines.md` — Visual direction, anti-patterns

### Source Code (current state to transform)
- `gui-app/src/components/ControlPanelPage.tsx` — Main page: SSH creds state → SshConnectForm or header + ServerPanel
- `gui-app/src/components/StatusPanel.tsx` — VPN status strip: Badge + Button + uptime counter
- `gui-app/src/components/server/SshConnectForm.tsx` — SSH form with password/key modes, legacy colors import
- `gui-app/src/components/ServerPanel.tsx` — Orchestrator for 13+ sections (Phase 4 — NOT in scope)

### Phase 2 Components (available for use)
- `gui-app/src/shared/ui/StatusBadge.tsx` — VPN-state-aware badge (connected/connecting/error/disconnected)
- `gui-app/src/shared/ui/FormField.tsx` — Label + Input + error + helper composition
- `gui-app/src/shared/ui/Card.tsx` — Card container with variants
- `gui-app/src/shared/ui/Section.tsx` — Content grouping with header
- `gui-app/src/shared/ui/EmptyState.tsx` — Zero-data placeholder
- `gui-app/src/shared/ui/ErrorBanner.tsx` — CVA severity error display
- `gui-app/src/shared/ui/SnackBar.tsx` — Toast notifications
- `gui-app/src/shared/ui/Button.tsx` — CVA variants (primary, danger, ghost, icon, success, warning)
- `gui-app/src/shared/ui/Input.tsx` — Redesigned input with clearable, helper, error
- `gui-app/src/shared/ui/PasswordInput.tsx` — Password input with toggle visibility
- `gui-app/src/shared/ui/Separator.tsx` — Visual divider

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- 25 redesigned primitives in `shared/ui/` — all CVA + token-based from Phase 2
- `StatusBadge` — specifically designed for VPN states, replaces legacy Badge usage in StatusPanel
- `FormField` — wraps Input + label + error, ideal for SshConnectForm redesign
- `Card` — container component, potential for SshConnectForm layout
- `ErrorBanner` — severity-based error display, replaces inline error text
- `SnackBar` + `SnackBarProvider` — toast system for short notifications

### Established Patterns
- CVA + Tailwind for all component styling (Phase 2 standard)
- All colors via CSS custom properties from tokens.css (zero hardcoded hex)
- `cn()` utility for merging Tailwind classes
- `useTranslation()` hook for i18n (ru/en)
- Tauri `invoke()` for backend communication

### Integration Points
- `ControlPanelPage` receives props from `App.tsx`: onConfigExported, onSwitchToSetup, onNavigateToSettings
- `StatusPanel` receives VPN state from parent via props (not direct Tauri calls)
- `SshConnectForm` calls Tauri invoke for SSH connection test
- `SnackBarProvider` wraps the app — SnackBar available via `useSnackBar()` hook
- ServerPanel embedded in ControlPanelPage — must remain functional during migration (Phase 4 will redesign internals)

### Legacy to Remove
- `colors` import in SshConnectForm.tsx and ServerPanel.tsx — replace with token vars
- Hardcoded `style={{ height: 52 }}` and `style={{ height: 51 }}` — replace with token-based sizing
- Inline `style={{ backgroundColor: "var(--color-bg-primary)" }}` patterns — migrate to Tailwind + tokens
- `text-[11px]` and similar arbitrary Tailwind values — replace with typography tokens

</code_context>

<specifics>
## Specific Ideas

- Пользователь хочет полный визуальный редизайн: "Всё нужно изменить, чтобы это выглядело по-новому и свежо"
- Никакого inline для ошибок — всё через SnackBar или ErrorBanner
- SnackBar для success/notifications, ErrorBanner для длинных критичных ошибок
- Control Panel — proof-of-concept дизайн-системы на реальном экране
- Поведенческая спека задаёт шаблон для всех экранов Phase 4

</specifics>

<deferred>
## Deferred Ideas

- **Мульти-серверность** — хранение нескольких серверов в БД, переключение без повторного ввода кредов, чекбокс "сохранить данные". Новая функциональность, требует backend + UI + хранилище → отдельная фаза/milestone

</deferred>

---

*Phase: 03-ssh-port-change-integration*
*Context gathered: 2026-04-14*
