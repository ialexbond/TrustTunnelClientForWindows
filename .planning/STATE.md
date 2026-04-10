# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-10)

**Core value:** Безопасное VPN-подключение без уязвимостей в обработке пользовательского ввода
**Current focus:** Phase 6 — SSH Connection Pool

## Current Milestone

**Milestone:** v2.4.0 — Security, Performance, Quality Refactoring
**Branch:** claude/crazy-lewin
**Started:** 2026-04-10

## Phase Status

| Phase | Status | Notes |
|-------|--------|-------|
| 1. SSH Injection + Self-Update | COMPLETE | sanitize.rs, heredoc fix, SHA256 mandatory |
| 2. DRY + Cleanup | COMPLETE | detect_sudo DRY, build_client_config DRY, sanitize fix, hosts path, tray.rs |
| 3. Async Logging | COMPLETE | mpsc channel, batched writes, sanitize loop fix |
| 4. Rust Unit Tests | COMPLETE | 54 tests: security validators, config, deploy, logging |
| 5. Connectivity Bypass | COMPLETE | socket2+ipconfig bind to physical adapter |
| 6. SSH Connection Pool | NOT STARTED | |
| 7. Keyring Migration | NOT STARTED | |
| 8. TOFU Confirmation | NOT STARTED | |
| 9. Frontend CI + SecuritySection | NOT STARTED | |

## Completed Work

### Phase 1 (2026-04-10)
- Created `gui-app/src-tauri/src/ssh/sanitize.rs` — 8 validators, 18 tests passing
- Fixed `add_server_user` — bash -c printf -> heredoc with quoted delimiter
- Added validation in deploy.rs, server_config.rs, server_version.rs
- Made SHA256 mandatory in updater.rs (Pro + Light)
- Added URL domain whitelist for downloads
- Updated frontend (AboutPanel, AboutScreen) — sha256 required
- Updated 22 frontend tests — all passing
- Version bumped 2.3.0 -> 2.4.0 in 6 files

### Phase 2 (2026-04-10)
- Centralized `detect_sudo()` in ssh/mod.rs — replaced 17 inline copies across 6 files
- Centralized `build_client_config()` in ssh/mod.rs — replaced 3 duplicated TOML templates
- Fixed `sanitize()` multi-occurrence bug — while loop instead of if
- Fixed `hosts_file_path()` — uses %SystemRoot% instead of hardcoded C:\Windows
- Extracted tray.rs from lib.rs — lib.rs reduced from 558 to 348 lines
- cargo check passes, 18 sanitize tests pass

### Phase 3 (2026-04-10)
- Rewrote `logging.rs` with async `tokio::sync::mpsc` channel architecture
- `LOG_TX: Mutex<Option<mpsc::Sender<LogEntry>>>` replaces `Mutex<Option<LogState>>`
- `log_app`/`log_sidecar` use `try_send` (non-blocking, nanosecond lock)
- Background `log_writer_task` batches up to 64 entries per flush
- Fixed `sanitize()` infinite loop on quoted patterns (search_from offset)
- Added `shutdown_logging()` to `RunEvent::Exit` handler in lib.rs
- Added 3 unit tests for sanitize function
- cargo check passes, 21 tests passing (3 logging + 18 sanitize)

### Phase 4 (2026-04-10)
- Added 17 tests for is_safe_*() validators in server_security.rs (injection, boundary)
- Added 8 tests for ClientConfig: validate, defaults, DHCP ports, unknown keys, round-trip
- Added 5 tests for build_configure_commands: backslash escaping, heredoc, cert types
- Added 3 new logging tests: all SENSITIVE_KEYS, case-insensitive, quoted boundaries
- Changed build_configure_commands to pub(crate) for testability
- Added tauri/test feature flag to Cargo.toml
- Updated Makefile test-rust to include gui-app/src-tauri
- Total: 54 Rust unit tests passing

### Phase 5 (2026-04-10)
- Added ipconfig 0.3 and socket2 0.5 dependencies
- Implemented `find_physical_adapter_ip()` — filters by oper_status UP, gateway, if_type (Ethernet/WiFi), excludes VPN keywords
- Rewrote `check_connectivity()` — socket2 TCP bind in spawn_blocking + reqwest local_address
- Rewrote `check_adapter_online()` — same physical adapter binding pattern
- Fallback to default routing when no physical adapter found
- cargo check passes, start_monitor() public API unchanged

## Decisions Log

| Decision | Phase | Rationale |
|----------|-------|-----------|
| Loop-based sanitize, not regex | 1 | No regex dep needed for 4 patterns |
| Heredoc for SSH credentials | 1 | Quoted delimiter prevents shell expansion |
| SHA256 mandatory | 1 | Optional allowed skipping verification |
| Mutex<Option<Sender>> over OnceLock | 3 | OnceLock is set-once, cannot support reinit_logging |
| Drop-based shutdown over Shutdown sentinel | 3 | Simpler: drop sender closes channel, writer drains and exits |
| search_from offset in sanitize loop | 3 | Prevents infinite re-matching of already-sanitized content |
| pub(crate) for build_configure_commands | 4 | Minimal visibility increase for testability |
| Inline #[cfg(test)] modules | 4 | Tests private functions without exposing them |
| socket2 connect_timeout in spawn_blocking | 5 | Avoids async TcpStream complexity, clean blocking approach |
| ipconfig crate for adapter enumeration | 5 | Windows-native, exposes if_type and oper_status |
| Dual filter (if_type + description) for VPN exclusion | 5 | Robust: if_type catches known types, description catches edge cases |

---
*Last updated: 2026-04-10 after Phase 5 completion*
