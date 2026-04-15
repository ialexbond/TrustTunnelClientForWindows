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

- [ ] **Phase 8: Stabilization** — Зелёный CI, баги закрыты, документация экранов написана
- [ ] **Phase 9: New Components** — 4 новых shared/ui компонента с Storybook stories
- [ ] **Phase 10: Tab Bar & Control Panel** — Pill-индикатор, Skeleton loading, ServerTabs 5 вкладок
- [ ] **Phase 11: Screen UX Redesign** — Поэкранный редизайн Dashboard, Security, Settings, Routing, About

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
**Plans:** 3/6 plans executed
Plans:
- [x] 08-01-PLAN.md — Test infrastructure: RAF mock, Section aria-hidden, Button CVA fix
- [x] 08-02-PLAN.md — ConfirmDialog i18n: replace hardcoded defaults with t()
- [ ] 08-03-PLAN.md — Fix remaining 14 failing tests (ConfigPanel, ControlPanelPage, SshConnectForm, FoundStep, ProcessFilterSection)
- [x] 08-04-PLAN.md — i18n audit: remove hardcoded fallbacks from EmptyState, Select, DropOverlay
- [ ] 08-05-PLAN.md — UI fixes: ServerTabs pill indicator, disconnect a11y, auth contrast, visual softness
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
**Plans**: TBD
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
**Plans**: TBD
**UI hint**: yes

### Phase 11: Screen UX Redesign
**Goal**: Dashboard, Security, Settings, Routing и About переработаны визуально — используют новые компоненты, имеют чёткую иерархию и единый визуальный стиль
**Depends on**: Phase 10
**Requirements**: SCREEN-01, SCREEN-02, SCREEN-03, SCREEN-04, SCREEN-05
**Success Criteria** (what must be TRUE):
  1. Dashboard отображает метрики Download, Upload, Ping, Uptime через StatCard-компоненты
  2. Security-вкладка показывает health summary badge, счётчик дней до истечения сертификата и StatusIndicator для каждой проверки
  3. Settings открывается как единая scrollable-страница с секционными заголовками — без вложенных модалей
  4. Routing отображает правила с визуальной группировкой (по типу: GeoIP, domain, process)
  5. About освежена визуально и соответствует актуальной дизайн-системе v3.1
**Plans**: TBD
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
| 8. Stabilization | v3.1 | 3/6 | In Progress|  |
| 9. New Components | v3.1 | 0/? | Not started | - |
| 10. Tab Bar & Control Panel | v3.1 | 0/? | Not started | - |
| 11. Screen UX Redesign | v3.1 | 0/? | Not started | - |
