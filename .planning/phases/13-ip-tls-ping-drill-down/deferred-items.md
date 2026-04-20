# Phase 13 — Deferred Items

Out-of-scope issues discovered during plan execution. Not blocking the
current plan; should be triaged separately.

---

## 2026-04-17 — Plan 13-01 (geoip command)

### Pre-existing clippy errors on stable toolchain (rust-clippy 1.94)

`cargo clippy --all-targets -- -D warnings` reports **81 errors**, all
in files unrelated to Plan 13-01. None of them mention
`gui-pro/src-tauri/src/commands/geoip.rs`.

Examples (truncated, full list via `cargo clippy --all-targets`):
- `src/ssh/server/server_security.rs:526` — `needless_borrow`
  (`&sudo` → `sudo`)
- `src/ssh/server/server_security.rs:931` — `needless_borrow`
  (`&sudo` → `sudo`)
- `src/tray.rs:137` — `redundant_closure` (`|| auto_detect_config()`
  → `auto_detect_config`)
- multiple files — `too_many_arguments` (8/7) — function signatures
  introduced before clippy 1.94 raised the bar
- `empty_line_after_doc_comment` — multiple files

These warnings are introduced by clippy version bump (the project's
last green clippy run was on an older toolchain). Should be addressed
in a dedicated clippy-cleanup plan, not in Phase 13. Plan 13-01's
acceptance criteria mention "clippy зелёный", but per SCOPE BOUNDARY
rule (only auto-fix issues directly caused by current task) the
unrelated legacy warnings are deferred.

**Verification that Plan 13-01 itself is clippy-clean:**
- `cargo clippy --all-targets 2>&1 | grep geoip` → no output
- The new `commands/geoip.rs` introduces zero new warnings
- The single-line addition to `commands/mod.rs` (`pub mod geoip;`) and
  to `lib.rs` (`commands::geoip::get_server_geoip,`) introduce zero
  new warnings
