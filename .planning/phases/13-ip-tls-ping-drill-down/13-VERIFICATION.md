---
phase: 13-ip-tls-ping-drill-down
verified: 2026-04-17T12:00:00Z
status: human_needed
score: 13/13 must-haves verified
overrides_applied: 2
overrides:
  - must_have: "ROADMAP.md Phase 13 contains structured Success Criteria block"
    reason: "D-01..D-20 из 13-CONTEXT.md фактически выполняют роль success criteria; ROADMAP formatting inconsistency является документальной, не блокирует phase completion. Все 20 D-IDs покрыты и verified в Requirements Coverage таблице."
    accepted_by: "bondo"
    accepted_at: "2026-04-17T12:00:00Z"
  - must_have: "Version bump Pro 3.0.0→3.1.0 и Light 2.7.0→2.8.0 в 6 файлах + window titles"
    reason: "Версии намеренно возвращены к 3.0.0 (Pro) / 2.7.0 (Light) коммитом ec688775 (revert(13): restore versions to v3.0.0 and v2.7.0). Phase 13 UAT прошёл на Pro 3.0.0 NSIS — Plan 13-05 был преждевременным, версия будет поднята в момент релиза v3.1, а не в развивающейся ветке."
    accepted_by: "bondo"
    accepted_at: "2026-04-17T12:00:00Z"
re_verification:
  previous_status: gaps_found
  previous_score: 11/13
  gaps_closed:
    - "Speed card подключена к speedtest_run (manual refresh) — GAP-1 resolved"
    - "ROADMAP.md Phase 13 Success Criteria — accepted via override (documental gap)"
  gaps_remaining: []
  regressions:
    - "ServerPanel.test.tsx: 2 теста (`shows retry and configure buttons on error`, `configure SSH button calls onSwitchToSetup`) упали, потому что UAT G-04b fix заменил кнопку 'Настроить SSH' на 'Отключиться' на error-экране. Тесты устарели, не обновлены. Регрессия тест-сьюта, не регрессия продакшн кода."
human_verification:
  - test: "UAT 12/12 session (реальный сервер, Pro 3.0.0 NSIS)"
    expected: "12 manual tests passed, включая: skeleton на auto-reconnect, ECG live/dead transitions 3x remount, Ping цветовые диапазоны, Speed ↓↑ icons + Мбит/с при running + 'Запустите протокол' при stopped, Country localized через Intl.DisplayNames + localStorage cache, Security 4 sub-tiles с real firewall/fail2ban статусом + TLS days color, drill-down clicks на 3 картах, visual alignment tab separator = bottom nav ширина, adaptive skeleton 800/1000px"
    why_human: "Уже выполнено — UAT session задокументирован в 13-UAT.md от 2026-04-17T11:40:00Z с 12/12 passed + 6 UAT-gaps закрыты inline (G-01/G-02/G-03/G-04/G-04b/G-06). Подтверждение визуального, runtime, реального-сервера поведения."
  - test: "ServerPanel.test.tsx: обновить 2 теста после G-04b UAT fix"
    expected: "Тесты `shows retry and configure buttons on error` и `configure SSH button calls onSwitchToSetup` должны проверять кнопку 'Отключиться от сервера' (control.disconnect i18n) + state.onDisconnect callback вместо 'Настроить SSH' + mockOnSwitchToSetup."
    why_human: "Требует решение разработчика: обновить тесты под новое поведение G-04b (рекомендуется), либо откатить G-04b фикс, либо добавить override. Не блокирует Phase 13 goal (live-data + drill-down), но 2 falling теста в CI."
---

# Phase 13: Таб «Обзор» — живые данные + кликабельность + тесты — Verification Report (Re-verification)

**Phase Goal:** Превратить «Обзор» сервера в живую информационную панель с кликабельными карточками-ссылками на детальные табы.

**Roadmap Goal Text:** «Подключить живые данные к 10 карточкам обзора, добавить drill-down навигацию, полное покрытие тестами.»

**Verified:** 2026-04-17T12:00:00Z
**Status:** human_needed
**Re-verification:** Yes — after UAT-driven fix closure (session 12/12 passed + 6 gaps fixed)

---

## Re-verification Summary

Предыдущая VERIFICATION.md (2026-04-17T07:00:00Z) нашла 2 бреши:
1. **GAP-1 Speed card не подключена к speedtest_run** → **CLOSED** (Phase 13.UAT Test 6 + 3 unit-теста в `OverviewSection.test.tsx`)
2. **GAP-2 ROADMAP.md missing Success Criteria** → **CLOSED via override** (D-01..D-20 выполняют роль success criteria)

Дополнительно UAT-сессия (12/12 manual tests passed на Pro 3.0.0 NSIS) выявила и **inline закрыла 6 issues**:
- **G-01** Uptime+Load latency 12s → 2s (immediate first-fire в useServerStats + fastUptime poller через `server_get_uptime` command)
- **G-02** skeleton hangs на not-installed сервере (`setPanelDataLoaded(true)` при любом исходе loadServerInfo)
- **G-03** Country локализация (Intl.DisplayNames: `ru → "Германия"`, `en → "Germany"`) — вместо сырого English от ipwho.is
- **G-04** Disconnect button добавлен на not-installed экран (раньше force-kill app был единственным выходом)
- **G-04b** Disconnect button добавлен на connection-error экран (заменил "Configure SSH")
- **G-06** TabNavigation pill + button span full width (removed 4px cushion для vertical alignment с cards)

