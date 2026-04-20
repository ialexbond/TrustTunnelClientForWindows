---
phase: 05-layout-shell
verified: 2026-04-15T00:00:00Z
status: human_needed
score: 11/11
overrides_applied: 0
human_verification:
  - test: "Запустить приложение, открыть Control Panel — убедиться что нет визуальных границ (1px borders) между TitleBar, TabBar, content area"
    expected: "Бесшовное разделение блоков через bg-secondary и spacing, без видимых линий"
    why_human: "Визуальное качество нельзя проверить программно"
  - test: "Открыть вкладку Control Panel — убедиться в фокусе клавишами Tab/Arrow между табами"
    expected: "ArrowRight/Left переключают фокус между 5 вкладками циклически, Home/End — первая/последняя"
    why_human: "Интерактивное поведение клавиатуры требует ручного тестирования"
  - test: "Переключить между вкладками ServerTabs (Status/Users/Config/Security/Tools/Danger) — проверить что состояние сохраняется"
    expected: "Поля ввода, значения не сбрасываются при возврате на вкладку — display:none caching работает"
    why_human: "Сохранение состояния компонентов нельзя проверить статическим анализом"
  - test: "При наличии активного VPN-подключения нажать кнопку 'Добавить сервер'"
    expected: "Форма добавления сервера появляется, VPN-соединение НЕ разрывается"
    why_human: "Требует активного Tauri runtime и реального VPN-подключения для верификации D-10"
---

# Phase 5: Shell Polish + TODO Closure — Verification Report

**Phase Goal:** Визуальная полировка shell: убрать границы, добавить bg-secondary разделение sidebar, исправить max-width и roving focus табов, скрыть sidebar при 1 сервере с анимацией, убрать status dots, исправить CVA варианты, добавить i18n в StatusBadge/Select/EmptyState, верифицировать sanitize(), Fix Add Server VPN safety (D-10). WindowControls/TitleBar подтверждены как есть (D-07, SCR-11).
**Verified:** 2026-04-15T00:00:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Нет 1px border между TitleBar, content area, TabBar, sidebar | ✓ VERIFIED | TabNavigation.tsx: нет `borderTop`, ServerSidebar.tsx: нет `border-r/border-b/border-t`, ControlPanelPage.tsx: нет `border-[var(--color-border)]` на header, ServerTabs.tsx: нет `border-b border-[var(--color-border)]` на таббаре |
| 2 | ServerSidebar использует --color-bg-secondary для визуального разделения без border | ✓ VERIFIED | ServerSidebar.tsx строка 28: `style={{ width: 220, backgroundColor: "var(--color-bg-secondary)" }}` |
| 3 | Tab group центрирован и ограничен max-width 640px на широких окнах | ✓ VERIFIED | TabNavigation.tsx строка 61: `<div className="flex items-center w-full" style={{ maxWidth: 640 }}>` + `justify-center` на nav |
| 4 | Клавиши-стрелки навигируют между табами по WAI-ARIA tablist паттерну | ✓ VERIFIED | TabNavigation.tsx строки 34-51: `handleKeyDown` с `ArrowRight/ArrowLeft/Home/End`, `tabIndex={active ? 0 : -1}` |
| 5 | ServerSidebar скрыт при 1 сервере, показывается при 2+ | ✓ VERIFIED | ControlPanelPage.tsx строка 137: `const sidebarVisible = servers.length >= 2;` + animated wrapper |
| 6 | ServerSidebar анимируется появление/скрытие через CSS transition на width/opacity | ✓ VERIFIED | ControlPanelPage.tsx строки 143-151: асимметричный transition (appear: --transition-normal, disappear: --transition-fast) |
| 7 | Status dots удалены из ServerSidebar | ✓ VERIFIED | ServerSidebar.tsx: нет `statusDotStyle`, нет `w-2 h-2 rounded-full`, нет status dot элемента |
| 8 | Кнопка disconnect видима для keyboard-пользователей через group-focus-within | ✓ VERIFIED | ServerSidebar.tsx строка 69: `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100` |
| 9 | Нет невалидных CVA вариантов (secondary/success на Button, default/accent на Badge) в server/ | ✓ VERIFIED | grep: 0 совпадений `variant="secondary"`, 0 `variant="default"`, 0 `variant="accent"` в server/ |
| 10 | StatusBadge/Select/EmptyState используют i18n t() без hardcoded Russian строк | ✓ VERIFIED | StatusBadge.tsx: `useTranslation`, `t(\`status.${resolvedVariant}\`)`, нет `defaultLabels`; Select.tsx: `t("select.placeholder")`; EmptyState.tsx: `t("empty.heading")`, `t("empty.body")` |
| 11 | sanitize() маскирует все вхождения чувствительных ключей (D-18) | ✓ VERIFIED | logging.rs строки 41-54: `loop + search_from` паттерн; тест `sanitize_replaces_all_occurrences` строка 280 присутствует |

