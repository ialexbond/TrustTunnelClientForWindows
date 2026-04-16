# Roadmap: TrustTunnel

## Milestones

- ✅ **v3.0 BigTech Production Redesign** — Phases 1-6 (shipped 2026-04-15) → [archive](milestones/v3.0-ROADMAP.md)
- 🚧 **v3.1 Stabilization & UX Redesign** — Phases 8-11 (in progress)

## Phases

<details>
<summary>✅ v3.0 BigTech Production Redesign (Phases 1-6) — SHIPPED 2026-04-15</summary>

- [x] Phase 1: Foundation (5/5 plans) — Token consolidation + Storybook infrastructure
- [x] Phase 2: Primitive Redesign (7/7 plans) — 25 shared/ui components with CVA + Storybook
- [x] Phase 3: Control Panel (3/3 plans) — First screen migration, design system proof
- [x] Phase 4: Remaining Panels (6/6 plans) — All screens migrated to design system
- [x] Phase 5: Layout Shell (3/3 plans) — Shell polish, sidebar UX, bug fixes
- [x] Phase 6: Cleanup (3/3 plans) — Legacy artifacts removed, quality gates passed

**Audit:** tech_debt (53/58 requirements satisfied, 5 partial doc gaps deferred)

</details>

### 🚧 v3.1 Stabilization & UX Redesign (In Progress)

**Milestone Goal:** Стабилизировать кодовую базу v3.0 (тесты, баги, a11y, design-system), добавить 4 новых компонента и провести поэкранный UX-редизайн Pro-версии.

- [x] **Phase 8: Stabilization** — Зелёный CI, баги закрыты, документация экранов написана (completed 2026-04-15)
- [x] **Phase 9: New Components** — 4 новых shared/ui компонента с Storybook stories (completed 2026-04-15)
- [ ] **Phase 10: Tab Bar & Control Panel** — Pill-индикатор, Skeleton loading, ServerTabs 5 вкладок
- [ ] **Phase 11: Screen UX Redesign** — Редизайн серверной панели: 5→4 таба, OverflowMenu, accent fix, focus rings

## Phase Details

### Phase 8: Stabilization
**Goal**: Кодовая база v3.1 готова к разработке — CI зелёный, все баги закрыты, design-system чистый, документация актуальна
**Depends on**: Phase 6 (v3.0 завершён)
**Requirements**: STAB-01, STAB-02, STAB-03, STAB-04, STAB-05, STAB-06, STAB-07, STAB-08, STAB-09, STAB-10, STAB-11, STAB-12
**Success Criteria** (what must be TRUE):
  1. Все 19 ранее падавших тестов проходят, `npm test` возвращает 0 failures
  2. Кнопки серверных секций работают, состояние вкладок сохраняется при переключении, статус не мигает лишний раз
  3. Disconnect-кнопка доступна с клавиатуры (Tab + Enter/Space)
  4. В компонентах design-system нет хардкоженых строк — всё через i18n-ключи; цвета sidebar идут через CSS-токены
  5. Для каждого экрана Pro-версии написана screen spec в memory/v3/screens/
**Plans:** 6/6 plans complete
Plans:
- [x] 08-01-PLAN.md — Test infrastructure: RAF mock, Section aria-hidden, Button CVA fix
- [x] 08-02-PLAN.md — ConfirmDialog i18n: replace hardcoded defaults with t()
- [x] 08-03-PLAN.md — Fix remaining 14 failing tests (ConfigPanel, ControlPanelPage, SshConnectForm, FoundStep, ProcessFilterSection)
- [x] 08-04-PLAN.md — i18n audit: remove hardcoded fallbacks from EmptyState, Select, DropOverlay
- [x] 08-05-PLAN.md — UI fixes: ServerTabs pill indicator, disconnect a11y, auth contrast, visual softness
- [x] 08-06-PLAN.md — Screen specs documentation for all Pro screens