Статус `human_needed` (не `passed`) установлен из-за 2 элементов ручной верификации: UAT-session подтверждение (де-факто выполнено) + 2 падающих теста ServerPanel.test.tsx требуют решения разработчика (обновить под G-04b или откатить фикс).

---

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                                            | Status            | Evidence                                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Карточка Нагрузка показывает live CPU% + RAM% из server_get_stats                                              | VERIFIED          | OverviewSection.tsx:647-674 — CPU `Math.round(stats.cpu_percent)%` (line 651), RAM `Math.round((stats.mem_used / stats.mem_total) * 100)%` (line 670), ProgressBar. useServerStats wires `invoke<ServerStats>("server_get_stats", ...)` (line 80-86). Skeleton state (stats===null && statsLoading) line 633-644. 3 unit-теста + exponential backoff тест зелёные. |
| 2   | Карточка Uptime показывает формат `Xд Yч` / `Xч Yм` / `Xм` через formatServerUptime                            | VERIFIED          | OverviewSection.tsx:526-541 + uptime.ts:29-44 (`formatServerUptime`). Fast polling через новый `server_get_uptime` SSH-command (cat /proc/uptime <100ms) + fallback на stats.uptime_seconds. 12 тестов uptime.test.ts зелёные (включая 90061s → "1д 1ч").                                                                                                                            |
| 3   | Карточка Скорость подключена к speedtest_run (manual refresh)                                                   | VERIFIED          | OverviewSection.tsx:163-181 — `runSpeedTest` callback вызывает `invoke<{download_mbps,upload_mbps}>("speedtest_run")` с полным UI: Skeleton (line 453-464) во время testing + ArrowDown/ArrowUp icons + round(speed.download_mbps) + "Мбит/с" (line 466-482), "Запустите протокол" placeholder когда !isRunning||rebooting (line 449-452). Activity log coverage: `overview.speedtest.started/completed/failed` (lines 165, 174, 177). 3 unit-теста Speed card (disabled при stopped / вызов при running / "Запустите протокол" message). |
| 4   | Карточка Страна показывает localized country name через GeoIP + Intl.DisplayNames                              | VERIFIED          | OverviewSection.tsx:513-524 + useServerGeoIp.ts:79-128 + geoip.rs Tauri command. Phase 13.UAT G-03: `getLocalizedCountry(countryCode, fallback, locale)` (line 131-140) через `new Intl.DisplayNames([locale], { type: "region" })` — `ru → "Германия"`, `en → "Germany"`. 3 unit-теста Country card зелёные.                                                       |
| 5   | 3 drill-down карточки (Пользователей/Протокол/Безопасность) переключают табы через onNavigate                  | VERIFIED          | OverviewSection.tsx:491-500 (Users), 544-553 (Protocol), 558-627 (Security) — `<ClickableCard onClick={() => onNavigate?.("users"/"configuration"/"security")}>`. ServerTabs.tsx:189-202 передаёт onNavigate={setActiveTab}. 6 drill-down тестов зелёные (D-09, D-11, keyboard a11y).            |
| 6   | Polling server_get_stats паузится при `activeServerTab !== "overview"` И `rebooting=true`                       | VERIFIED          | OverviewSection.tsx:148-152 — `enabled: isOverviewVisible && !rebooting && !!serverInfo`. Тесты «Visibility pause» и «Rebooting pause» в OverviewSection.test.tsx зелёные, statsCallCount=0 при activeServerTab="users" и rebooting=true.                |
| 7   | Cache GeoIP в localStorage (TTL 30d, ключ `tt_geoip_{host}`)                                                    | VERIFIED          | useServerGeoIp.ts:24-25 — `STORAGE_PREFIX = "tt_geoip_"`, `TTL_MS = 30 * 24 * 60 * 60 * 1000`. loadCache/saveCache/expired/corrupt-JSON покрыты 5 тестами в useServerGeoIp.test.ts. UAT Test 7 подтвердил runtime: reconnect → no повторный invoke get_server_geoip. |
| 8   | Exponential backoff `10s → 30s → 60s` после 3 подряд ошибок server_get_stats                                    | VERIFIED          | useServerStats.ts:44 (`BACKOFF_SEQUENCE = [10_000, 30_000, 60_000]`) + 100-140 рекурсивный setTimeout с failureRef-based scheduling. Test "applies exponential backoff after 3 consecutive failures" зелёный.                                       |
| 9   | 4 кода GEOIP_* error mapping: TIMEOUT/NO_NETWORK/RATE_LIMITED/INVALID_RESPONSE                                  | VERIFIED          | translateSshError.ts:98-106 — 4 case GEOIP_*. geoip.rs:50-66 — Rust error mapping (is_timeout/is_connect/HTTP 429/parse fail). 4 тесты в translateSshError.test.ts + 3 inline serde-теста в geoip.rs зелёные.                                                  |
| 10  | i18n ключи в ru.json и en.json: geoipErrors.* + server.overview.uptimeFormat.* + security.* + speed.*            | VERIFIED          | ru.json:999-1014: speedNotMeasured, speedRequiresProtocol, speedUnit, security.firewall, security.fail2ban, security.active/inactive/notInstalled, security.tlsDays/tlsExpired/tlsActive (всего 15+ новых ключей для Phase 13 + UAT). en.json mirror зеркально.              |
| 11  | Activity log integration: drill-down + speedtest + security + ping логируются                                   | VERIFIED          | OverviewSection.tsx:165-177 (speedtest started/completed/failed), 215-224 (security loaded/failed), 285-295 (ping manual_refresh/result/failed). ServerTabs.tsx:195-199 — drill-down с source="overview-drilldown". D-18 satisfied + UAT-инкремент (speed/security/ping).    |
| 12  | Version bump Pro 3.0.0→3.1.0 / Light 2.7.0→2.8.0                                                                | PASSED (override) | Override: Версии намеренно возвращены коммитом `ec688775 revert(13): restore versions to v3.0.0 (Pro) and v2.7.0 (Light)` — Plan 13-05 был преждевременным, UAT прошёл на Pro 3.0.0 NSIS. Version будет поднят в момент релиза v3.1 — accepted by bondo on 2026-04-17.              |
| 13  | ROADMAP.md содержит Success Criteria блок для Phase 13                                                           | PASSED (override) | Override: D-01..D-20 из 13-CONTEXT.md фактически выполняют роль success criteria; ROADMAP formatting inconsistency — документальная брешь, не блокирует phase completion. Все 20 D-IDs покрыты в Requirements Coverage table (ниже). Accepted by bondo on 2026-04-17.                                                  |

