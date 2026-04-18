---
name: Security Posture
description: Threat model, known vulnerabilities, accepted risks, and Phase 14.1 hardening history
type: project
---

# Security Posture — TrustTunnel Client

**Последнее обновление:** 2026-04-18 (после Phase 14.1 code-review-fix)

> Внутренняя security knowledge base. Public-facing версия — [SECURITY.md](../SECURITY.md).

## Текущий статус уязвимостей

```
cargo audit: 1 vulnerability, 23 warnings
npm audit:  [запускать перед релизом]
```

| Advisory | Severity | Crate | Status | Phase |
|----------|----------|-------|--------|-------|
| RUSTSEC-2023-0071 | 5.9 medium | rsa 0.9.10 | **Accepted risk** (Marvin timing attack) | ongoing |
| RUSTSEC-2026-0044 | — | aws-lc-sys | ✅ Closed | 14.1 (commit 76afe755) |
| RUSTSEC-2026-0048 | 7.4 high | aws-lc-sys | ✅ Closed | 14.1 (commit 76afe755) |
| RUSTSEC-2026-0049 | — | rustls-webpki | ✅ Closed | 14.1 (commit ab68cc01) |
| RUSTSEC-2026-0098 | — | rustls-webpki | ✅ Closed | 14.1 (commit ab68cc01) |
| RUSTSEC-2026-0099 | — | rustls-webpki | ✅ Closed | 14.1 (commit ab68cc01) |

## Accepted Risks (с обоснованием)

### RUSTSEC-2023-0071 — rsa Marvin Attack

**Путь dependency:** `trusttunnel → russh 0.46 → rsa 0.9.10`
**Влияние:** только при использовании RSA SSH-ключа для auth.
**Практическая эксплуатируемость:** низкая (требует network MitM + точный timing + большое число операций).
**Mitigation:** документирована в SECURITY.md — рекомендуем Ed25519/ECDSA ключи.
**Когда закроем:** когда RustCrypto/RSA выпустит constant-time fix (unknown ETA) ИЛИ при замене `russh` на другой SSH-крейт (major refactor, не планируем).

### 23 maintenance warnings (gtk-rs deprecated)

**Путь:** Tauri 2 на Linux использует gtk-rs бинди ngs, которые deprecated в пользу gtk4. Windows-билд (наш target) не использует gtk вообще — warnings видны только потому что Cargo.lock включает все target dependencies. Фактически unreachable code.
**Статус:** ignore — Tauri upstream работает над gtk4 migration.

## Phase 14.1 Hardening History

Phase 14.1 добавил 7 Tauri-команд и расширил attack surface. Проведён внутренний code review, найдено **5 Critical + 6 Warning**, все закрыты атомарными коммитами.

### Critical fixes

