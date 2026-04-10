---
phase: 03-async-logging
plan: 01
subsystem: logging
tags: [async, mpsc, performance, logging]
dependency_graph:
  requires: []
  provides: [async-logging, non-blocking-log-calls]
  affects: [gui-app/src-tauri/src/logging.rs, gui-app/src-tauri/src/lib.rs]
tech_stack:
  added: [tokio::sync::mpsc]
  patterns: [channel-based-async-logging, batched-writes, drop-based-shutdown]
key_files:
  created: []
  modified:
    - gui-app/src-tauri/src/logging.rs
    - gui-app/src-tauri/src/lib.rs
decisions:
  - "Mutex<Option<Sender>> over OnceLock for reinit support"
  - "Drop-based shutdown over Shutdown sentinel enum variant"
  - "search_from offset fix for sanitize infinite loop (deviation Rule 1)"
metrics:
  duration: "16m48s"
  completed: "2026-04-10"
  tasks_completed: 2
  tasks_total: 2
---

# Phase 3 Plan 01: Async Logging via mpsc Channel Summary

Replaced synchronous Mutex-based file logging with async tokio::sync::mpsc channel architecture -- log_app/log_sidecar now acquire a Mutex protecting only an Option<Sender> (nanosecond lock, no file I/O) and use try_send (non-blocking, drops on overflow).

## What Changed

### logging.rs -- Complete Architecture Rewrite

**Removed:**
- `LogState` struct (held File handles under Mutex)
- `LOG_STATE: Mutex<Option<LogState>>` -- the old pattern that held Mutex during write_all+flush

**Added:**
- `LogEntry` enum with `App` and `Sidecar` variants
- `LOG_TX: Mutex<Option<mpsc::Sender<LogEntry>>>` -- Mutex only protects a sender reference
- `log_writer_task()` -- async background task that receives entries, batches up to 64 per flush cycle
- `open_log_file()` and `process_entry()` helper functions
- `rotate_if_needed()` now returns `bool` so the writer can reopen files after rotation
- Rotation checked every 1000 writes instead of every write
- 3 unit tests for `sanitize()` function

**Preserved exactly:**
- `SENSITIVE_KEYS` constant
- `sanitize()` function (while-loop version, with infinite loop fix -- see deviations)
- `logs_dir()`, `is_logging_enabled()`, `timestamp()` functions
- All 3 `#[tauri::command]` functions unchanged
- All public API signatures: `init_logging()`, `shutdown_logging()`, `reinit_logging()`, `log_app()`, `log_sidecar()`

### lib.rs -- Shutdown Hook

- Added `logging::shutdown_logging()` to `RunEvent::Exit` handler for graceful flush of pending log entries before process exit

## Performance Impact

| Metric | Before (sync) | After (async) |
|--------|---------------|---------------|
| Mutex hold time | Milliseconds (write+flush) | Nanoseconds (try_send) |
| Flush frequency | Per log line | Per batch (up to 64 lines) |
| Rotation check | Every write (stat syscall) | Every 1000 writes |
| Blocking callers | Yes (file I/O under lock) | No (try_send returns immediately) |
| Channel overflow | N/A | Silently drops (bounded 1024) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed sanitize() infinite loop on quoted patterns**
- **Found during:** Task 1 (TDD RED phase -- tests hung)
- **Issue:** When sanitize replaces a value like `password = "secret"` with `password = "***"`, the pattern `password = "` matches again at the same position. The replacement `***` followed by the preserved closing `"` creates `***"`, and the loop finds end=3 (the `"`), replacing `***` with `***` -- producing the exact same string in an infinite loop.
- **Fix:** Added `search_from` offset variable that advances past each replacement (`after + 3`), preventing re-matching of already-sanitized content. This is a minimal, correct fix to the while-loop.
- **Files modified:** `gui-app/src-tauri/src/logging.rs` (sanitize function)
- **Commit:** `6323fe51`
- **Note:** The plan said "PRESERVE sanitize() exactly as-is" but the function had a latent infinite loop bug that would hang the application if any log line contained TOML-style `key = "value"` patterns. The fix adds 2 lines (search_from variable + advance after replacement) without changing the function's logic or API.

**2. [Rule 3 - Blocking] Clippy verification skipped -- not installed**
- **Found during:** Task 2
- **Issue:** `cargo clippy` is not installed for the `stable-x86_64-pc-windows-msvc` toolchain
- **Resolution:** Skipped clippy check. Code compiles clean with `cargo check` and uses standard Rust patterns.

## Decisions Made

1. **Mutex<Option<Sender>> over OnceLock:** OnceLock is set-once and cannot support `reinit_logging()` which needs to replace the sender. Mutex<Option<Sender>> allows shutdown (take) and re-init (replace). The Mutex cost is trivial since it only protects a sender reference.

2. **Drop-based shutdown over Shutdown sentinel:** Dropping the sender closes the channel; the writer task detects `None` from `recv().await`, drains remaining entries via `try_recv()`, and flushes. Simpler than a separate `LogEntry::Shutdown` variant.

3. **shutdown_logging() in RunEvent::Exit:** Added explicit shutdown call in the app exit handler to ensure all pending log entries are flushed to disk before the process terminates.

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | `6323fe51` | Rewrite logging.rs with async mpsc channel architecture |
| 2 | `a10e1016` | Add shutdown_logging() to RunEvent::Exit handler |

## Verification Results

- cargo check: PASS (0 errors, warnings only in unrelated files)
- cargo test logging::tests: PASS (3/3 tests)
- Grep `Mutex<Option<LogState>>`: 0 matches (old pattern removed)
- Grep `try_send`: 2 matches in log_app and log_sidecar
- Grep `write_all`: only inside process_entry (writer task)
- Public API signatures: unchanged (verified by grep)

## Self-Check: PASSED