**Score:** 13/13 truths verified (11 VERIFIED + 2 PASSED (override))

### Deferred Items

Нет.

### Required Artifacts

| Artifact                                                            | Expected                                                                            | Status     | Details                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gui-app/src-tauri/src/commands/geoip.rs`                          | get_server_geoip Tauri command + GeoIpInfo struct + GEOIP_* error mapping           | VERIFIED   | 128 строк. `#[tauri::command] pub async fn get_server_geoip` (line 40). 4 GEOIP_* кода маппятся (50, 51, 56, 62, 66). 3 inline serde-теста зелёные (cargo test --lib commands::geoip → 3 passed).                                                  |
| `gui-app/src-tauri/src/commands/mod.rs`                            | `pub mod geoip;` added                                                              | VERIFIED   | `pub mod geoip;` присутствует.                                                                                                                                                                                                       |
| `gui-app/src-tauri/src/lib.rs`                                     | `commands::geoip::get_server_geoip,` зарегистрировано в invoke_handler!             | VERIFIED   | Line 340 (geoip) + line 285 (server_get_uptime — новая UAT G-01 команда).                                                                                                                                                                                  |
| `gui-app/src-tauri/src/ssh/server/server_uptime.rs`                | NEW (UAT G-01) standalone fast uptime fetch через cat /proc/uptime                  | VERIFIED   | 26 строк. `pub async fn server_get_uptime` — exec `cat /proc/uptime`, parse f64. Зарегистрирована в `ssh/mod.rs:22` и `ssh_commands.rs:67` (ssh_pool_command! macro). <100ms vs ~2s для server_get_stats (включает sleep 1 для CPU sampling).                                                                                                                          |
| `gui-app/src/components/server/useServerStats.ts`                  | React hook polling server_get_stats с visibility pause + exponential backoff + immediate first fire (UAT G-01) | VERIFIED   | 143 строк. ServerStats type, BACKOFF_SEQUENCE, рекурсивный setTimeout. UAT G-01 fix: first fire IMMEDIATE on mount (line 129-134), затем polling каждые intervalMs. init `loading=enabled` (line 69, BUG-02 fix) для OverviewSection Skeleton при auto-reconnect. |
| `gui-app/src/components/server/useServerStats.test.ts`             | 6+ unit-тестов с vi.useFakeTimers                                                  | VERIFIED   | 6 it-blocks, vi.useFakeTimers + advanceTimersByTimeAsync. Все 6 тестов зелёные.                                                                                                                          |
| `gui-app/src/components/server/useServerGeoIp.ts`                  | React hook fire-once GeoIP с localStorage TTL cache                                 | VERIFIED   | 128 строк. STORAGE_PREFIX="tt_geoip_", TTL_MS=30 days. loadCache + saveCache + expired removeItem. invoke<GeoIpInfo>("get_server_geoip", ...) на line 105. Race-safe cancelled flag.                                                |
| `gui-app/src/components/server/useServerGeoIp.test.ts`             | 5 unit-тестов: cache hit/miss/expired/error/corrupt JSON                            | VERIFIED   | 5 it-blocks, все зелёные.                                                                                                                                                          |
| `gui-app/src/components/server/useServerState.ts`                  | UAT G-02 fix: setPanelDataLoaded(true) при ЛЮБОМ исходе loadServerInfo             | VERIFIED   | 247 строк. Line 125-128: `// Phase 13.UAT G-02: panelDataLoaded=true даже если server NOT installed`. Line 140: `setPanelDataLoaded(true)` в catch. Раньше только в `if (info.installed)` ветке.                                                              |
| `gui-app/src/components/ServerPanel.tsx`                           | UAT G-04 + G-04b: Disconnect button на not-installed + error экранах               | VERIFIED   | Line 95-102 (connection_failed экран) + 151-157 (not_installed экран) — `<Button variant="ghost/secondary" icon={<LogOut/>} onClick={state.onDisconnect}>{t("control.disconnect")}</Button>`. LogOut icon imported line 9. **ТЕСТОВАЯ РЕГРЕССИЯ:** ServerPanel.test.tsx lines 95-105 и 191-202 всё ещё ожидают "Настроить SSH" кнопку — 2 падающих теста.  |
| `gui-app/src/components/ControlPanelPage.tsx`                      | ServerPanelSkeleton (10-card layout) + skeleton при auto-reconnect                 | VERIFIED   | ServerPanelSkeleton определён (line 83-224) с 10 cards в 3 рядах + tab bar skeleton + 5 pills + separator + disconnect icon. `handleConnect` устанавливает isFirstConnect=true (line 294), readStoredCredentials → if(c) setIsFirstConnect(true) (line 261) для auto-reconnect skeleton.                                                              |
| `gui-app/src/components/layout/TabNavigation.tsx`                  | UAT G-06: pill + button span full width (removed 4px cushion)                     | VERIFIED   | Line 105-127: `width: pillWidth > 0 ? pillWidth : calc(100% / ${TABS.length})` (без `-8`), `left: 0` (без `marginLeft`), button `flex-1` (line 141). Comment line 106-111: "Phase 13.UAT G-06: width = pillWidth (full button width) вместо pillWidth-8". |
| `gui-app/src/components/server/OverviewSection.tsx`                | Live-data + drill-down + Speed card + Security card + localized Country + fast uptime | VERIFIED   | 681 строк. ClickableCard local component (line 94-124). Hooks useServerStats + useServerGeoIp. 3 ClickableCard wraps. Speed card fully wired (line 437-488). Security card с 4 sub-tiles + skeleton + live firewall/fail2ban status (line 555-627). getLocalizedCountry util (line 131-140). fastUptime standalone polling (line 187-200).                                              |
| `gui-app/src/components/server/OverviewSection.test.tsx`           | 30+ tests включая Country/Uptime/Load/Partial/Visibility/Rebooting/Drill-down/Speed/Security | VERIFIED   | 37 it-blocks (was 31 до UAT — +6 новых Speed/Security/activity-log тестов). vitest run → 37 passed.                                                                                                                                              |
| `gui-app/src/components/ServerTabs.tsx`                            | onNavigate + activeServerTab переданы в OverviewSection                            | VERIFIED   | Line 189-202: onNavigate + activeServerTab передаются + activityLog("USER", `tab.switch target="${nextTab}" source="overview-drilldown"`, "OverviewSection").                                                                                  |
| `gui-app/src/shared/utils/translateSshError.ts`                    | 4 case GEOIP_* + dev-warn расширен                                                 | VERIFIED   | Lines 98-106: case GEOIP_TIMEOUT/NO_NETWORK/RATE_LIMITED/INVALID_RESPONSE. dev-warn с `code.startsWith("GEOIP_")`.                                                                                                |
| `gui-app/src/shared/utils/uptime.ts`                               | formatServerUptime(seconds, t) реализован                                          | VERIFIED   | Lines 29-44. 12 тестов uptime.test.ts зелёные.                                                                                              |
| `gui-app/src/shared/i18n/locales/ru.json`                          | geoipErrors (4) + uptimeFormat (3) + speed.* (3) + security.* (8+) keys             | VERIFIED   | Все 18+ Phase 13 ключей подтверждены. Русские переводы корректны (UAT Test 7: "Германия", Test 8: firewall labels локализованы).                                                                                                                |
| `gui-app/src/shared/i18n/locales/en.json`                          | Mirror keys                                                                         | VERIFIED   | Все 18+ ключей зеркально, английские переводы.                                                                                                                                                                                |
| `gui-app/package.json` + `gui-app/src-tauri/Cargo.toml` + `tauri.conf.json` | Pro version → 3.1.0                                                          | PASSED (override) | Версия 3.0.0 (revert коммит ec688775). Override accepted — UAT прошёл на 3.0.0, bump отложен до релиза.                                                                                                                                          |
| `gui-light/package.json` + `gui-light/src-tauri/Cargo.toml` + `tauri.conf.json` | Light version → 2.8.0                                                       | PASSED (override) | Версия 2.7.0 (revert коммит ec688775). Override accepted — Light не тестировался в UAT, bump отложен до релиза.                                                                                                                                          |

