# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Language

Always communicate in Russian. The developer is Russian-speaking.

## Project Overview

TrustTunnel Client for Windows — desktop VPN client built with **Tauri 2 + React 19 + Rust**. Two editions share one monorepo:

- **gui-pro/** (Pro) — full server management via SSH + VPN connection
- **gui-light/** (Light) — simplified client, connection only

> **Companion docs at root** (auto-generated 2026-04-17): [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md), [GETTING-STARTED.md](GETTING-STARTED.md), [DEVELOPMENT.md](DEVELOPMENT.md), [TESTING.md](TESTING.md), [CONFIGURATION.md](CONFIGURATION.md), [CONTRIBUTING.md](CONTRIBUTING.md). Эти файлы — для git-юзеров и контрибьюторов; CLAUDE.md остаётся источником правды для AI/dev guidance и ссылается на них чтобы не дублировать.

## Build Commands

```bash
# Frontend (from gui-pro/)
npm run build              # Vite production build
npm run dev                # Vite dev server on :1420
npm run tauri:dev          # Tauri dev with hot reload

# Tests
npm run test               # Vitest run (all tests)
npx vitest run src/shared/ui/Button.test.tsx  # Single test file

# Quality
npm run typecheck          # tsc --noEmit (strict mode)
npm run lint               # ESLint (max-warnings 0)
npm run rust:check         # cargo clippy -D warnings

# Full prerelease check
npm run prerelease         # typecheck + lint + test + clippy + build

# NSIS installer (from gui-pro/)
npm run tauri build -- --bundles nsis

# Storybook
npm run storybook          # Dev server on :6006
npm run build-storybook    # Static build
```

## Architecture

### Frontend (React 19 + TypeScript)

```
gui-pro/src/
├── App.tsx                    # Root: shell layout, VPN state, tab routing
├── components/
│   ├── layout/                # TitleBar, TabNavigation, WindowControls
│   ├── server/                # SshConnectForm, ServerStatusSection, UsersSection, etc.
│   ├── routing/               # Routing rules UI (GeoIP, domain, process filters)
│   ├── wizard/                # Setup wizard steps
│   ├── dashboard/             # Stats, ping, speed test
│   ├── settings/              # App settings sections
│   ├── ControlPanelPage.tsx   # Main panel: SshConnectForm ↔ ServerPanel
│   ├── ServerPanel.tsx        # Server management orchestrator
│   └── ServerTabs.tsx         # 5-tab server navigation (Обзор/Пользователи/Конфигурация/Безопасность/Утилиты) — Phase 11 layout
├── shared/
│   ├── ui/                    # 33 shared components (Button, Input, Modal, Badge, Skeleton, StatusIndicator, StatCard, Accordion, OverflowMenu, ActionInput, ActionPasswordInput, etc.)
│   ├── hooks/                 # useVpnEvents, useTheme, useKeyboardShortcuts, useCollapse, etc.
│   ├── styles/tokens.css      # Design tokens (262 lines, two-tier: primitives + semantics)
│   ├── lib/cn.ts              # clsx + tailwind-merge with custom font-size group
│   ├── i18n/locales/          # ru.json, en.json
│   ├── types.ts               # AppTab, VpnStatus, VpnConfig, LogEntry, ThemeMode
│   └── context/VpnContext.tsx  # VPN state context
└── index.css                  # Global styles, animations, scrollbars
```

### Backend (Rust / Tauri 2)

```
gui-pro/src-tauri/src/
├── lib.rs                 # Tauri app setup, plugin registration, tray, window
├── commands/              # ~73 Tauri IPC commands (`#[tauri::command]`)
│   ├── vpn.rs             # VPN connect/disconnect, sidecar management
│   ├── ssh_commands.rs    # Server management via SSH (users, config, certs, firewall)
│   ├── config.rs          # Client config read/write
│   ├── network.rs         # Ping, DNS, adapter detection
│   └── updater.rs         # GitHub release checker
├── ssh/                   # SSH connection pool, russh client
├── sidecar.rs             # C++ sidecar binary (trusttunnel_client) lifecycle
├── routing_rules.rs       # GeoIP/GeoSite rule application
├── connectivity.rs        # Internet connectivity monitor with auto-reconnect
└── tray.rs                # System tray menu builder
```

### IPC Pattern

Frontend calls Rust via `invoke("command_name", { params })`. Rust emits events to frontend via `app.emit("event-name", payload)`. Key events: `vpn-status`, `vpn-log`, `internet-status`, `geodata-progress`, `geodata-files-changed`, `config-file-changed`, `ssh-host-key-verify`, `deep-link-url`.

## Current State (v3.1, Pro v3.0.0 / Light v2.7.0)

v3.0 shipped (Phases 1-6): полный редизайн → bottom tab bar, двухуровневые токены, 33 CVA-компонента, Geist Sans/Mono, slate-teal палитра. v3.1 в работе (Phases 8-14 shipped, Phases 15-18 запланированы):

- **Phase 8:** Stabilization — CI зелёный, i18n cleanup, screen specs
- **Phase 9:** +4 компонента — Skeleton, StatusIndicator, StatCard, Accordion (useCollapse hook)
- **Phase 10:** Pill-индикатор (translateX + getBoundingClientRect), cross-fade табов (visibility+opacity), Skeleton loading при SSH, credentials persist (localStorage)
- **Phase 11:** Серверная панель 5 табов (Обзор/Пользователи/Конфигурация/Безопасность/Утилиты), accent color fix, focus rings, OverflowMenu, OverviewSection/ServerSettingsSection/ServiceSection
- **Phase 12-12.5:** ConfirmDialogProvider+useConfirm imperative API, Skeleton+Activity Log foundation, useServerState hook splitting
- **Phase 13:** OverviewSection 10 live-карточек, drill-down, ServerPanelSkeleton, IP/TLS/ping (G-01..G-08 post-UAT fixes shipped)
- **Phase 14:** Users tab редизайн — 2 inline icons (FileText+Trash2) вместо OverflowMenu+radio, UserConfigModal compound (QR+deeplink+download), ActionInput/PasswordInput.clearable, OverflowMenu auto-flip
- **Phase 14.1:** Advanced user config — UserModal compound (2 секции: credentials + deeplink TLV), CIDRPicker primitive, PasswordRotationPrompt, CertificateFingerprintCard (endpoint probe через `tokio-rustls`), anti-DPI per-user prefix (rules.toml), 8 plans + 20+ post-ship revisions (M-01..M-11 polish, WR-01..WR-06 regressions, CR-01..CR-05 security). Retrospective: `memory/project_phase14.1_advanced_config.md`. UAT закрыт как `deferred-stale` — revision commits не отражены в SUMMARY.md.
- **Phase 15-18 (planned):** Phase 15 CONTEXT.md готов (TOML-парсер Advanced Accordion + Quick Settings + двухуровневое сохранение); дальше SSH-ключ, Fail2Ban, каскадная индикация обновлений, welcome+rollback

**Layout:** bottom tab bar (5 pill-кнопок, 64px), кастомный TitleBar 32px, окно 900×1000, minWidth 800, **maxWidth 1000** (per `tauri.conf.json`)

## Planning Documentation

- **CONTROL-PANEL-SPEC.md** — спецификация редизайна панели управления (v1.1, 770 строк). Описывает целевое состояние: 5 серверных табов, УТП, онбординг, TOML-парсер, бесшовное обновление, Activity Log, SSH-ключ, Fail2Ban. Используется как методичка для Phase 12-18.
  - Путь: `.planning/phases/11-screen-ux-redesign/CONTROL-PANEL-SPEC.md`

## Memory Documentation

`memory/` (gitignored) — граф знаний дизайн-системы и архитектуры. Структура: `memory/v3/{design-system,screens,decisions,use-cases,test-cases}/`. Корневые файлы: `design-system.md`, `shell-architecture.md`, `tab-navigation-logic.md`, `components-catalog.md` (33 shared UI + ~100 screen). Точный реестр и кросс-ссылки — в `memory/v3/components-catalog.md` и `memory/MEMORY.md`.

**Правило:** при изменении UI / токенов / поведения табов — обновить соответствующий файл в `memory/v3/`. Поддерживать перекрёстные ссылки (архитектура ↔ экраны, компоненты ↔ анимации, решения ↔ реализация).

## Design System Rules

1. **All colors via CSS tokens** from `tokens.css` — never hardcode hex in components.
2. **Typography (v2, Phase 14.2):** use Tailwind classes mapped to tokens — `font-normal/medium/semibold/bold`, `text-xs/sm/base/lg/xl/2xl/3xl/4xl/5xl`, `leading-tight/snug/normal/relaxed`, `tracking-tight/normal/wide`. **Prefer semantic composite classes** — `text-caption/body-sm/body/body-lg/subtitle/button/title-sm/title/title-lg/display-sm/display/wordmark/mono/mono-sm` (apply family+size+weight+leading atomically). New UI code **должен** использовать semantic-composite там где подходит: `<h2 className="text-title">` вместо `text-lg font-semibold leading-snug`; `<button className="text-button">` вместо `text-sm font-medium tracking-wide`. Manual combinations — только для оттенков, не покрытых composites. **Weight rules:** `font-medium` для buttons/form-labels/tabs/chips, `font-semibold` для headings/titles, `font-bold` только display/wordmark. **NEVER** use legacy patterns: `font-[var(--font-weight-*)]`, `text-[var(--font-size-*)]`, inline `style={{ fontSize }}`, **Tailwind arbitrary `text-[Npx]` bypassing scale (e.g. `text-[11px]`, `text-[13px]`)** — all removed in Plan 14.2 strict compliance.
3. **Font families:** `font-sans` (default UI — Geist Sans), `font-mono` (technical data: IP, SHA, hex, logs, tabular numbers, **units accompanying values** like "42 ms", "124 Мбит/с" — full unit-value combo mono), `font-display` (wordmark «TrustTunnel» only — AboutPanel / TitleBar). Rule: **labels in sans, values in mono**. CPU/RAM/TLS/«Работает»/«Активен» — labels = sans.
4. **Buttons with colored backgrounds:** use `text-white`, not `text-[var(--color-text-inverse)]` — inverse = black in dark theme.
5. **Accent color:** only for interactive elements (10% rule).
6. **Class merging:** always use `cn()` from `shared/lib/cn.ts` — extended with semantic typography composite classes in font-size group.
7. **Components use CVA** (class-variance-authority) for variants: Button (primary/secondary/danger/danger-outline/ghost/icon), Badge (success/warning/danger/neutral/dot/default × sm/md), StatusBadge.

**Typography reference** (Phase 14.2 canonical): [`memory/v3/design-system/typography.md`](memory/v3/design-system/typography.md) — decision tree + component → class mapping + rules + anti-patterns. Visual: Storybook → Foundations → Typography.

**Spacing reference:** [`memory/v3/design-system/spacing.md`](memory/v3/design-system/spacing.md) — 4px base grid, 8 tokens (`--space-1..8` = 4/8/12/16/20/24/32/40). Rules: Tailwind `p-1..6/m-1..6/gap-1..6` матчат `--space-1..6` directly; для 32/40 использовать **bracket notation** `p-[var(--space-7)]` / `p-[var(--space-8)]` (НЕ `p-7`/`p-8`/`p-10` Tailwind native — naming collision: они = 28/32/40, наши = 32/40). Anti-patterns: `p-[13px]` non-multiples of 4, inline `style={{ padding }}`, magic numbers в CSS. Exceptions задокументированы (TitleBar PRO badge, sidebar widths, OS chrome).

**Shadows reference:** [`memory/v3/design-system/shadows.md`](memory/v3/design-system/shadows.md) — 5-level elevation (`--shadow-xs..xl` = flat-plus/flat/raised/floating/deep) + `--focus-ring` (double-ring keyboard focus). Rules: **No glow, no color tint** (tint в shadow = visual noise). Use `shadow-[var(--shadow-N)]` bracket или inline `style={{ boxShadow: "var(--shadow-N)" }}` — НЕ Tailwind native `shadow-sm/md/lg/xl` (разные rgba). Component mapping: Card=sm, Modal=lg, Dropdown/Tooltip=md, Deep modal=xl, focus states=--focus-ring. Anti-patterns: colored tint glow (`0 Xpx ... accent-tint-*`), 2-layer shadows, arbitrary rgba, tint-based focus accent (`0 0 0 2px tint-50` → use solid `accent-500` или `--focus-ring`).

**Colors reference:** [`memory/v3/design-system/colors.md`](memory/v3/design-system/colors.md) — 89 tokens, 7 functional layers (accent / bg / text / border / input / status / tint). Slate-teal accent palette (10 steps, 50-900); **10% accent rule** (accent только для interactive); semantic tokens theme-aware (`--color-accent-interactive` resolves to accent-400 dark / accent-600 light); status scale per-category (400/500/600 × success/warning/danger/info) — **dark uses 400, light uses 600, body text status → use `-500` midpoint на обоих themes**. Rules: `text-[var(--color-*)]` bracket notation (НИКОГДА Tailwind native `text-red-500`); semantic tokens only (не `--color-success-400` напрямую, а `--color-status-connected`); theme parity mandatory. Anti-patterns: hardcoded hex (`color: "#ef4444"`), inline rgba() (use tint tokens), accent для decoration, status-600 body text на light. Known contrast issues: dark `text-muted` = 3.81:1 (UI ≥18pt only, body → `text-secondary`); light `success-600`/`warning-600` fail AA body text. Destructive vs Danger: `--color-destructive` для high-stakes actions (delete/reset), `--color-danger-*` scale для status feedback (error badge, validation). Inspired by Radix Colors, Shadcn/ui, Vercel Geist, Material 3.

## Key Patterns

- **Tab switching:** cross-fade via `visibility: hidden` + `opacity: 0` (NOT `display: none`) — preserves React state, enables smooth transitions. Pill indicator in bottom tab bar animates via `transform: translateX` with `getBoundingClientRect`
- **i18n:** all user-facing text via `useTranslation()` with keys in `ru.json`/`en.json`
- **Seamless design:** body has `bg-primary`, all components transparent — no layered backgrounds
- **Window:** custom decorations (`decorations: false`), `data-tauri-drag-region` on TitleBar
- **Sidecar:** C++ binary `trusttunnel_client-x86_64-pc-windows-msvc.exe` (declared в `tauri.conf.json` как `externalBin: ["trusttunnel_client"]`) + DLLs (`wintun.dll`, `vcruntime140*.dll`) — лежат в `gui-pro/src-tauri/`, не в `sidecar/`. В worktree их нужно скопировать перед `cargo check` / build
- **SSH channel gate:** `ssh/mod.rs:CHANNEL_OPEN_GATE = LazyLock<Semaphore::new(5)>` — global limiter на parallel `channel_open_session()`. Panel mount fires ~10 команд на shared handle; без gate упирались в sshd default `MaxSessions=10` → `SSH_MSG_CHANNEL_OPEN_FAILURE reason=ConnectFailed`. Retry поверх gate: 6 attempts × exp-backoff 50/100/200/400/800ms + jitter. НЕ повышать permit выше 6-7 (нужен headroom для keepalive + ad-hoc kill-sidecar команд). Полный контекст: `memory/project_phase14.1_advanced_config.md` §Infrastructure fixes.

## Critical Rules

- **master branch is READ-ONLY** — never commit/merge without explicit request
- **No Claude/AI artifacts in git** — only application code
- **Version bumps:** update version in: `gui-pro/package.json`, `gui-pro/src-tauri/Cargo.toml`, `gui-pro/src-tauri/tauri.conf.json`, `gui-light/package.json`, `gui-light/src-tauri/Cargo.toml`, `gui-light/src-tauri/tauri.conf.json`
- **NSIS installers:** after changes, build and copy to Desktop
- **Memory docs:** `memory/` directory contains design documentation (gitignored) — keep up to date after UI changes
- **Tray menu = native only** (2026-04-20 lesson) — custom webview tray-menu window (rounded + transparent) заблокирован Tauri issue #13859: DWM отключает composition для dark-themed transparent окон на Windows 11 → чёрный прямоугольник вокруг card, rounded corners исчезают. Canonical путь = `.menu(&tray_menu)` + native OS context menu + `on_menu_event` handler. Left-click toggle main window — custom (`on_tray_icon_event` Left: `is_visible()` → hide/show), но НЕ через второй webview. `tray-menu.tsx` + `tray-menu.html` оставлены как dead reference, НЕ wired в `tauri.conf.json`.

## Security Rules

Полная политика и threat model — [SECURITY.md](SECURITY.md) + [memory/security-posture.md](memory/security-posture.md).

- **Char-whitelist ВСЕГДА** — все user-input validators в `gui-pro/src-tauri/src/ssh/sanitize.rs` используют whitelist `[a-zA-Z0-9...]`, не blacklist. Добавляешь новое поле deeplink/credentials — добавь validator.
- **D-29 invariant** — пароли НИКОГДА не попадают в `activity.log`. Любой компонент с password handling обязан иметь spy-тест `expect(log).not.toHaveBeenCalledWith(expect.stringContaining(password))`.
- **SSH heredoc** — для multi-line commands используй UUID-based delimiters (`EOF_<uuid>`), НЕ статичные `USER_EOF`. См. `server_install.rs` post-14.1 pattern — иначе username/password может содержать маркер и сломать shell parsing (или сделать injection).
- **Base64 wire format для binary** — Vec<u8> через serde сериализуется как массив чисел, TypeScript получит `number[]`. Используй `leaf_der_b64: String` на обеих сторонах.
- **Accepted risk — RUSTSEC-2023-0071** (rsa Marvin attack, russh dep) — документирован в SECURITY.md. Для production рекомендуем Ed25519 SSH-ключи, НЕ RSA.
- **Prerelease audit** — `cd gui-pro/src-tauri && cargo audit` обязателен перед релизом. Ожидаемо: 1 vuln (rsa), 23 warnings (gtk-rs Linux-path).

## Worktree Setup

In git worktrees, sidecar binary + DLLs are not present (они gitignored). Before `cargo check`:
```bash
# From worktree root — копируем sidecar бинарник + DLL из main checkout в текущий worktree
cp ../../../gui-pro/src-tauri/trusttunnel_client-x86_64-pc-windows-msvc.exe gui-pro/src-tauri/
cp ../../../gui-pro/src-tauri/{wintun.dll,vcruntime140.dll,vcruntime140_1.dll} gui-pro/src-tauri/

# Frontend зависимости + сборка
cd gui-pro && npm install && npm run build
```
Frontend-only фазы (i18n / stories / React-компоненты без Rust-проверки) могут пропустить копирование sidecar.

## Testing Patterns

- **Visibility, not DOM:** collapsed/hidden elements → `not.toBeVisible()`, NOT `not.toBeInTheDocument()` (элемент остаётся в DOM при visibility:hidden)
- **RAF mock:** `gui-pro/src/test/setup.ts` содержит синхронный `requestAnimationFrame` mock — анимации выполняются мгновенно в тестах
- **i18n в тестах:** `i18n.changeLanguage('ru')` в `beforeEach` обязателен для компонентов с `t()`
- **Тестировать поведение и aria** — `toBeVisible()`, `aria-expanded`, `aria-hidden`, `role` — НЕ CSS-классы
- **Storybook stories обязательны** при создании/изменении компонентов. Интерактивные stories используют `useState` внутри `render()` либо `play()` из `storybook/test` (`userEvent`+`within`+`waitFor`). 42 story файла.

## localStorage Keys

Все ключи имеют префикс `tt_*` (НЕ `trusttunnel_*`).

| Key | Purpose | Set | Cleared |
|-----|---------|-----|---------|
| `tt_ssh_last_host` | Last SSH host | At connect | Never (persist) |
| `tt_ssh_last_user` | Last SSH username | At connect | Never (persist) |
| `tt_ssh_last_port` | Last SSH port | At connect | Never (persist) |
| `tt_active_page` | Active app tab | On tab change | Never |
| `tt_active_tab` | Active server-panel tab | On server tab change | Never |
| `tt_theme` | Theme mode (light/dark/system) | On theme change | Never |
| `tt_language` | UI language (ru/en) | On language change | Never |
| `tt_config_path` | Last loaded config file path | On import | On clear/disconnect |
| `tt_log_level` | Log level (info/debug) | On settings change | Never |
| `tt_connected_since` | VPN connect timestamp (ISO) | On connect | On disconnect |
| `tt_auto_connect` | Auto-connect on startup flag | On settings change | Never |
| `tt_feature_toggles` | Optional feature flags (JSON) | On settings change | Never |
| `tt_navigate_after_setup` | Navigate target after wizard | On wizard complete | After navigation |
| `tt_vpn_status` | Cached VPN status | On status change | On disconnect |
| `tt_server_stats` | Server stats cache (sessionStorage) | On panel load | On panel unmount |
| `tt_geoip_<host>` | Cached GeoIP per server | On geoip resolve | TTL-based |

## Gotchas

- `text-[var(--font-size-*)]` generates `color:` not `font-size:` in Tailwind — use `text-xs/sm/base/lg` instead
- `cn()` needs custom `extendTailwindMerge` for font-size class group (already configured in `cn.ts`)
- Storybook requires Tauri API mocks in `.storybook/tauri-mocks/` — 6 mock files (api-app/api-core/api-event/api-window/plugin-dialog/plugin-shell)
- `colors.ts` was deleted in v3.0 — all colors via CSS tokens only
- Button `text-white` on colored backgrounds — `--color-text-inverse` is black in dark theme
- **Inline `style={{ color: "var(--token)" }}` побеждает Tailwind hover utilities** (Phase 14 finding) — `hover:text-*` / `focus:text-*` НЕ применяются. Базовый цвет → в className-токен (`text-[var(--color-x)]`); inline-style оставлять только для динамических вычислений (paddingRight, getBoundingClientRect-position). См. [memory/v3/design-system/known-issues.md#9](memory/v3/design-system/known-issues.md)
- **`transition-colors` не транзитит opacity** (Phase 14 finding) — `hover:opacity-70` снапит мгновенно. Использовать `transition-opacity` или `transition-all`
- **НЕ делать `if (!isOpen) return null` до `<Modal>`** (Phase 14 post-install finding) — Modal primitive управляет своим lifecycle через `mounted`+`animating` state + 200ms exit transition. Early return null в parent'е убивает exit-анимацию (React unmount'ит всё до того как Modal fade'нет). Парент передаёт `isOpen` как есть. Для cleanup state на close — `setTimeout(200)` в useEffect. Эталон — `UserConfigModal.tsx`. Подробно: [memory/v3/design-system/known-issues.md#10](memory/v3/design-system/known-issues.md) + JSDoc в `Modal.tsx`
- **Hover/show state застревает после `window.hide()`** (2026-04-20 finding) — tray-click скрывает окно, но React-компонент не unmount'ится, `onMouseLeave` не стреляет, hover/tooltip остаются зафиксированными при re-show. Любой компонент с persistent hover/show state (WindowControls, Tooltip, etc.) должен слушать `tauri://blur` → resetить state. Применено в `WindowControls.tsx` (background hover) + `Tooltip.tsx` (show + pending-timer — универсальный fix для всех 40+ usages). Подробно: [memory/v3/design-system/known-issues.md#11](memory/v3/design-system/known-issues.md)
- **SSH pool channel stampede** (2026-04-20 finding) — panel mount fires ~10 параллельных SSH commands на shared pool-handle (OverviewSection + UsersSection + SecurityTab + Utilities), sshd default `MaxSessions=10` → некоторые падают с `SSH_MSG_CHANNEL_OPEN_FAILURE reason=ConnectFailed`. Fix: global `Semaphore::new(5)` в `ssh/mod.rs:CHANNEL_OPEN_GATE` физически ограничивает parallel `channel_open_session()` до 5 + retry с exp-backoff 6 attempts × (50/100/200/400/800ms + jitter). Двухслойная защита: gate prevents overload, retry mitigates sshd-side race. Симптом без фикса — snackbar «SSH_CHANNEL_FAILED\|Failed to open channel (ConnectFailed)» через 400ms после panel.load.completed при login в новый сервер
- **Storybook docs-page contrast** (2026-04-20 finding) — MDX docs-страницы (`src/docs/*.mdx`) имеют белый cream фон, но `tokens.css:141` определяет CSS variables в комбинированном селекторе `:root + [data-theme="dark"]` → на docs root (где data-theme attribute не вешается) `var(--color-text-muted) = #6e6e6e` рисуется dark-value на белом = низкий контраст, labels «--shadow-lg» / «--space-4» / `--font-size-xs` теряются. Плюс markdown-таблицы не рендерились без **remark-gfm**. Fix: (1) remark-gfm подключён в `.storybook/main.ts` через addon-docs `mdxCompileOptions.remarkPlugins`; (2) `.storybook/storybook-overrides.css` переопределяет `--color-text-*` + `--color-bg-*` на light-theme values внутри `.sbdocs` scope (все inline `style={{ color: var(--...) }}` автоматически readable, НЕ hardcode'ить hex в MDX). **НЕ удалять `.sbdocs` token block без синхронизации с tokens.css изменениями.** Подробно: [memory/v3/design-system/storybook.md §Docs-page colors](memory/v3/design-system/storybook.md)
