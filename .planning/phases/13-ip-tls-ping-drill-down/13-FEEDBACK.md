---
status: open
phase: 13-ip-tls-ping-drill-down
source: manual UAT (user runtime testing on real server)
created: 2026-04-17
---

# Phase 13 — Post-Build UAT Feedback

Документ собран после ручного тестирования собранного Pro 3.0.0 NSIS installer.

---

## Bugs (требуют фикса в Phase 13.1)

### BUG-01 — Полноэкранный лоадер вместо ServerPanelSkeleton при auto-reconnect

**Симптом:** при запуске приложения с уже сохранёнными SSH credentials отображается полноэкранный спиннер `Loader2 + "Проверка..."` вместо скелетона со всеми карточками OverviewSection в состоянии skeleton.

**Root cause:** [`ControlPanelPage.tsx:131`](gui-app/src/components/ControlPanelPage.tsx:131) — `isFirstConnect` инициализируется как `false` и устанавливается в `true` только в `handleConnect` (когда юзер вручную жмёт Connect). При восстановлении кредов из storage (`readStoredCredentials`) флаг остаётся `false` → `<ServerPanelSkeleton />` пропускается → рендерится `<ServerPanel>` → его внутренний `state.loading` показывает полноэкранный спиннер ([`ServerPanel.tsx:54-60`](gui-app/src/components/ServerPanel.tsx:54)).

**Fix:** в `useEffect` инициализации (строки 144-149) после успешного `readStoredCredentials`, если creds есть — `setIsFirstConnect(true)`. Сбрасывать в `false` после `panelDataLoaded` (event from useServerState).

**Acceptance:**
- При запуске со stored creds первые 1-3 секунды показан `ServerPanelSkeleton` (как в Storybook story `Loading`)
- Полноэкранный лоадер `state.loading` в ServerPanel НЕ показывается в этом сценарии
- Storybook `Loading` story остаётся single source of truth для дизайна skeleton

---

### BUG-02 — Карточка «Нагрузка» не показывает skeleton во время первичной подгрузки

**Симптом:** после открытия приложения CPU/RAM показывают «—» секунд 10, потом резко появляется значение. Skeleton не виден.

**Root cause:** [`useServerStats.ts:115-125`](gui-app/src/components/server/useServerStats.ts:115) — first fire запланирован через `intervalMs` (default 10s), не immediate. Initial state: `stats=null, loading=false`. В OverviewSection ([`OverviewSection.tsx:416,429`](gui-app/src/components/server/OverviewSection.tsx:416)) условие `stats === null && statsLoading` — оба false первые 10s, показывает «—».

**Конфликт требований:**
- Дизайн от 13-02-PLAN: «first fire через intervalMs» (для cleaner unit-тестов с `vi.useFakeTimers`)
- UX expectation: «при первой загрузке — skeleton, не плейсхолдер»

**Fix (вариант A — рекомендуемый):** ввести флаг `hasEverFetched: boolean` (через useRef). Условие в OverviewSection: `!hasEverFetched ? <Skeleton /> : stats ? <value> : <—>`. Skeleton показывается до первого успешного ответа, потом — реальные данные. Subsequent refresh при stale-while-revalidate тоже без skeleton (значение не «прыгает»).

**Fix (вариант B):** в useServerStats при `enabled=true` сделать immediate first fire + продолжать polling через intervalMs. Потребует обновить unit-тесты useServerStats.test.ts.

**Acceptance:** при первом монтировании карточки Нагрузка skeleton виден до прихода первых stats. Skeleton НЕ мигает при последующих refresh.

---

### BUG-04 — Заголовок карточки «Статус» неоднозначный

**Симптом:** карточка с ECG-анимацией называется просто «Статус». Юзер не понимает: это статус протокола, статус сервера, или что? Aptime отдельной карточкой уже показывает uptime операционки сервера.

**Подтверждение что это статус протокола:** [`OverviewSection.tsx:248`](gui-app/src/components/server/OverviewSection.tsx:248) — `isRunning = serverInfo.serviceActive`. Это поле возвращается из `systemctl is-active trusttunnel.service` через SSH. То есть карточка отражает живость **VPN-сервиса** (демона), а не сервера в целом.

**Fix:** переименовать i18n-ключ `server.overview.cards.status` ([`ru.json:987`](gui-app/src/shared/i18n/locales/ru.json:987)):
- ru: «Статус» → «Статус протокола» (или короче «Протокол»)
- en: «Status» → «Protocol status» (или «Protocol»)

**Acceptance:** заголовок карточки явно отделяет «здоровье VPN-сервиса» от «uptime сервера».

---

### BUG-03 — Карточка «Безопасность»: 3 из 4 пунктов серые прочерки, hover «съедает» цвет

**Симптом:** TLS показывает «активен» зелёным, остальные (Firewall, Fail2Ban, SSH-key) — серым прочерком («—»). При hover вся карточка приобретает focus-ring, но серые пункты выглядят «потускневшими».

**Root cause:** [`OverviewSection.tsx:386-388`](gui-app/src/components/server/OverviewSection.tsx:386) — для firewall/fail2ban/sshKey hardcoded `ok: null`, что даёт `bg = bg-elevated, color = text-muted`. Проверка реально только для TLS (через `state.serverInfo`).

**Это intentional descope** в Phase 13 — реальные проверки firewall/fail2ban/SSH-key запланированы на Phase 16 (`firewall-modal-fail2ban-ssh-auto-detect-tls-cert`).