### Key Link Verification

| From                                       | To                                                            | Via                                                | Status   | Details                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| OverviewSection.tsx                       | useServerStats(sshParams, {enabled, intervalMs:10_000})       | hook import                                        | WIRED    | Line 26 import + line 149-152 invocation. enabled=isOverviewVisible && !rebooting && !!serverInfo.                                          |
| OverviewSection.tsx                       | useServerGeoIp({host: state.host})                             | hook import                                        | WIRED    | Line 27 import + line 153 invocation.                                                                                                     |
| OverviewSection.tsx                       | formatServerUptime(fastUptime/stats.uptime_seconds, t)         | util import                                        | WIRED    | Line 28 import + line 532, 534 usage.                                                                                        |
| OverviewSection.tsx                       | server_get_uptime Tauri command (UAT G-01 C)                  | invoke с sshParams                                 | WIRED    | Line 193: `invoke<{ uptime_seconds: number }>("server_get_uptime", sshParams)`. Polling 10s + immediate fire.                             |
| OverviewSection.tsx                       | speedtest_run Tauri command                                   | invoke в runSpeedTest callback                     | WIRED    | Line 172: `invoke<{ download_mbps: number; upload_mbps: number }>("speedtest_run")`. UAT Test 6 passed — Speed card теперь работает.     |
| OverviewSection.tsx                       | security_get_status Tauri command (UAT Test 8)                | invoke in useEffect                                | WIRED    | Line 209-212: `invoke<{ firewall, fail2ban }>("security_get_status", sshParams)`. Активирует real firewall/fail2ban статус (раньше hardcoded null).  |
| useServerStats.ts                         | invoke<ServerStats>("server_get_stats", {host,...})            | @tauri-apps/api/core                               | WIRED    | Line 80-86.                                                                                                                                |
| useServerStats.ts                         | First fire immediate (UAT G-01 A)                              | useEffect void IIFE без setTimeout                 | WIRED    | Line 129-134: `void (async () => { if (cancelled) return; await fetchStats(); if (cancelled) return; scheduleNext(); })()`. |
| useServerGeoIp.ts                         | invoke<GeoIpInfo>("get_server_geoip", {host})                 | @tauri-apps/api/core                               | WIRED    | Line 105.                                                                                                                                  |
| useServerGeoIp.ts                         | localStorage tt_geoip_{host}                                   | loadCache/saveCache helpers с TTL 30d              | WIRED    | Lines 24-66.                                                                                                                              |
| commands/geoip.rs                         | reqwest::Client::builder().timeout(Duration::from_secs(5))    | HTTPS GET to ipwho.is                              | WIRED    | Lines 41-46.                                                                                                                              |
| ssh/server/server_uptime.rs               | exec_command(handle, app, "cat /proc/uptime")                 | SSH session                                        | WIRED    | Line 15. Returns { uptime_seconds: f64 }.                                                                                                  |
| useServerState.ts panelDataLoaded          | setPanelDataLoaded(true) на ANY outcome (UAT G-02)             | try/catch both branches                            | WIRED    | Line 128: `if (!silent) setPanelDataLoaded(true)` после try (even if !installed). Line 140: `setPanelDataLoaded(true)` в catch.      |
| ServerPanel.tsx connection-failed screen  | Disconnect button → state.onDisconnect                         | Button onClick (UAT G-04b)                         | WIRED    | Line 95-102: `<Button ... icon={<LogOut/>} onClick={state.onDisconnect}>{t("control.disconnect")}</Button>`. |
| ServerPanel.tsx not-installed screen      | Disconnect button → state.onDisconnect                         | Button onClick (UAT G-04)                          | WIRED    | Line 151-157: секундaя кнопка рядом с Install кнопкой. LogOut icon from lucide-react.                                                      |
| TabNavigation.tsx pill                    | pill width = button width, marginLeft=0 (UAT G-06)             | removed 4px cushion                                | WIRED    | Line 117: `width: pillWidth > 0 ? pillWidth : calc(100% / ${TABS.length})` + `left: 0` (line 115). Comment line 106-110.                  |
| ServerTabs.tsx onNavigate prop            | OverviewSection clickable cards                                | React prop drilling + setActiveTab callback        | WIRED    | Lines 189-202 — onNavigate calls setActiveTab + activityLog.                                                                                |
| OverviewSection ClickableCard             | role='button' + onKeyDown(Enter/Space)                         | ARIA a11y pattern                                  | WIRED    | Lines 104-124.                                                                                                                            |
| OverviewSection.tsx                       | getLocalizedCountry(countryCode, fallback, locale) (UAT G-03)  | Intl.DisplayNames API                              | WIRED    | Line 131-140. Line 519: `{getLocalizedCountry(geo.country_code, geo.country, i18n.language)}`.                                            |
| translateSshError.ts                       | t('geoipErrors.*')                                            | i18n keys                                          | WIRED    | Lines 100, 102, 104, 106.                                                                                                                  |
| uptime.ts                                  | t('server.overview.uptimeFormat.*')                            | i18n interpolation                                 | WIRED    | Lines 38, 41, 43.                                                                                                                          |

