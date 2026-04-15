# Requirements: TrustTunnel v3.0

**Defined:** 2026-04-13
**Core Value:** Пользователь устанавливает приложение, вставляет ссылку/конфиг и подключается к VPN — без CLI и технической настройки

## v3.0 Requirements

Requirements для milestone v3.0 BigTech Production Redesign. Каждый maps to roadmap phases.

### Design System (DS)

- [ ] **DS-01**: Дизайн-система имеет two-tier архитектуру токенов: primitives (--color-accent-500) + semantic (--color-text-primary) в tokens.css
- [ ] **DS-02**: Все light/dark темы определяются в tokens.css — ноль [data-theme] overrides в index.css
- [ ] **DS-03**: Шкала типографики определена в токенах (--font-size-xs через --font-size-lg, --font-weight-*)
- [ ] **DS-04**: Шкала spacing определена в токенах (--space-1 через --space-10, 4px base)
- [ ] **DS-05**: Z-index шкала определена в токенах (--z-dropdown через --z-titlebar)
- [ ] **DS-06**: Focus ring токен (--focus-ring) используется всеми интерактивными компонентами для :focus-visible
- [ ] **DS-07**: Status semantic токены (--color-status-connected, --color-status-error и т.д.) определены и используются
- [ ] **DS-08**: Glow/shadow токены заменяют hardcoded RGBA из colors.ts
- [x] **DS-09**: colors.ts удалён — все значения мигрированы в CSS custom properties
- [x] **DS-10**: surface.* палитра удалена из tailwind.config.js — Tailwind использует semantic aliases через CSS vars
- [ ] **DS-11**: Новые акцентные цвета для dark и light темы (свежий, современный вид, не generic AI)

### Storybook (SB)

- [ ] **SB-01**: Storybook запускается и рендерит компоненты с полным CSS (tokens.css + index.css)
- [ ] **SB-02**: Tauri API моки через viteFinal resolve aliases — panel-компоненты рендерятся без crash
- [ ] **SB-03**: Theme toggle в тулбаре (dark/light) через @storybook/addon-themes
- [ ] **SB-04**: Каждый primitive компонент из shared/ui/ имеет co-located .stories.tsx с autodocs
- [ ] **SB-05**: Каждая story показывает все состояния: default, hover, focus, active, disabled, error
- [ ] **SB-06**: MDX документация Foundations: Colors, Typography, Spacing, Shadows
- [ ] **SB-07**: Storybook организован по иерархии: Foundations → Primitives → Patterns
- [ ] **SB-08**: HMR работает в Storybook (override inherited vite.config.ts hmr:false)
- [ ] **SB-09**: Scaffold stories (src/stories/) удалены, заменены реальными

### Components (COMP)

- [ ] **COMP-01**: Все 19 existing primitives (shared/ui/) используют только token vars — ноль hardcoded цветов
- [ ] **COMP-02**: Button имеет CVA-варианты (primary, danger, ghost, icon) с размерами (sm, md, lg)
- [ ] **COMP-03**: Badge имеет CVA-варианты (success, warning, danger, neutral, dot)
- [ ] **COMP-04**: Input расширен: clearable prop, helper text, error state через token
- [ ] **COMP-05**: Select заменён кастомным dropdown (не native <select>)
- [ ] **COMP-06**: Modal обновлён: size variants, новый overlay style
- [ ] **COMP-07**: Новый компонент Section + SectionHeader — замена ad-hoc div-паттернов
- [ ] **COMP-08**: Новый компонент FormField — Label + Input + error + helper composition
- [ ] **COMP-09**: Новый компонент StatusBadge — VPN-state-aware (connected/connecting/error/disconnected)
- [ ] **COMP-10**: Новый компонент EmptyState — consistent zero-data display
- [ ] **COMP-11**: Новый компонент Separator — горизонтальный разделитель с optional label
- [ ] **COMP-12**: Новый компонент ProgressBar — для wizard и deploy flows
- [ ] **COMP-13**: ErrorBanner имеет CVA severity variants
- [ ] **COMP-14**: Каждый компонент выдерживает единый стиль inline tokens vs className tokens

### Screens (SCR)

- [ ] **SCR-01**: Control Panel (главный экран) полностью редизайнен с новыми компонентами
- [ ] **SCR-02**: StatusPanel использует StatusBadge и status semantic токены
- [ ] **SCR-03**: Setup Wizard редизайнен (все шаги) с новыми FormField и ProgressBar
- [ ] **SCR-04**: Settings Panel редизайнен с Section компонентами
- [ ] **SCR-05**: Server Panel редизайнен (18 subcomponents)
- [ ] **SCR-06**: Routing Panel редизайнен
- [ ] **SCR-07**: Dashboard Panel редизайнен (или убран если не нужен)
- [ ] **SCR-08**: Log Panel редизайнен
- [ ] **SCR-09**: About Panel редизайнен
- [x] **SCR-10**: Sidebar редизайнен (последний — frames everything)
- [x] **SCR-11**: WindowControls (кастомное окно) редизайнен
- [x] **SCR-12**: Каждый экран имеет Storybook story (static props, Tauri mocked)

### Documentation (DOC)

- [ ] **DOC-01**: memory/v3/design-system/ содержит полную документацию токенов (цвета, типография, spacing, shadows)
- [ ] **DOC-02**: memory/v3/design-system/ содержит документацию каждого компонента (props, варианты, состояния, зависимости)
- [ ] **DOC-03**: memory/v3/screens/ содержит спецификацию поведения каждого экрана
- [ ] **DOC-04**: memory/v3/use-cases/ содержит пользовательские сценарии для каждого экрана
- [ ] **DOC-05**: memory/v3/test-cases/ содержит тест-кейсы (позитивные + негативные) привязанные к экранам и use cases
- [x] **DOC-06**: Документация имеет перекрёстные ссылки: экран → компоненты → use cases → тест-кейсы
- [ ] **DOC-07**: memory/v3/decisions/ фиксирует все решения: что пробовали, что помогло, что нет

