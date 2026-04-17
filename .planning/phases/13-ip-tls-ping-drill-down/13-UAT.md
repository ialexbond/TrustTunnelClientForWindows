---
status: passed
phase: 13-ip-tls-ping-drill-down
source:
  - 13-01-SUMMARY.md
  - 13-02-SUMMARY.md
  - 13-03-SUMMARY.md
  - 13-04-SUMMARY.md
  - 13-05-SUMMARY.md
  - 13-06-SUMMARY.md
  - 13-07-SUMMARY.md
started: 2026-04-17T11:40:00Z
updated: 2026-04-17T11:40:00Z
---

## Current Test

[all 12 tests passed — UAT session complete]

## Tests

### 1. Cold Start Smoke Test
expected: Установить Pro 3.0.0 NSIS, запустить. Приложение открывается без crash-ов, без ошибок. При наличии stored SSH credentials — auto-reconnect начинается автоматически.
result: pass

### 2. Skeleton при auto-reconnect
expected: Сразу после запуска (со stored creds) в течение 1-3 секунд виден ServerPanelSkeleton — 10 skeleton карточек в layout OverviewSection + tab bar (5 pills + separator + disconnect icon). Полноэкранный Loader2 spinner "Проверка..." НЕ должен появляться. После загрузки skeleton сменяется реальной OverviewSection без вспышки.
result: pass
notes: Skeleton работает корректно. Пользователь отметил concern по loading time Uptime+Load (cards приходят последними, ~10-12 секунд) — записан в Gaps как performance issue G-01.

### 3. Status card ECG при running
expected: VPN-протокол активен. Карточка "Статус протокола" показывает зелёную анимированную ECG-линию с зигзагами. Голова (яркая часть) движется СЛЕВА НАПРАВО. Хвост (тусклая часть) тянется слева от головы. Текст "Работает" под анимацией.
result: pass

### 4. Status ECG state transitions (критично — key remount fix)
expected: Переключить VPN-протокол running → stopped → running минимум 3 раза подряд. При каждом переключении ECG-анимация корректно пересинхронизируется (key remount). Running = зелёный pulse с zigzags, stopped = красная flatline. В обоих состояниях движение слева направо, head справа, tail слева. НЕТ рассогласования head/tail.
result: pass

### 5. Ping real value + disable при stopped
expected: При running — Ping показывает числовое значение в ms (5-300), цвет соответствует latency (<100 green / <300 warning / ≥300 danger). В отдельном cmd `tcping server 443` показывает близкое значение (±10ms). Refresh кнопка видна в title карточки. При stopped — Ping "—" muted, refresh КНОПКА НЕ ВИДНА.
result: pass

### 6. Speed card refresh + disable
expected: При running — Speed card имеет refresh кнопку. Клик → skeleton (circle+line×2 с divider) → результат "↓ N Мбит/с | ↑ M Мбит/с" с цветными иконками (↓ зелёная, ↑ оранжевая). Если VPN-клиент подключён, значение отражает реальный VPN throughput. При stopped — refresh кнопка НЕ видна, карточка показывает "Запустите протокол".
result: pass

### 7. Country без флага + localStorage cache
expected: Country card показывает ТОЛЬКО название страны (например "Germany" или "Германия"), БЕЗ флага-emoji. При reconnect к тому же серверу — значение появляется мгновенно (cache hit из localStorage tt_geoip_<host>, TTL 30 дней). Нет повторного invoke get_server_geoip.
result: pass
notes: |
  Concern от пользователя: при ru locale страна была на английском (ipwho.is
  возвращает English only). Fix применён: Intl.DisplayNames переводит
  country_code → localized name (ru → "Германия", en → "Germany"). Native
  browser API, fallback на geo.country если не сработает.
  Дополнительно обнаружен критический BUG (G-02): при коннекте к серверу без
  установленного TrustTunnel — skeleton hangs forever. Fix применён:
  setPanelDataLoaded(true) теперь вызывается при ЛЮБОМ исходе (installed/
  not-installed/error), не только при installed.

### 8. Security card — 4 sub-tiles + skeleton + TLS days
expected: Security card первые 1-3 секунды показывает skeleton (2×2 grid из 4 placeholder tiles). После загрузки security_get_status: Firewall/Fail2Ban — green/red по real status (active/inactive/notInstalled), SSH-key остаётся placeholder "—" (не реализовано до Phase 16), TLS — "N дн." с 3-state цветом (>14 green / 8-14 warning / 1-7 danger / ≤0 "Истёк").
result: pass
notes: |
  User obnaruzhil G-04: на "Не установлен" экране не было кнопки выйти. Fix
  применён — добавлен secondary Disconnect button рядом с Install кнопкой.