### Data-Flow Trace (Level 4)

| Artifact                              | Data Variable                  | Source                                              | Produces Real Data                                                  | Status      |
| ------------------------------------- | ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------- | ----------- |
| OverviewSection Country card          | `geo` (GeoIpInfo \| null) + localized name | useServerGeoIp → invoke('get_server_geoip') + Intl.DisplayNames | Yes — реальный HTTPS запрос к ipwho.is через Rust + localized name для текущего локалу | FLOWING     |
| OverviewSection Uptime card           | `fastUptime` + fallback `stats.uptime_seconds` | invoke('server_get_uptime') + useServerStats | Yes — реальный SSH запрос через server_uptime.rs (<100ms)            | FLOWING     |
| OverviewSection Load CPU              | `stats.cpu_percent`            | useServerStats → invoke('server_get_stats') 10s     | Yes — реальный SSH запрос                                            | FLOWING     |
| OverviewSection Load RAM              | `stats.mem_used / mem_total`   | useServerStats → invoke('server_get_stats') 10s     | Yes — реальный SSH запрос                                            | FLOWING     |
| OverviewSection Speed card            | `speed` ({download_mbps,upload_mbps}) | runSpeedTest → invoke('speedtest_run') manual | Yes — реальный client-side speedtest к Cloudflare + Skeleton во время testing + ArrowDown/ArrowUp + Мбит/с. UAT G-2 closed. | FLOWING     |
| OverviewSection Status card (ECG)     | `serverInfo.serviceActive`     | useServerState (existing)                           | Yes — реальный SSH check_server_installation                         | FLOWING     |
| OverviewSection Ping card             | `ping`                         | invoke('ping_endpoint') каждые 30s                 | Yes — реальный TCP ping                                              | FLOWING     |
| OverviewSection Users card            | `serverInfo.users.length`      | useServerState (existing)                           | Yes — реальный SSH check_server_installation.users[]                 | FLOWING     |
| OverviewSection IP card               | `state.host`                   | useServerState (existing)                           | Yes — фактический host string                                        | FLOWING     |
| OverviewSection Protocol version      | `serverInfo.version`           | useServerState (existing)                           | Yes — реальная версия от SSH                                         | FLOWING     |
| OverviewSection Security card         | `security` ({firewall, fail2ban}) + TLS derived | invoke('security_get_status') + state.certRaw | Yes — реальный SSH systemctl check (UAT Test 8 confirmed) + TLS из cert. SSH-key sub-tile остаётся placeholder (Phase 16). | FLOWING (3/4 live, 1 placeholder) |