| ID | Title | Fix commit | Ключевой механизм |
|----|-------|-----------|-------------------|
| CR-01 | Cert pinning ABI (Vec<u8> serde vs `leaf_der_b64`) | 86c3a070 | Base64 wire format backend+frontend |
| CR-02 | displayName SSH injection (только `"` escape) | b2775be5 | `validate_display_name` char-whitelist |
| CR-03 | Password rotation SSH injection (`"`, `$`, `` ` ``, `\`) | 5900d4d5 | Randomized heredoc + password validator расширен |
| CR-04 | `rules.toml` substring collision (`alice` vs `alice_jr`) | c86b062b | Line-exact marker match |
| CR-05 | UserConfig ABI (`has_prefix` vs `client_random_prefix`) | 454bdf37 | `UserRuleResponse` mirror типа |

### Warning fixes

| ID | Title | Fix commit |
|----|-------|-----------|
| WR-01 | displayName не передавался в backend | 454bdf37 |
| WR-02 | `prefix_length`/`prefix_percent` hardcoded | 454bdf37 |
| WR-03 | Race — in-flight invoke не cancelled при закрытии | 454bdf37 |
| WR-04 | USER_EOF heredoc collision | 68cfa6b1 (UUID delimiters) |
| WR-05 | PasswordRotationPrompt trim-тест не тестировал trim | 6e74e72c |
| WR-06 | DnsUpstreamsInput trailing newline aggressive trim | 6e74e72c |

### Breaking change (CR-03)

Политика VPN-паролей теперь **запрещает `'`, `"`, `\`**. Старые пароли с этими символами не пройдут rotation. Подробнее — SECURITY.md §«User-facing breaking change (CR-03)».

## D-29 Invariant (Phase 14+)

**Инвариант:** пароли **никогда** не попадают в activity log (payload, message, serialized form).

**Проверка:** spy-pattern тесты в `PasswordRotationPrompt.test.tsx`, `UsersSection.test.tsx`, `UserModal.test.tsx`. Любой новый компонент с password handling ДОЛЖЕН включать spy-тест, assertʼящий `expect(log).not.toHaveBeenCalledWith(expect.stringContaining(password))`.

**Ловушки:**
- `formatError(e)` может включать SSH stderr с echo пароля — strip pattern в formatError handler
- Активные тесты покрывают штатные flows + error branches
- При rebase/refactor регрессия возможна — CI будет ловить через spy

## Validators (sanitize.rs)

Все user-input валидаторы используют char-whitelist:

| Функция | Input | Whitelist |
|---------|-------|-----------|
| `validate_vpn_username` | username | `[a-zA-Z0-9._-]`, max 32 |
| `validate_vpn_password` | password | ASCII printable, **no** `'`, `"`, `\`, control chars |
| `validate_display_name` | TLV 0x0C | `[a-zA-Z0-9 ._-]`, **no** shell metachars |
| `validate_cidr` | CIDR string | `[0-9./]`, octets 0-255, prefix 0-32 |
| `validate_dns_list` | DNS entries | `[a-zA-Z0-9.:-]` per line, **no** shell metachars |
| `validate_fqdn_sni` | Custom SNI | `[a-zA-Z0-9.-]`, RFC 1035 hostname subset |

**Design rule:** char-whitelist ВСЕГДА. Blacklist нельзя — пропустим что-то.

## Threat Model Summary

### In scope
- SSH-command injection через shell interpolation
- Race conditions UI ↔ async backend
- Credential leakage (logs, errors, payloads, stderr echo)
- Cert pinning integrity
- TLV deeplink encoding tampering

### Out of scope (accepted)
- Local admin attacks (мы уже running as admin для TUN adapter)
- Windows OS CVE
- Crypto side-channels (rsa Marvin — same class)
- crates.io / npm registry compromise
- Social engineering

## Verification Checklist (per release)

```bash
# Backend
cd gui-app/src-tauri
cargo audit                              # 1 vuln expected (rsa Marvin)
cargo clippy --all-targets -- -D warnings  # 83 pre-existing warnings (tech debt)
cargo test --lib --tests                 # 108+ lib tests, 2+ integration

# Frontend
cd gui-app
npm audit --production
npm run typecheck                        # strict
npm run lint                             # max-warnings 0
npm run test                             # 1531+ tests

# Injection regression
grep -rn "validate_display_name\|validate_vpn_password" gui-app/src-tauri/src/ssh/server/
grep -rn "activity.log\|activityLog" gui-app/src/components/server/PasswordRotationPrompt*
```

## Cross-links

- [SECURITY.md](../SECURITY.md) — public-facing policy
- [CLAUDE.md](../CLAUDE.md) — security rules для AI-агентов
- [14.1-REVIEW.md](../.planning/phases/14.1-advanced-user-config-via-gear-icon-per-user-anti-dpi-prefix-/14.1-REVIEW.md) — полный code review
- [14.1-REVIEW-FIX.md](../.planning/phases/14.1-advanced-user-config-via-gear-icon-per-user-anti-dpi-prefix-/14.1-REVIEW-FIX.md) — отчёт по фиксам
- [project_phase14.1_advanced_config.md](project_phase14.1_advanced_config.md) — retrospective Phase 14.1
- [RustSec DB](https://rustsec.org/)
