# Roadmap: TrustTunnel Client Refactoring v2.4.0

**Created:** 2026-04-10
**Milestone:** v2.4.0 — Security, Performance, Quality Refactoring

## Phase 1: SSH Injection Prevention + Self-Update Hardening
**Status:** COMPLETE
**Goal:** Prevent RCE on remote servers via input validation; harden self-update
**Requires:** SEC-01, SEC-02, SEC-03
**Estimated effort:** 3-4h

- [x] Create ssh/sanitize.rs with 8 validators + tests
- [x] Fix add_server_user heredoc injection
- [x] Add validation to deploy.rs, server_config.rs, server_version.rs
- [x] Make SHA256 mandatory in updater.rs (Pro + Light)
- [x] Add URL domain whitelist for downloads
- [x] Update frontend (AboutPanel, AboutScreen) + tests

## Phase 2: Code Quality — DRY + Cleanup
**Status:** PLANNED
**Goal:** Eliminate code duplication, extract modules, fix known bugs
**Requires:** DRY-01, DRY-02, FIX-01, FIX-02, DRY-03
**Estimated effort:** 2-3h
**Plans:** 2 plans

Plans:
- [ ] 02-01-PLAN.md — Centralize detect_sudo() and build_client_config() in ssh/mod.rs (DRY-01, DRY-02)
- [ ] 02-02-PLAN.md — Fix sanitize() + hosts_file_path() bugs, extract tray.rs (FIX-01, FIX-02, DRY-03)

## Phase 3: Async Logging
**Status:** PLANNED
**Goal:** Non-blocking file logging via tokio::sync::mpsc channel
**Requires:** PERF-01
**Estimated effort:** 2-3h
**Plans:** 1 plan

Plans:
- [x] 03-01-PLAN.md — Rewrite logging.rs: mpsc channel, background writer, batched flushes

- [ ] Replace sync Mutex with mpsc channel (capacity 1024)
- [ ] Background writer task with batched writes
- [ ] Mutex<Option<Sender>> for non-blocking sends via try_send
- [ ] Graceful shutdown via channel close (drop sender)

## Phase 4: Rust Unit Tests
**Status:** NOT STARTED
**Goal:** Add unit tests for security-critical Rust functions
**Requires:** TEST-01
**Estimated effort:** 3-4h

- [ ] Add tauri/test feature to Cargo.toml
- [ ] Tests for sanitize() in logging.rs
- [ ] Tests for input validators in ssh/sanitize.rs
- [ ] Tests for is_safe_*() in server_security.rs
- [ ] Tests for ClientConfig::validate() in config.rs
- [ ] Tests for build_configure_commands() in deploy.rs
- [ ] Update Makefile test-rust target

## Phase 5: Connectivity Monitor — Bypass VPN
**Status:** NOT STARTED
**Goal:** Internet checks bypass VPN to avoid false offline detection
**Requires:** FIX-03
**Depends on:** None
**Estimated effort:** 2-3h

- [ ] Add ipconfig + socket2 dependencies
- [ ] Implement find_physical_adapter_ip()
- [ ] TCP check with socket2::connect_timeout() bound to physical adapter
- [ ] HTTP check with reqwest local_address() binding
- [ ] Fallback to default routing if no physical adapter found

## Phase 6: SSH Connection Pool
**Status:** NOT STARTED
**Goal:** Persistent SSH connections for server management (eliminate 200-500ms per request)
**Requires:** PERF-02
**Depends on:** Phase 2 (detect_sudo centralized)
**Estimated effort:** 4-5h

- [ ] Create SshPool with Arc<TokioMutex<Option<CachedSsh>>>
- [ ] acquire()/invalidate() methods with is_closed() check
- [ ] Keepalive task (send_keepalive every 60s)
- [ ] Add SshPool to AppState
- [ ] Server management commands use pool; deploy uses direct connect

## Phase 7: Credential Storage — Keyring Migration
**Status:** NOT STARTED
**Goal:** SSH passwords in Windows Credential Manager instead of base64 JSON
**Requires:** SEC-04
**Depends on:** None
**Estimated effort:** 3-4h

- [ ] Add keyring crate with windows-native feature
- [ ] Implement save/load/clear via keyring::Entry
- [ ] Auto-migrate from b64: JSON to keyring on load
- [ ] Remove obfuscation.ts from frontend
- [ ] Update SshConnectForm.tsx

## Phase 8: TOFU Host Key Confirmation
**Status:** NOT STARTED
**Goal:** User confirms SSH host key fingerprint on first connection
**Requires:** SEC-05
**Depends on:** None
**Estimated effort:** 3-4h

- [ ] Oneshot channel pattern in ssh/mod.rs
- [ ] Emit ssh-host-key-verify event with fingerprint
- [ ] New confirm_host_key Tauri command
- [ ] React useHostKeyVerification hook + HostKeyDialog
- [ ] i18n keys for dialog (ru + en)

## Phase 9: Frontend CI + SecuritySection Refactoring
**Status:** NOT STARTED
**Goal:** Automated frontend quality gates; testable SecuritySection
**Requires:** TEST-02, TEST-03
**Depends on:** None
**Estimated effort:** 4-5h

- [ ] Create .github/workflows/frontend.yml
- [ ] Extract useSecurityState.ts hook
- [ ] Split SecuritySection into Fail2banSection + FirewallSection
- [ ] Write tests for all 3 layers

---

## Summary

| Phase | Status | Requirements | Effort |
|-------|--------|-------------|--------|
| 1. SSH Injection + Self-Update | COMPLETE | SEC-01,02,03 | 3-4h |
| 2. DRY + Cleanup | PLANNED | DRY-01,02,03 FIX-01,02 | 2-3h |
| 3. Async Logging | PLANNED | PERF-01 | 2-3h |
| 4. Rust Unit Tests | NOT STARTED | TEST-01 | 3-4h |
| 5. Connectivity Bypass | NOT STARTED | FIX-03 | 2-3h |
| 6. SSH Connection Pool | NOT STARTED | PERF-02 | 4-5h |
| 7. Keyring Migration | NOT STARTED | SEC-04 | 3-4h |
| 8. TOFU Confirmation | NOT STARTED | SEC-05 | 3-4h |
| 9. Frontend CI + SecuritySection | NOT STARTED | TEST-02,03 | 4-5h |

**Total: ~28-35 hours**

---
*Roadmap created: 2026-04-10*
*Last updated: 2026-04-10 after Phase 3 planning*