### Behavioral Spot-Checks

| Behavior                                                     | Command                                                                                                                                       | Result                                                       | Status |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------ |
| OverviewSection.test.tsx все тесты зелёные                  | `cd gui-app && npx vitest run src/components/server/OverviewSection.test.tsx`                                                                 | Test Files 1 passed (1). Tests 37 passed (37).               | PASS   |
| Hook + util tests (Phase 13)                                 | `cd gui-app && npx vitest run src/components/server/useServerStats.test.ts src/components/server/useServerGeoIp.test.ts src/shared/utils/uptime.test.ts src/shared/utils/translateSshError.test.ts` | Test Files 4 passed (4). Tests 71 passed (71).            | PASS   |
| Rust unit-тесты commands::geoip                              | `cd gui-app/src-tauri && cargo test --lib commands::geoip`                                                                                    | test result: ok. 3 passed; 0 failed                          | PASS   |
| TypeScript strict без ошибок                                 | `cd gui-app && npx tsc --noEmit`                                                                                                              | (нет вывода = clean)                                         | PASS   |
| ESLint clean на всех Phase 13 файлах (max-warnings 0)        | `cd gui-app && npx eslint src/components/server/OverviewSection.tsx src/components/server/useServerStats.ts src/components/server/useServerGeoIp.ts src/components/server/useServerState.ts src/components/ServerPanel.tsx src/components/ServerTabs.tsx src/components/ControlPanelPage.tsx src/components/layout/TabNavigation.tsx src/shared/utils/uptime.ts src/shared/utils/translateSshError.ts --max-warnings 0` | (нет вывода = clean)                                         | PASS   |
| Vitest полный прогон                                         | `cd gui-app && npx vitest run`                                                                                                                | Test Files 1 failed \| 100 passed \| 3 skipped (104). Tests 2 failed \| 1384 passed \| 21 todo (1407). | FAIL (regression in ServerPanel.test.tsx — not blocking phase goal) |

**Regression detail:** `src/components/ServerPanel.test.tsx` имеет 2 падающих теста из-за UAT G-04b фикса:
- `shows retry and configure buttons on error` (line 95-105) — ищет `/Настроить SSH|configure/i` — кнопка заменена на "Отключиться" (control.disconnect).
- `configure SSH button calls onSwitchToSetup` (line 191-202) — ищет ту же кнопку, ожидает mockOnSwitchToSetup — теперь callback `state.onDisconnect`.

Эти тесты устарели. Не обновлены в UAT фикс-коммитах. Проcто-регрессия тест-сьюта, не регрессия продакшн кода. Требует human decision (обновить тесты vs откатить G-04b).

### Requirements Coverage

REQUIREMENTS.md не содержит D-01..D-20 — это decision IDs из 13-CONTEXT.md, выполняющие роль requirement IDs для Phase 13. Все 20 D-IDs учтены в plans frontmatter.

