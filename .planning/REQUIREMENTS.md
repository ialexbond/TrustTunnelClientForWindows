# Requirements: TrustTunnel Client Refactoring

**Defined:** 2026-04-10
**Core Value:** Безопасное и надёжное VPN-подключение без уязвимостей в обработке пользовательского ввода

## v2.4.0 Requirements

### Security

- [x] **SEC-01**: Все user inputs валидируются перед интерполяцией в SSH команды
- [x] **SEC-02**: SHA256 checksum обязателен при self-update (не Optional)
- [x] **SEC-03**: Download URL ограничен whitelist доменов (github.com)
- [ ] **SEC-04**: SSH credentials хранятся в Windows Credential Manager (keyring)
- [ ] **SEC-05**: TOFU host key verification с подтверждением пользователя

### Code Quality

- [ ] **DRY-01**: detect_sudo() централизован в ssh/mod.rs (17 дубликатов -> 1)
- [ ] **DRY-02**: build_client_config() централизован (3 копии -> 1)
- [ ] **DRY-03**: Tray logic извлечён из lib.rs в tray.rs (~208 строк)

### Bug Fixes

- [ ] **FIX-01**: sanitize() заменяет ВСЕ вхождения sensitive keys (не только первое)
- [ ] **FIX-02**: Hosts file path использует %SystemRoot% (не hardcoded C:\Windows)
- [ ] **FIX-03**: Connectivity monitor проверяет через физический адаптер (не через VPN)

### Performance

- [x] **PERF-01**: Logging через async mpsc channel (не sync Mutex per-write)
- [ ] **PERF-02**: SSH connection pool для server management commands

### Testing

- [x] **TEST-01**: Rust unit tests для sanitize, validators, config, deploy
- [ ] **TEST-02**: Frontend CI (GitHub Actions) для typecheck + lint + test
- [ ] **TEST-03**: SecuritySection.tsx refactored + tested (910 строк -> sub-components)

## v2.5.0 Requirements (deferred)

- **DEFER-01**: SSH key passphrase support
- **DEFER-02**: VPN credentials encryption в TOML config
- **DEFER-03**: Authenticode signature verification при self-update
- **DEFER-04**: gui-light test infrastructure
- **DEFER-05**: Portable data dir APPDATA fallback

## Out of Scope

| Feature | Reason |
|---------|--------|
| Cross-platform GUI (Linux/macOS) | Только Windows desktop target |
| Full regex crate для sanitize | Loop-based подход достаточен для 4 паттернов |
| SSH connection multiplexing (concurrent commands) | Одного pool slot достаточно |
| Server upgrade GPG verification | Требует изменений в серверном репо |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SEC-01 | Phase 1 | Complete |
| SEC-02 | Phase 1 | Complete |
| SEC-03 | Phase 1 | Complete |
| DRY-01 | Phase 2 | Pending |
| DRY-02 | Phase 2 | Pending |
| FIX-01 | Phase 2 | Pending |
| FIX-02 | Phase 2 | Pending |
| DRY-03 | Phase 2 | Pending |
| PERF-01 | Phase 3 | Complete |
| TEST-01 | Phase 4 | Complete |
| FIX-03 | Phase 5 | Pending |
| PERF-02 | Phase 6 | Pending |
| SEC-04 | Phase 7 | Pending |
| SEC-05 | Phase 8 | Pending |
| TEST-02 | Phase 9 | Pending |
| TEST-03 | Phase 9 | Pending |

**Coverage:**
- v2.4.0 requirements: 16 total
- Mapped to phases: 16
- Unmapped: 0

---
*Requirements defined: 2026-04-10*
*Last updated: 2026-04-10 after initialization*