### Phase 9: New Components
**Goal**: В shared/ui появляются 4 новых компонента — Skeleton, StatusIndicator, StatCard, Accordion — каждый со Storybook story и тестами
**Depends on**: Phase 8
**Requirements**: COMP-01, COMP-02, COMP-03, COMP-04
**Success Criteria** (what must be TRUE):
  1. В Storybook отображаются stories для Skeleton (shimmer-анимация), StatusIndicator (dot, цвета через токены), StatCard (label + value + trend), Accordion (expand/collapse с анимацией)
  2. Каждый компонент использует CVA для вариантов и CSS-токены для цветов — ни одного захардкоженного hex
  3. Accordion раскрывается и закрывается плавно (≤300ms), `aria-hidden` переключается правильно
  4. Тесты компонентов проверяют поведение и семантику, не Tailwind-классы
**Plans:** 3/3 plans complete
Plans:
- [x] 09-01-PLAN.md — Skeleton + StatusIndicator (CVA, keyframe, stories, tests)
- [x] 09-02-PLAN.md — useCollapse hook + Accordion (multi/single, aria, stories, tests)
- [x] 09-03-PLAN.md — StatCard (Card wrapper, trend, loading) + barrel exports
**UI hint**: yes

### Phase 10: Tab Bar & Control Panel
**Goal**: Нижний таббар имеет pill-индикатор с анимацией, ControlPanel показывает Skeleton при SSH-операциях, ServerTabs сокращён до 5 вкладок, credentials сохраняются
**Depends on**: Phase 9
**Requirements**: NAV-01, NAV-02, NAV-03, CP-01, CP-02, CP-03, CP-04, CP-05
**Success Criteria** (what must be TRUE):
  1. При переключении вкладок pill-индикатор плавно перемещается (transform: translateX, ≤300ms, ease-out) без модификации display на скрытых вкладках
  2. Переход между вкладками использует cross-fade (≤300ms), не slide
  3. При SSH-операциях вместо пустого экрана отображается Skeleton loading
  4. После отключения от сервера поля host и username в SshConnectForm остаются заполненными
  5. ServerTabs содержит 5 вкладок — DangerZone перенесена в Tools через Accordion
**Plans:** 3 plans
Plans:
- [ ] 10-01-PLAN.md — Pill indicator + cross-fade tab panels (TabNavigation, App.tsx)
- [ ] 10-02-PLAN.md — ServerTabs 6->5 + DangerZone Accordion + StatusPanel shadow + ServerStatsCard StatCard
- [ ] 10-03-PLAN.md — Skeleton loading + credentials persist (ControlPanelPage, SshConnectForm, ServerPanel)
**UI hint**: yes

### Phase 11: Screen UX Redesign
**Goal**: Серверная панель управления реструктурирована с 5 на 4 таба (Обзор/Пользователи/Настройки/Сервис), визуально переработана с использованием design-system v3.1, a11y-фиксы применены
**Depends on**: Phase 10
**Requirements**: SCREEN-01, SCREEN-02, SCREEN-03, SCREEN-04, SCREEN-05
**Success Criteria** (what must be TRUE):
  1. ServerTabs показывает 4 таба: Обзор (StatusIndicator + StatCard 2x2 + TLS cert), Пользователи, Настройки, Сервис
  2. Danger-кнопки отсутствуют на первом экране (Обзор) — только в табе Сервис через Accordion
  3. Пользователи используют OverflowMenu вместо 4 inline-иконок, delete визуально выделен
  4. Accent color на light theme проходит WCAG AA (accent-500), focus rings на TabNavigation + 8 inputs
  5. Тесты обновлены для всех изменённых компонентов, memory документация отражает новую структуру