### Quality (QA)

- [ ] **QA-01**: Theme flash исправлен — inline script в index.html до React mount
- [x] **QA-02**: vitest-axe установлен и a11y тесты запускаются в CI
- [ ] **QA-03**: Все существующие 83+ behavioral теста продолжают работать после миграции
- [x] **QA-04**: Визуальная миграция коммитов содержит ТОЛЬКО CSS/tokens/className изменения — ноль logic changes
- [x] **QA-05**: Все !important overrides удалены из index.css (к концу milestone)

## Future Requirements (v3.1+)

### Lite Edition

- **LITE-01**: Lite-версия редизайнена с наследованием design-system от Pro
- **LITE-02**: 4 экрана Lite имеют спеки, use cases и тест-кейсы

### Installer

- **INST-01**: Дизайн инсталлятора обновлён в стиле design-system
- **INST-02**: Installer имеет спецификацию и тест-кейсы

### Advanced

- **ADV-01**: CVA variant system для всех компонентов (не только Button/Badge)
- **ADV-02**: Visual regression тесты через Playwright toHaveScreenshot()
- **ADV-03**: Tailwind v4 миграция (после стабилизации design-system)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Tailwind CSS v4 миграция | Высокий риск mid-redesign, нет выгоды — отложено на отдельный milestone |
| CSS-in-JS (styled-components, emotion) | Runtime overhead, конфликт с Tailwind архитектурой |
| CSS Modules | Все 32 компонента используют Tailwind inline — полная переписка |
| shadcn/ui или Radix UI | Конфликт с 32 кастомными компонентами |
| Style Dictionary / Token pipeline | Overkill для solo-developer, прямые CSS vars достаточно |
| Figma token sync | Нет Figma workflow |
| Runtime theme engine / custom palettes | Feature creep, VPN — один бренд, две фиксированных темы |
| Chromatic (платный VRT) | Playwright достаточен для solo dev |
| Lite-версия редизайн | После Pro (наследует design-system) |
| Инсталлятор редизайн | Последний этап, наследует дизайн-систему |
| Мобильная версия | Не планируется |
| Поведенческие изменения VPN/SSH/routing | v3.0 — только визуальный слой, behavior debt фиксится отдельно |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DS-01 | Phase 1 | Pending |
| DS-02 | Phase 1 | Pending |
| DS-03 | Phase 1 | Pending |
| DS-04 | Phase 1 | Pending |
| DS-05 | Phase 1 | Pending |
| DS-06 | Phase 1 | Pending |
| DS-07 | Phase 1 | Pending |
| DS-08 | Phase 1 | Pending |
| DS-09 | Phase 6 | Complete |
| DS-10 | Phase 6 | Complete |
| DS-11 | Phase 1 | Pending |
| SB-01 | Phase 1 | Pending |
| SB-02 | Phase 1 | Pending |
| SB-03 | Phase 1 | Pending |
| SB-04 | Phase 2 | Pending |
| SB-05 | Phase 2 | Pending |
| SB-06 | Phase 1 | Pending |
| SB-07 | Phase 1 | Pending |
| SB-08 | Phase 1 | Pending |
| SB-09 | Phase 1 | Pending |
| COMP-01 | Phase 2 | Pending |
| COMP-02 | Phase 2 | Pending |
| COMP-03 | Phase 2 | Pending |
| COMP-04 | Phase 2 | Pending |
| COMP-05 | Phase 2 | Pending |
| COMP-06 | Phase 2 | Pending |
| COMP-07 | Phase 2 | Pending |
| COMP-08 | Phase 2 | Pending |
| COMP-09 | Phase 2 | Pending |
| COMP-10 | Phase 2 | Pending |
| COMP-11 | Phase 2 | Pending |
| COMP-12 | Phase 2 | Pending |
| COMP-13 | Phase 2 | Pending |
| COMP-14 | Phase 2 | Pending |
| SCR-01 | Phase 3 | Pending |
| SCR-02 | Phase 3 | Pending |
| SCR-03 | Phase 4 | Pending |
| SCR-04 | Phase 4 | Pending |
| SCR-05 | Phase 4 | Pending |
| SCR-06 | Phase 4 | Pending |
| SCR-07 | Phase 4 | Pending |
| SCR-08 | Phase 4 | Pending |
| SCR-09 | Phase 4 | Pending |
| SCR-10 | Phase 5 | Complete |
| SCR-11 | Phase 5 | Complete |
| SCR-12 | Phase 6 | Complete |
| DOC-01 | Phase 1 | Pending |
| DOC-02 | Phase 2 | Pending |
| DOC-03 | Phase 3 | Pending |
| DOC-04 | Phase 4 | Pending |
| DOC-05 | Phase 4 | Pending |
| DOC-06 | Phase 6 | Complete |
| DOC-07 | Phase 1 | Pending |
| QA-01 | Phase 1 | Pending |
| QA-02 | Phase 6 | Complete |
| QA-03 | Phase 1 | Pending |
| QA-04 | Phase 6 | Complete |
| QA-05 | Phase 6 | Complete |

**Coverage:**
- v3.0 requirements: 58 total (DS: 11, SB: 9, COMP: 14, SCR: 12, DOC: 7, QA: 5)
- Mapped to phases: 58
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-13*
*Last updated: 2026-04-13 after roadmap creation*