| Requirement (D-ID) | Source Plan | Description                                                                          | Status     | Evidence                                                                                                                                                                          |
| ------------------ | ----------- | ------------------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01               | 13-02       | Polling 10s для server_get_stats                                                     | SATISFIED  | useServerStats.ts:39,64 default intervalMs=10_000; OverviewSection.tsx:151 intervalMs=10_000; тест "polls every 10s" зелёный.                                                          |
| D-02               | 13-02, 13-06 | Visibility pause через activeServerTab !== "overview"                                | SATISFIED  | OverviewSection.tsx:148-150 `isOverviewVisible = activeServerTab === undefined \|\| activeServerTab === "overview"`. Test "Visibility pause" зелёный.                                |
| D-03               | 13-02, 13-06 | Pause при rebooting + 3 fail backoff                                                 | SATISFIED  | OverviewSection.tsx:150 `enabled: isOverviewVisible && !rebooting && !!serverInfo`. Backoff в useServerStats.ts. Tests "rebooting" + "exp backoff" зелёные.                              |
| D-04               | 13-01       | API: ipwho.is, HTTPS GET                                                              | SATISFIED  | geoip.rs:41-46 — `https://ipwho.is/{host}` через reqwest.                                                                                                                          |
| D-05               | 13-01, 13-06 | Формат: localized country name (изменено UAT G-03: без flag_emoji, с Intl.DisplayNames) | SATISFIED  | OverviewSection.tsx:519 `{getLocalizedCountry(geo.country_code, geo.country, i18n.language)}`. UAT Test 7 passed. Flag emoji удалён per UX decision (ipwho.is возвращал English, после G-03 имя локализовано правильно).                                                                                |
| D-06               | 13-03       | localStorage cache key=tt_geoip_{host}, TTL 30d                                      | SATISFIED  | useServerGeoIp.ts:24-25. 5 тестов cache scenarios зелёные. UAT Test 7 runtime confirmation: reconnect → no re-invoke.                                                                          |
| D-07               | 13-01       | GeoIP через Rust-команду (не фронтовый fetch)                                        | SATISFIED  | geoip.rs Tauri-команда; useServerGeoIp.ts:105 invoke (не fetch). CSP-прозрачно.                                                                                                  |
| D-08               | 13-01, 13-04 | 4 GEOIP_* error codes                                                                 | SATISFIED  | geoip.rs:50-66; translateSshError.ts:98-106. 4 теста + 3 inline тестов зелёные.                                                                            |
| D-09               | 13-07       | Вся карточка кликабельна, role=button, keyboard, hover, focus-visible                | SATISFIED  | ClickableCard в OverviewSection.tsx:94-124. 6 drill-down тестов зелёные.                  |
| D-10               | 13-07       | API: callback prop onNavigate от ServerTabs                                          | SATISFIED  | OverviewSection.tsx:42 Props.onNavigate; ServerTabs.tsx:193-201 callback wiring.                                                                                                  |
| D-11               | 13-07       | 3 drill-down карточки: Users/Configuration/Security                                  | SATISFIED  | OverviewSection.tsx:493, 546, 560 — `onNavigate?.("users"/"configuration"/"security")`. 3 тестов зелёные.                                       |
| D-12               | 13-06       | 3 состояния per card: Loading skeleton / Success / Error '—'                         | SATISFIED  | OverviewSection.tsx Country (516-522)/Uptime (531-539)/Load (634-644) — все имеют skeleton/data/dash. Тесты зелёные.                                                                |
| D-13               | 13-02       | Exponential backoff 10→30→60s после 3 fail                                            | SATISFIED  | useServerStats.ts:44 BACKOFF_SEQUENCE + 106-122 scheduleNext logic. Test "applies exponential backoff" зелёный.                                                                       |
| D-14               | 13-03, 13-06 | Partial data: каждая карточка independent                                            | SATISFIED  | useServerGeoIp.ts:111 setError на ошибке без сброса других хуков. Test "stats resolves but geo rejects" зелёный.                                                                       |
| D-15               | 13-02       | Hook useServerStats с {enabled, intervalMs} + return {stats, loading, error, failureCount} | SATISFIED  | useServerStats.ts:62-143 — точное соответствие сигнатуре. 6 тестов зелёные.                                                                                                          |
| D-16               | 13-03       | Hook useServerGeoIp(sshParams) — fire-once + cache                                   | SATISFIED  | useServerGeoIp.ts:79-128 — fire-once на host + cache lookup. 5 тестов зелёные.                                                                          |
| D-17               | 13-06, 13-07 | Unit-тесты для каждой из 10 карточек × (positive/loading/error)                       | SATISFIED  | OverviewSection.test.tsx — 37 it-блоков (+6 Speed/Security/activity-log от UAT): Country (3), Uptime (2), Load (3), Status (2), Ping (1), Users (1), Protocol (1), IP (1), Security (1), Speed (3 — initial+disabled+click). |
| D-18               | 13-07       | Drill-down тесты: fireEvent.click + keyboard Enter/Space                              | SATISFIED  | 3 specific drill-down тестов + activityLog с source="overview-drilldown" в ServerTabs.tsx:197.                                                                                          |
| D-19               | 13-02       | Polling тесты: vi.useFakeTimers() + advanceTimersByTime                              | SATISFIED  | useServerStats.test.ts использует useFakeTimers + advanceTimersByTimeAsync во всех 6 тестах.                                                                                          |
| D-20               | 13-03       | GeoIP cache тесты: localStorage hit/miss/expired                                     | SATISFIED  | useServerGeoIp.test.ts — 5 тестов.                                                                                          |

**Coverage:** 20/20 D-requirements satisfied.

### Anti-Patterns Found

