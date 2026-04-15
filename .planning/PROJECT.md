# TrustTunnel

## What This Is

Десктопный VPN-клиент для Windows (Tauri 2 + React 19 + Rust + C++) с двумя изданиями: Pro (полное управление сервером через SSH + VPN-подключение) и Lite (минималистичный клиент для обычных пользователей). Решает проблему людей, которые хотят обходить интернет-ограничения без погружения в техническую настройку.

## Core Value

Пользователь устанавливает приложение, вставляет ссылку/конфиг и подключается к VPN — без необходимости разбираться в CLI, протоколах или настройках.

## Current State (after v3.0)

**Shipped:** v3.0 BigTech Production Redesign (2026-04-15)
**Version:** 3.0.0
**Next milestone:** v3.1 UX Redesign (planning)

### What was built in v3.0:
- Полная дизайн-система: two-tier tokens (primitives + semantics), dark/light via CSS vars
- 25 shared/ui компонентов с CVA-вариантами и Storybook stories
- Geist Sans/Mono шрифты, slate-teal палитра
- Все 8 экранов Pro-версии мигрированы на новую дизайн-систему
- Кастомное окно (decorations: false), bottom tab navigation
- Storybook 10 с Tauri API моками, MDX Foundations pages
- memory/v3/ документация дизайн-системы

## Requirements

### Validated

- ✓ VPN-подключение через протокол TrustTunnel — v1.0+
- ✓ Кастомное окно Windows (title bar, drag, resize) — v1.0+
- ✓ Импорт конфигурации (вставка ссылки, drag & drop, файл) — v1.0+
- ✓ Продвинутая маршрутизация трафика (GeoIP/GeoSite) — v2.0+
- ✓ i18n локализация (русский/английский) — v2.0+
- ✓ Трей-меню с управлением VPN — v2.3.0
- ✓ File logging — v2.3.0
- ✓ Gateway connectivity monitoring — v2.5.0
- ✓ Changelog modal — v2.5.0
- ✓ Deep links (tt:// протокол) — v2.0+
- ✓ Дизайн-система (токены, компоненты, типографика, dark/light) — v3.0
- ✓ Storybook-приложение для визуального тестирования — v3.0
- ✓ Редизайн всех экранов Pro-версии — v3.0
- ✓ Кастомное окно и layout shell — v3.0

### Active

- [ ] UX-редизайн панели управления (dashboard, expandable users, security health)
- [ ] Редизайн нижнего меню (pill-индикатор, новые иконки, анимации)
- [ ] Редизайн Server Tabs (6→5, overflow menu для Danger Zone)
- [ ] Новые shared/ui компоненты (Skeleton, StatCard, StatusIndicator, Accordion)
- [ ] Документация: screen specs, use cases, test cases для всех экранов
- [ ] Фикс 19 падающих тестов (i18n keys, CVA variants, Tauri mocks)

### Out of Scope

- Lite-версия редизайн — после завершения Pro (наследует design-system)
- Кастомный установщик v3 — последний этап, наследует дизайн-систему
- Автообновление — будет учтено в архитектуре, но реализация позже
- Мобильная версия — не планируется
- Tailwind v4 миграция — отложено на отдельный milestone

## Context

- **Текущая версия:** v3.0.0
- **Стек:** Tauri 2.2, React 19, Rust 1.88, C++20 (VPN-ядро)
- **Фронтенд:** 25 UI-компонентов (shared/ui/), CSS-токены в tokens.css, Tailwind, CVA
- **Шрифты:** Geist Sans + Geist Mono (variable)
- **Палитра:** Slate-teal (#4d9490 accent), dark-first
- **Storybook:** 32 story файла, MDX Foundations
- **Тесты:** 1361 (1321 pass, 19 fail, 21 todo)
- **Окно:** 900x1000, decorations:false, bottom tab bar (5 табов)
- **Документация:** memory/v3/ (gitignored) — design system, components, screens

## Constraints

- **Платформа**: Windows only (Tauri 2)
- **Два издания**: Pro и Lite должны быть визуально в одной семье, но индивидуальны
- **Git policy**: Никакие AI/Claude артефакты не попадают в git — только код приложения
- **Документация**: Хранится локально в memory/ (gitignore), не в репозитории
- **master branch**: READ-ONLY — никаких коммитов/мержей без явного запроса

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Storybook для компонентной витрины | Визуальное тестирование компонентов в изоляции, light/dark тема, a11y | ✓ Good — 32 story файла |
| Контрактная разработка | Избавиться от вайб-кодинга, документация как source of truth | ✓ Good — tokens→components→screens pipeline |
| Дизайн-система до кодирования | Сначала токены + компоненты в Storybook, потом экраны | ✓ Good — все экраны единообразны |
| memory/ как проектная wiki | Перекрёстные ссылки, полное покрытие | ⚠️ Revisit — docs gaps (5 partial) |
| CVA для вариантов компонентов | class-variance-authority для Button/Badge/ErrorBanner | ✓ Good — консистентные варианты |
| Slate-teal акцентная палитра | Свежий, не-generic вид, хороший контраст в dark/light | ✓ Good |
| Bottom tab navigation (5 табов) | Замена top sidebar, Material Design bottom nav | ✓ Good — но нужен pill-индикатор (v3.1) |
| display:none tab caching | Сохранение React state при переключении табов | ✓ Good — нет ререндеров |

---
*Last updated: 2026-04-15 after v3.0 milestone completion*