**Score: 11/11 truths verified**

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `gui-pro/src/components/layout/TabNavigation.tsx` | Border-free tab bar, max-width 640, roving focus | ✓ VERIFIED | Содержит `onKeyDown`, `ArrowRight/ArrowLeft`, `maxWidth: 640`, `justify-center`, нет `borderTop` |
| `gui-pro/src/components/ServerSidebar.tsx` | Border-free, bg-secondary, no status dots, a11y disconnect | ✓ VERIFIED | `backgroundColor: "var(--color-bg-secondary)"`, `width: 220`, `group-focus-within:opacity-100`, нет `border-r/border-b` |
| `gui-pro/src/components/ServerTabs.tsx` | display:none tab caching | ✓ VERIFIED | Строки 74,80,86,93,100,106: `display: activeTab === "..." ? "flex" : "none"`, outer wrapper `flex-1 min-h-0 overflow-hidden` |
| `gui-pro/src/components/ControlPanelPage.tsx` | Sidebar animation wrapper, safe onAddServer | ✓ VERIFIED | `sidebarVisible = servers.length >= 2`, animated div, `onAddServer` только `setRefreshKey` — нет `handleDisconnect` |
| `gui-pro/src/components/server/Fail2banSection.tsx` | variant="ghost" | ✓ VERIFIED | Нет `variant="secondary"` |
| `gui-pro/src/components/server/CertSection.tsx` | variant="neutral" | ✓ VERIFIED | Нет `variant="default"` или `variant="accent"` |
| `gui-pro/src/components/server/ServerStatusSection.tsx` | variant="ghost" и variant="primary" | ✓ VERIFIED | Нет `variant="secondary"` или `variant="success"` на Button |
| `gui-pro/src/components/server/VersionSection.tsx` | variant="neutral" (было "accent") | ✓ VERIFIED | Нет `variant="accent"` |
| `gui-pro/src/components/server/UsersSection.tsx` | variant="primary" | ✓ VERIFIED | Нет `variant="success"` на Button |
| `gui-pro/src/shared/ui/StatusBadge.tsx` | useTranslation, нет defaultLabels | ✓ VERIFIED | `import { useTranslation }`, `const { t } = useTranslation()`, `displayLabel = label ?? t(...)` |
| `gui-pro/src/shared/ui/Select.tsx` | useTranslation, нет hardcoded placeholder | ✓ VERIFIED | `const resolvedPlaceholder = placeholder ?? t("select.placeholder", ...)` |
| `gui-pro/src/shared/ui/EmptyState.tsx` | useTranslation, нет hardcoded defaults | ✓ VERIFIED | `resolvedHeading = heading ?? t("empty.heading", ...)` |
| `gui-pro/src/shared/i18n/locales/ru.json` | Ключи select.placeholder, empty.heading, empty.body | ✓ VERIFIED | Строки 1035-1041: `"select": { "placeholder": "Выберите..." }`, `"empty": { "heading": ..., "body": ... }` |
| `gui-pro/src/shared/i18n/locales/en.json` | Ключи select.placeholder, empty.heading, empty.body | ✓ VERIFIED | Строки 1035-1041: `"select": { "placeholder": "Select..." }`, `"empty": { "heading": "Nothing here", "body": ... }` |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| ControlPanelPage.tsx | ServerSidebar.tsx | sidebar animation wrapper с `servers.length >= 2` | ✓ WIRED | `sidebarVisible = servers.length >= 2`, div wrapper управляет width/opacity |
| TabNavigation.tsx | WAI-ARIA tablist | `onKeyDown` с ArrowLeft/Right/Home/End | ✓ WIRED | `handleKeyDown` строки 34-51, `ref={navRef}`, `onKeyDown={handleKeyDown}` |
| ControlPanelPage.tsx onAddServer | ServerSidebar.tsx | onAddServer callback — НЕ вызывает handleDisconnect | ✓ WIRED | строки 157-159: `onAddServer={() => { setRefreshKey(k => k + 1); }}` — только refreshKey, без disconnect |
| server/*.tsx | Button.tsx | CVA variant prop (primary/danger/ghost/icon) | ✓ WIRED | 0 вхождений `variant="secondary"` в server/ |
| server/*.tsx | Badge.tsx | CVA variant prop (success/warning/danger/neutral/dot) | ✓ WIRED | 0 вхождений `variant="default"` или `variant="accent"` в server/ |
| StatusBadge.tsx | ru.json | `t("status.connected")` и т.д. | ✓ WIRED | Ключи status.* существовали в ru.json |
| Select.tsx | ru.json | `t("select.placeholder")` | ✓ WIRED | ru.json строка 1036: `"placeholder": "Выберите..."` |

---

### Data-Flow Trace (Level 4)

Не применимо для этой фазы — все изменения визуально-стилевые (borders, backgrounds, CVA variants). Компоненты не изменяли источники данных.

---

### Behavioral Spot-Checks

| Behavior | Команда | Результат | Status |
|----------|---------|-----------|--------|
| TypeScript ошибок не добавлено Phase 5 | `tsc --noEmit` до vs после | до Phase 5: 112 ошибок, после Phase 5: 106 ошибок (-6) | ✓ PASS — Phase 5 улучшила TS |
| sanitize() loop+search_from паттерн существует | `grep "loop\|search_from" logging.rs` | строки 42,53: loop + search_from = 3 | ✓ PASS |
| ServerSidebar не содержит border классы | grep border | нет `border-r`, `border-b`, `border-t`, нет `color-border` | ✓ PASS |
| onAddServer не вызывает handleDisconnect | grep onAddServer | `setRefreshKey(k => k + 1)` — единственный вызов | ✓ PASS |

**Примечание:** 106 pre-existing TypeScript ошибок (Property 'icon' does not exist on ButtonProps, size prop на Badge, danger-outline в DangerZoneSection и MtProtoSection) существовали до Phase 5 и задокументированы в SUMMARY-02 как "Pre-existing Issues (Out of Scope)". Phase 5 не вводит новых TS-ошибок.

---

### Requirements Coverage

| Requirement | Источник | Описание | Status | Доказательство |
|-------------|----------|----------|--------|----------------|
| SCR-10 | 05-01-PLAN, 05-02-PLAN, 05-03-PLAN | Sidebar редизайнен | ✓ SATISFIED | ServerSidebar borderless, bg-secondary, no status dots, animation, i18n; CVA variants исправлены в 8 server components; i18n StatusBadge/Select/EmptyState |
| SCR-11 | 05-01-PLAN | WindowControls (кастомное окно) редизайнен | ✓ SATISFIED | D-07 confirmed as-is — TitleBar.tsx и WindowControls.tsx не изменялись в Phase 5 (git log подтверждает последнее изменение — Phase 4). SCR-11 закрыт подтверждением что изменения не требуются |

**Проверка на orphaned requirements:** REQUIREMENTS.md строки 168-169 фиксируют SCR-10 и SCR-11 как Phase 5, status: Complete. Других требований для Phase 5 нет.

---

### Anti-Patterns Found

| Файл | Строка | Паттерн | Серьёзность | Влияние |
|------|--------|---------|-------------|---------|
| `gui-pro/src/components/server/DangerZoneSection.tsx` | 84 | `variant="danger-outline"` | ⚠️ Warning | Pre-existing; вне scope Phase 5; требует исправления в Phase 6 |
| `gui-pro/src/components/server/MtProtoSection.tsx` | 116 | `variant="danger-outline"` | ⚠️ Warning | Pre-existing; вне scope Phase 5; требует исправления в Phase 6 |

**Блокеров нет.** Обе проблемы — pre-existing, задокументированы в SUMMARY-02 как "Out of Scope".

---

### Human Verification Required

#### 1. Бесшовность визуального дизайна (D-01, D-02)

**Test:** Запустить приложение, открыть Control Panel — убедиться что нет видимых 1px borders между TitleBar, content area, TabBar, sidebar
**Expected:** Бесшовное разделение блоков через bg-secondary и spacing, без видимых линий
**Why human:** Визуальное качество (контраст, ощущение "seamless") нельзя проверить программно

#### 2. Roving focus в TabNavigation (D-06)

**Test:** Нажать Tab для фокуса на активный таб, затем ArrowRight/Left для переключения фокуса. Попробовать Home/End.
**Expected:** ArrowRight перемещает фокус на следующий таб циклически (после последнего — первый). ArrowLeft — назад. Home — первый. End — последний. Enter/Space активирует таб.
**Why human:** Интерактивное поведение клавиатуры требует ручного тестирования в браузере

#### 3. display:none state preservation в ServerTabs (D-13, D-14)

**Test:** Подключиться к серверу, открыть вкладку Users — ввести что-нибудь в поле поиска. Переключиться на Config, вернуться на Users.
**Expected:** Введённый текст в поле поиска сохранился. Компонент не перемонтировался.
**Why human:** Сохранение состояния требует интерактивного тестирования

#### 4. Add Server VPN safety (D-10)

**Test:** При активном VPN-подключении нажать "Добавить сервер" в ServerSidebar (виден при 2+ серверах — может потребовать тестовой конфигурации с мокованными данными)
**Expected:** Форма добавления сервера показывается, VPN НЕ разрывается (логи не показывают disconnect)
**Why human:** Требует реального Tauri runtime или тестовой среды с мокованным VPN состоянием

---

### Gaps Summary

Все 11 must-have truths верифицированы. Gaps не обнаружено.

Pre-existing issues (не блокируют phase goal):
- 106 TypeScript ошибок (pre-existing, Phase 5 убрала 6 из них)
- `variant="danger-outline"` в DangerZoneSection.tsx и MtProtoSection.tsx (вне scope Phase 5)

---

_Verified: 2026-04-15T00:00:00Z_
_Verifier: Claude (gsd-verifier)_