**Plans:** 5 plans
Plans:
- [ ] 11-01-PLAN.md — Accent color fix (accent-500 light) + focus-visible rings (TabNavigation + 8 inputs)
- [ ] 11-02-PLAN.md — ServerTabs 5->4 rewrite + OverviewSection + i18n keys
- [ ] 11-03-PLAN.md — ServerSettingsSection + ServiceSection + wire into ServerTabs
- [ ] 11-04-PLAN.md — OverflowMenu shared/ui component + UsersSection integration
- [ ] 11-05-PLAN.md — Tests for new components + memory docs update + visual checkpoint
**UI hint**: yes

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v3.0 | 5/5 | Complete | 2026-04-15 |
| 2. Primitive Redesign | v3.0 | 7/7 | Complete | 2026-04-15 |
| 3. Control Panel | v3.0 | 3/3 | Complete | 2026-04-15 |
| 4. Remaining Panels | v3.0 | 6/6 | Complete | 2026-04-15 |
| 5. Layout Shell | v3.0 | 3/3 | Complete | 2026-04-15 |
| 6. Cleanup | v3.0 | 3/3 | Complete | 2026-04-15 |
| 8. Stabilization | v3.1 | 6/6 | Complete   | 2026-04-15 |
| 9. New Components | v3.1 | 3/3 | Complete   | 2026-04-15 |
| 10. Tab Bar & Control Panel | v3.1 | 0/3 | Planning complete | - |
| 11. Screen UX Redesign | v3.1 | 0/5 | Planning complete | - |

### Phase 12: Инфраструктура панели — 5 табов, убрать хедер, иконка Отключиться, Activity Log foundation

**Goal:** Серверная панель реструктурирована с 4 на 5 табов (Обзор/Пользователи/Конфигурация/Безопасность/Утилиты), хедер с IP удален, disconnect перенесен в иконку LogOut с ConfirmDialog, Activity Log инфраструктура создана (Rust + React hook + logging Phase 12 событий)
**Requirements**: D-01, D-02, D-03, D-04, D-05, D-06, D-07, D-08, D-09, D-10, D-11, D-12, D-13, D-14
**Depends on:** Phase 11
**Success Criteria** (what must be TRUE):
  1. ServerTabs показывает 5 табов: Обзор, Пользователи, Конфигурация, Безопасность, Утилиты — с полным содержимым (не skeleton-заглушки)
  2. Хедер с IP-адресом полностью удален, IP показывается только в Обзоре
  3. Иконка LogOut справа от табов с border-l разделителем, ConfirmDialog variant=danger при нажатии
  4. Activity Log: Rust модуль пишет в файл с ротацией, React hook fire-and-forget, кнопка "Скачать логи" в PanelErrorBoundary
  5. Phase 12 логирует: app.start, tab.switch, server.disconnect.*
  6. TypeScript и Rust компилируются без ошибок
**Plans:** 4 plans
Plans:
- [ ] 12-01-PLAN.md — Rust Activity Log module + React hook useActivityLog
- [ ] 12-02-PLAN.md — ServerTabs 4->5 tabs + header removal + disconnect icon + i18n keys
- [ ] 12-03-PLAN.md — SecurityTabSection + UtilitiesTabSection + ServerSettingsSection cleanup + wire-up
- [ ] 12-04-PLAN.md — PanelErrorBoundary "Скачать логи" + Activity Log integration (app.start, tab.switch, disconnect)

### Phase 13: Таб Обзор — статус, IP/страна, версия, TLS, метрики, Ping, скорость, сводка безопасности, drill-down

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 12
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 13 to break down)

### Phase 14: Таб Пользователи — быстрые иконки, overflow menu, генерация конфига с DNS upstream, auto-QR

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 13
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 14 to break down)

### Phase 15: Таб Конфигурация — Quick Settings, TOML-парсер Advanced Accordion, двухуровневое сохранение

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 14
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 15 to break down)

### Phase 16: Таб Безопасность — Firewall Modal, Fail2Ban, SSH-ключ с auto-detect, TLS cert

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 15
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 16 to break down)

### Phase 17: Таб Утилиты — BBR, MTProto, Server Benchmark IP.Check.Place, Логи, DangerZone

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 16
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 17 to break down)

### Phase 18: Онбординг Welcome + каскадная индикация обновлений + бесшовное обновление протокола с rollback

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 17
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 18 to break down)