**Fix early (если хочется в 13.1):**
- Firewall: проверка `ufw status` через SSH (есть Rust-команда?)
- Fail2Ban: проверка `systemctl is-active fail2ban`
- SSH-key: проверка `~/.ssh/authorized_keys` непустой
- TLS: уже работает

**Если откладываем до Phase 16** — можно временно убрать прочерки и показывать просто иконку/badge «Не настроено» нейтрального цвета без bg-tint, чтобы hover не давал psychological «съедания».

---

## Questions (ответы)

### Q1 — Пинг меняется моментально, это рандом?

**Нет, реальное измерение.** Backend [`network.rs:93-115`](gui-app/src-tauri/src/commands/network.rs:93) — `ping_endpoint(host, port=443)`:
1. Резолвит DNS host:443 в SocketAddr (вне таймера)
2. Запускает `tokio::time::Instant::now()`
3. `tokio::net::TcpStream::connect(addr)` с timeout 5s
4. Возвращает `elapsed.as_millis() as i64` (или -1 если unreachable)

Это **только TCP handshake latency**, без HTTPS, без TLS, без DNS. На близких серверах (тот же дата-центр / страна) типично 5-30ms. На дальних — 100-300ms.

**Почему «прошлые версии» казались медленнее:**
- Раньше тот же экран мог использовать `health_check` ([`network.rs:60`](gui-app/src-tauri/src/commands/network.rs:60)) — это **HTTP GET /_check через HTTPS** с полным TLS handshake. Это 100-500ms даже на быстром сервере.
- Текущий ping_endpoint — чистый TCP connect, типично в 10-30 раз быстрее.

**Если хочешь убедиться** — параллельно в `cmd`:
```
ping -n 1 your-server.com           # ICMP ping (RTT)
tcping your-server.com 443          # TCP ping на порт 443 (если установлен)
```
Сравни значения. Должны быть в той же ballpark с тем что показывает приложение (±10ms допустимо из-за разных net stack'ов).

**Если хочется визуальной задержки** для UX confidence (типа «измеряем...») — можно добавить искусственный 200-300ms loading state с спиннером перед показом результата. Но это косметика, не баг.

### Q2 — Speed test не работает, почему?

**Intentional descope в Phase 13.** Backend `speedtest_run` существует и работает (вызывается в [`useDashboardState.ts:134`](gui-app/src/components/dashboard/useDashboardState.ts:134)). Но в OverviewSection ([`OverviewSection.tsx:307`](gui-app/src/components/server/OverviewSection.tsx:307)) кнопка refresh у Speed-карточки имеет `onRefresh={() => {}}` (no-op) и плейсхолдер «Не измерялась».

Это явно отмечено в [13-07-SUMMARY.md](.planning/phases/13-ip-tls-ping-drill-down/13-07-SUMMARY.md) как "Speedtest UI integration (deferred, Plan 14+)" и подтверждено [13-VERIFICATION.md](.planning/phases/13-ip-tls-ping-drill-down/13-VERIFICATION.md) как gap.

**Fix в Phase 13.1:** заменить `onRefresh={() => {}}` на handler вызывающий `invoke("speedtest_run")` с loading state (Skeleton во время измерения, Mb/s после). Backend готов — нужна только UI-склейка ~30 строк.

### Q3 — Uptime корректный?

**Да.** Backend `server_get_stats` возвращает `uptime_seconds` из `/proc/uptime` через SSH. Frontend форматирует через `formatServerUptime(seconds, t)` ([`uptime.ts`](gui-app/src/shared/utils/uptime.ts)). Можешь сверить с `uptime` командой в SSH-сессии.

### Q4 — Безопасность: только TLS зелёный, остальные серые — это правильно?

Сейчас — да (intentional descope, см. BUG-03). После Phase 16 будут все 4 в реальном red/green без серых.

---

## Working correctly (без замечаний)

| Карточка | Статус | Источник данных |
|---|---|---|
| Country | ✅ | `useServerGeoIp` → ipwho.is + localStorage cache 30d |
| IP | ✅ | `state.host` (sshParams) |
| Users | ✅ | `state.serverInfo.users.length` |
| Uptime | ✅ | `useServerStats.uptime_seconds` |
| Protocol version | ✅ | `state.serverInfo.version` |
| TLS (внутри Безопасности) | ✅ | `state.serverInfo` derived |
| Pong/heartbeat ECG | ✅ | `isRunning` derived |

---

## Proposed Phase 13.1 (Gap closure)

Минимальный scope для закрытия UAT:

1. **13.1-01** — Fix BUG-01 (skeleton on auto-reconnect)
2. **13.1-02** — Fix BUG-02 (skeleton on first stats fetch)
3. **13.1-03** — Fix BUG-04 (rename "Статус" → "Статус протокола")
4. **13.1-04** — Wire Speed card to `speedtest_run` (закрывает Q2)
5. **13.1-05** *(опционально)* — Wire firewall/fail2ban/SSH-key реальные проверки → закрывает BUG-03 раньше Phase 16
6. **13.1-06** *(опционально)* — Add 200-300ms artificial delay для ping click (если хочется визуального ack «измеряем»)

Запустить:
```bash
/gsd-discuss-phase 13.1 ${GSD_WS}
# или сразу
/gsd-plan-phase 13.1 --gaps ${GSD_WS}
```