### 9. Load card skeleton без CPU/RAM текста
expected: Закрыть и открыть Pro app (force re-mount OverviewSection). Первые ~2 секунды (после G-01 fix) в Load card ВИДЕН только skeleton: 2 ряда (label-skeleton + value-skeleton + progress-bar-skeleton). НЕТ текстов "CPU" / "RAM" в skeleton state. После прихода первого fetch — видны "CPU N%" (зелёный bar) и "RAM used / total МБ" (accent bar).
result: pass
notes: |
  Отмечен G-05 (minor): когда speedtest падает или недоступен, Speed card
  показывает "Не измерялась" (плейсхолдер для initial state). Лучше было
  бы различать: initial → "Не измерялась", failed → "—" или error text.
  Юзер сказал "пускай пока так будет, тест проходит" — deferred в backlog.

### 10. Drill-down clicks — 3 карточки переходят на табы
expected: Hover на карточках "Пользователей" / "Версия протокола" / "Безопасность" — появляется ChevronRight справа в title + focus-ring (cursor pointer). Клик на каждой — переход на соответствующий таб (users / configuration / security). Остальные 7 карточек НЕ кликабельны (нет ChevronRight, click не даёт эффекта).
result: pass

### 11. Visual alignment — tab separator + bottom nav = одна ширина
expected: При любой ширине окна (800-1000px) левый край серверного tab bar (Обзор) = левый край первой кнопки bottom navigation (Control) = отступ px-6 от края окна. То же для правых краёв. Визуально образуются вертикальные линии слева/справа по всей высоте интерфейса.
result: pass
notes: |
  Обнаружено G-06 во время теста (вертикальные линии не совпадали —
  TabNavigation pill имел 4px cushion). Fix применён — pill + button span
  теперь full width, aligned с краями nav wrapper.

### 12. Adaptive skeleton — 800/1000px
expected: При auto-reconnect skeleton менять ширину окна между 800 / 1000px. 800px: 2-2-3-2-1 layout (5 рядов, карточки узкие). 1000px: 3-4-2-1. UI capped на 1000 — шире проверять нечего. Карточки пластично заполняют ряды (нет большого пустого пространства).
result: pass
notes: |
  User fixed wording inconsistency (было 1200 упомянуто в expected, хотя
  UI capped 1000 — нечего проверять шире). Adaptive layout работает
  корректно на 800 и 1000px.

## Summary

total: 12
passed: 12
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

### G-01: Uptime + Load карточки приходят 10-12 секунд после auto-reconnect
severity: minor (performance)
source: Test 2 (Skeleton при auto-reconnect) — user observation
reason: |
  useServerStats hook делает first fire ЧЕРЕЗ intervalMs (10s), не immediate
  (13-02-SUMMARY: "First fire: planned at intervalMs, NOT immediate. Tests rely
  on settleAndTick"). Плюс сам server_get_stats bash-команда содержит `sleep 1`
  для CPU % sampling (два /proc/stat snapshot с delay 1s). Итого:
  - 10s wait до первого fetch
  - 1.5-2.5s на выполнение SSH-команды
  - Итог: Uptime/CPU/RAM появляются через ~12s после mount
suggested_fix: |
  (A) Fire first fetch immediately on mount в useServerStats, затем продолжать
      polling каждые intervalMs. Нужно обновить unit-тесты (не полагаться
      на delayed first fire).
  (B) Опционально: убрать `sleep 1` в CPU sampling — либо single /proc/stat
      sample (менее точно первые 10s), либо хранить prev-sample в Rust SshPool
      state и считать delta между polls. -1s latency на каждый request.
  (C) Опционально: вынести Uptime из server_get_stats в отдельный быстрый
      `/proc/uptime` SSH-exec (<100ms) — Uptime появится практически сразу.
scope: 13.1 (gap closure) либо Phase 14+

### G-05: Speed card показывает "Не измерялась" при failed measurement
severity: minor (UX clarity)
source: Test 9 observation — user увидел что speedtest не срабатывает
reason: |
  Текущая логика: `speed === null` → показывает `{t("server.overview.speedNotMeasured")}`.
  Это корректно для initial state, но запутывает после failed attempt:
  юзер кликнул refresh, увидел skeleton, потом опять "Не измерялась" как
  будто не пробовали. Лучше различать:
  - Initial (not run yet) → "Не измерялась"
  - Failed after attempt → "—" (dash muted)
  - Network error → "Ошибка замера"
suggested_fix: |
  Добавить speedError state в OverviewSection runSpeedTest catch:
  setSpeedError(formatError(e)). Render branch:
  - speedError → "—" + optional error tooltip
  - !speed && !speedError → "Не измерялась" (initial)
scope: 13.1 (gap closure)
