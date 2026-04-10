# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-10)

**Core value:** Безопасное VPN-подключение без уязвимостей в обработке пользовательского ввода
**Current focus:** Phase 3 — Async Logging

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
| 4. Rust Unit Tests | NOT STARTED | |
| 5. Connectivity Bypass | NOT STARTED | |
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

## Decisions Log

| Decision | Phase | Rationale |
|----------|-------|-----------|
| Loop-based sanitize, not regex | 1 | No regex dep needed for 4 patterns |
| Heredoc for SSH credentials | 1 | Quoted delimiter prevents shell expansion |
| SHA256 mandatory | 1 | Optional allowed skipping verification |
| Mutex<Option<Sender>> over OnceLock | 3 | OnceLock is set-once, cannot support reinit_logging |
| Drop-based shutdown over Shutdown sentinel | 3 | Simpler: drop sender closes channel, writer drains and exits |
| search_from offset in sanitize loop | 3 | Prevents infinite re-matching of already-sanitized content |

---
*Last updated: 2026-04-10 after Phase 3 completion*
*Last updated: 2026-04-10 after Phase 2 completion*