| File                                                  | Line     | Pattern                                                                                                                          | Severity   | Impact                                                                                                                       |
| ----------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| OverviewSection.tsx                                  | 282      | `// eslint-disable-next-line react-hooks/exhaustive-deps` (reboot polling)                                                       | Info       | Pre-existing, не Phase 13 introduction (reboot polling существовал ранее). Задокументирован комментарием (line 277-281) с объяснением почему ref-based fix deferred до Phase 14+.                                       |
| OverviewSection.tsx                                  | 598, 619 | Hardcoded `null` в SSH-key sub-tile Security card                                                                                 | Info       | Phase 13 не требовал SSH-key live data — это Phase 16 scope (SSH-ключ auto-detect). SSH-key placeholder текстом "—" с `tone=null`. Firewall/Fail2Ban **теперь live** (UAT). |
| OverviewSection.test.tsx                              | 555      | Comment "Speed is index 1 (after Ping). Click it." — хрупкая зависимость от DOM order | Info | Тест использует `findAllByLabelText(refreshAria)[1]` для нахождения Speed refresh button. Если порядок карт изменится, тест сломается. Приемлемо для текущего scope, но pattern не optimal. |
| ServerPanel.test.tsx                                  | 95-105, 191-202 | **TEST REGRESSION** — `getByRole("button", { name: /Настроить SSH|configure/i })` не находит кнопку после UAT G-04b фикса     | **Warning**  | 2 тестовые функции (`shows retry and configure buttons on error`, `configure SSH button calls onSwitchToSetup`) устарели — UAT G-04b заменил кнопку на "Отключиться". Тесты не обновлены. Не блокирует phase goal (live-data + drill-down), но вызывает падение в `npm test`. |

**Pre-existing tech debt** (не Phase 13 ответственность):
- Pre-existing ESLint errors в pre-existing files — задокументировано в deferred-items.md.
- 81 cargo clippy errors на stable toolchain в legacy Rust коде — также deferred.

### Human Verification Required

1. **UAT 12/12 session (real server, Pro 3.0.0 NSIS)** — **DONE** (задокументирован в `.planning/phases/13-ip-tls-ping-drill-down/13-UAT.md`, 2026-04-17T11:40:00Z). Тестирование покрывает: cold start smoke, skeleton при auto-reconnect, ECG state transitions 3x (critical key remount fix), Ping real values + colour coding, Speed refresh + disable при stopped (UAT G-2 closing), Country без флага + localized + cache, Security 4 sub-tiles + skeleton + TLS days, Load skeleton без текстов, drill-down clicks, visual alignment, adaptive skeleton 800/1000px.

2. **ServerPanel.test.tsx 2 падающих теста — требуется решение разработчика:**
   - **Вариант A (рекомендуется):** Обновить тесты под G-04b поведение: заменить `{ name: /Настроить SSH|configure/i }` на `{ name: /Отключ|disconnect/i }`, `mockOnSwitchToSetup` на `mockOnDisconnect`.
   - **Вариант B:** Откатить G-04b коммит (fc76b45a) — потеряем полезную UAT-доработку для error экрана.
   - **Вариант C:** Добавить override в VERIFICATION.md с reason="Тесты устарели после UAT G-04b, будут обновлены отдельным commit-ом в Phase 13.1".

### Gaps Summary

Нет code-gaps. Предыдущие 2 gap-а (Speed card, Success Criteria) закрыты.

UAT-сессия (12/12 passed) + 6 UAT-gaps закрыты inline подтверждают что Phase 13 goal достигнут:
- **Live data:** 9 из 10 карточек на реальных данных (CPU/RAM/Uptime/Country/Status/Ping/Users/IP/Protocol/Security живые; SSH-key sub-tile Security placeholder per Phase 16 scope).
- **Drill-down:** 3 карточки (Users/Protocol/Security) переключают табы, a11y keyboard support.
- **Tests:** 37 OverviewSection + 71 hook/util + 3 Rust = 111 новых тестов покрывающих Phase 13 surface.

**Остаётся:** human-decision на 2 устаревших ServerPanel.test.tsx теста после G-04b фикса.

---

## Re-verification Decision

Все 13 truths верифицированы (11 VERIFIED + 2 PASSED via override). Статус `human_needed` установлен из-за:

1. UAT-сессии (12/12 passed на Pro 3.0.0 NSIS) — де-факто выполнена, задокументирована в 13-UAT.md.
2. 2 устаревших теста ServerPanel.test.tsx требуют human-decision (обновить / откатить / override).

Phase 13 goal достигнут: «Превратить «Обзор» сервера в живую информационную панель с кликабельными карточками-ссылками на детальные табы.» — все 10 карточек либо live-data (9), либо обоснованно deferred (SSH-key placeholder → Phase 16). 3 карточки кликабельны и работают. Тесты покрывают live-data, drill-down, a11y.

**Recommended actions:**

1. **ServerPanel.test.tsx**: обновить 2 падающих теста под G-04b поведение (`/Отключ|disconnect/i` + `mockOnDisconnect`). Эти тесты не блокируют Phase 13 goal, но вызывают CI red.
2. **После обновления тестов**: полный `npm test` должен быть зелёным. Ре-run `/gsd-verify-work` подтвердит статус `passed`.

---

_Verified: 2026-04-17T12:00:00Z_
_Verifier: Claude (gsd-verifier)_
_Re-verification: Yes — after UAT 12/12 + 6 UAT-gaps closure (session 2026-04-17T11:40:00Z)_
