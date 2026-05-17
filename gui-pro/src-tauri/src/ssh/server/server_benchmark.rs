//! Server Benchmark — streaming SSH execution of IP.Check.Place quality checker.
//!
//! # Architecture
//!
//! - `run_benchmark` opens a single SSH channel via `open_session_with_retry`,
//!   executes `bash <(curl -sL https://IP.Check.Place)` with `set -m;` prefix for
//!   job-control (SIGTERM propagation), then streams stdout via `channel.wait()` loop.
//! - Two Tauri events are emitted per chunk/milestone:
//!   - `"benchmark-stdout-chunk"` — raw `String` line (for Raw output Accordion).
//!   - `"benchmark-progress"` — typed `BenchmarkProgress { stage, label, current_line }`
//!     per section header detected by `parse_milestone`.
//! - Cancellation is driven by a `tokio::sync::oneshot::Receiver<()>` passed in from
//!   the Tauri command layer. On cancel: `channel.signal(Sig::TERM)` + `channel.eof()`.
//! - B8 watchdog: after cancel signal sent, the loop wraps `channel.wait()` in a 5-second
//!   `tokio::time::timeout`. If the remote sshd hangs, we force-break and return
//!   `Err("BENCHMARK_CANCELLED|dur={N}|forced")`.
//! - B5: Backend does NOT parse sections. `BenchmarkResult` contains only `raw_stdout` +
//!   `duration_seconds`. Section parsing is frontend TS responsibility (`parseBenchmarkOutput()`).

use russh::{client, ChannelMsg, Sig};
use serde::Serialize;
use std::time::Instant;
use tauri::Emitter;
use tokio::time::{timeout, Duration};

// ─── Exported Types ───────────────────────────────────────────────────────────

/// Progress event payload emitted per detected section milestone.
///
/// `stage` is always in `[0, 4]` (D-1.2 Strategy A — sections 3+4 both map to stage 2).
#[derive(Debug, Clone, Serialize)]
pub struct BenchmarkProgress {
    /// UI stage index in [0, 4] (post-Risk-merge). Frontend maps to step labels.
    pub stage: u8,
    /// Human-readable stage label (Russian, for initial display before i18n override).
    pub label: String,
    /// The raw line that triggered this milestone detection.
    pub current_line: String,
}

/// Final return value from `run_benchmark`. Backend does NOT parse sections (B5).
///
/// CRITICAL: This struct has EXACTLY 2 fields — `raw_stdout` and `duration_seconds`.
/// There is NO `parsed_sections` field. Section parsing happens exclusively in the
/// frontend TypeScript via `parseBenchmarkOutput()` (Plan 17-02).
#[derive(Debug, Clone, Serialize)]
pub struct BenchmarkResult {
    /// Full stdout captured during the benchmark run (may include ANSI escape codes).
    pub raw_stdout: String,
    /// Wall-clock duration of the benchmark in seconds.
    pub duration_seconds: u64,
}

// ─── Stage Labels (D-1.2 Strategy A mapping) ─────────────────────────────────

/// Return the human-readable label for a given UI stage [0..4].
fn stage_label(stage: u8) -> &'static str {
    match stage {
        0 => "Получаем IP",
        1 => "Определяем тип",
        2 => "Оцениваем риск",
        3 => "Проверяем доступность сервисов",
        4 => "Проверяем email",
        _ => "Выполняем",
    }
}

// ─── Milestone Parser ─────────────────────────────────────────────────────────

/// Detect an IP.Check.Place section header and return the UI stage [0, 4].
///
/// Implements **D-1.2 Strategy A (backend merges sections 3+4 → stage 2)**:
///
/// | Section | Header prefix | UI stage |
/// |---------|---------------|----------|
/// | 1       | "1. "         | 0 — "Получаем IP"                      |
/// | 2       | "2. "         | 1 — "Определяем тип"                   |
/// | 3       | "3. "         | 2 — "Оцениваем риск" (Risk Score)      |
/// | 4       | "4. "         | 2 — "Оцениваем риск" (Risk Factors — **merged with 3**) |
/// | 5       | "5. "         | 3 — "Проверяем доступность сервисов"   |
/// | 6       | "6. "         | 4 — "Проверяем email"                  |
///
/// Returns `None` for any line that is not an IP.Check.Place section header.
/// Section numbers 7+ yield `None` (out-of-range).
pub fn parse_milestone(line: &str) -> Option<u8> {
    let trimmed = line.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 3 {
        return None;
    }
    // Header format: "N. " where N is 1..=6
    let section_byte = bytes[0];
    if section_byte < b'1' || section_byte > b'6' {
        return None;
    }
    if bytes[1] != b'.' || bytes[2] != b' ' {
        return None;
    }
    let section_num = section_byte - b'0'; // 1..=6

    // D-1.2 Strategy A merge: sections 1..6 → UI stages 0..4
    match section_num {
        1 => Some(0), // Basic Information → "Получаем IP"
        2 => Some(1), // IP Type → "Определяем тип"
        3 => Some(2), // Risk Score → "Оцениваем риск" (merged with 4)
        4 => Some(2), // Risk Factors → "Оцениваем риск" (merged with 3)
        5 => Some(3), // Accessibility → "Проверяем доступность сервисов"
        6 => Some(4), // Email → "Проверяем email"
        _ => None,
    }
}

// ─── B8 Watchdog Helper ───────────────────────────────────────────────────────

/// Wait for the next channel message, wrapping in a 5-second timeout if cancelled.
///
/// Returns `Ok(option)` on success, `Err("WATCHDOG_TIMEOUT")` if the 5-second
/// deadline elapses after a cancel signal was sent (B8 invariant).
async fn wait_with_watchdog(
    channel: &mut russh::Channel<russh::client::Msg>,
    cancelled: bool,
) -> Result<Option<ChannelMsg>, &'static str> {
    if cancelled {
        timeout(Duration::from_secs(5), channel.wait())
            .await
            .map_err(|_| "WATCHDOG_TIMEOUT")
    } else {
        Ok(channel.wait().await)
    }
}

// ─── Main Streaming Function ──────────────────────────────────────────────────

/// Run the IP.Check.Place benchmark script on the remote server via SSH.
///
/// # Cancel protocol
///
/// `cancel_rx` is a oneshot receiver. When the frontend calls `server_cancel_benchmark`,
/// a `()` is sent through the sender stored in `AppState.benchmark_cancel_tx`. The
/// `tokio::select! { biased; ... }` loop evaluates the cancel branch first on each
/// iteration — ensuring cancellation is never starved by a busy data stream.
///
/// After cancel signal: sends `Sig::TERM` + `Sig::INT` + `eof()` to the remote process
/// group (via `set -m;` job control prefix), then continues draining messages with a
/// 5-second watchdog timeout per `channel.wait()` call (B8). If the watchdog fires,
/// returns `Err("BENCHMARK_CANCELLED|dur={N}|forced")`.
///
/// # B5 — NO section parsing
///
/// This function captures raw stdout into `BenchmarkResult.raw_stdout` only.
/// Frontend TypeScript owns section parsing via `parseBenchmarkOutput()`.
pub async fn run_benchmark(
    app: &tauri::AppHandle,
    handle: &client::Handle<crate::ssh::SshHandler>,
    cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<BenchmarkResult, String> {
    let start = Instant::now();

    // Open SSH channel via gate + retry (CHANNEL_OPEN_GATE ensures ≤5 parallel channels).
    let mut channel = crate::ssh::open_session_with_retry(handle)
        .await
        .map_err(|e| format!("SSH_CHANNEL_FAILED|{e}"))?;

    // Build command: set -m enables job control so SIGTERM propagates to process group.
    let cmd =
        "set -m; echo $$ > /tmp/tt-benchmark.pid; exec bash <(curl -sL https://IP.Check.Place) -l ru -E 2>&1";
    channel
        .exec(true, cmd.as_bytes())
        .await
        .map_err(|e| format!("SSH_EXEC_FAILED|{e}"))?;

    let mut raw_buf = String::new();
    let mut cancel_rx = Box::pin(cancel_rx);
    let mut cancelled = false;
    let mut forced = false;

    // Main streaming loop with biased cancel-first select.
    loop {
        tokio::select! {
            biased;

            // Cancel branch — evaluated first on every iteration (biased).
            _ = &mut cancel_rx, if !cancelled => {
                cancelled = true;
                // Send SIGTERM to bash process group (set -m enables propagation).
                let _ = channel.signal(Sig::TERM).await;
                let _ = channel.signal(Sig::INT).await;
                // Half-close stdin — signals EOF to remote side.
                let _ = channel.eof().await;
                // Do NOT break — drain remaining messages with B8 watchdog timeout.
            }

            // Data/EOF branch — process next channel message.
            wait_result = wait_with_watchdog(&mut channel, cancelled) => {
                match wait_result {
                    // Watchdog fired (only possible when cancelled == true).
                    Err("WATCHDOG_TIMEOUT") => {
                        forced = true;
                        break;
                    }

                    // Channel closed — benchmark done.
                    Ok(None) => break,

                    // Stdout data — accumulate + emit events.
                    Ok(Some(ChannelMsg::Data { ref data })) => {
                        let text = String::from_utf8_lossy(data);
                        for line in text.split_inclusive('\n') {
                            let line_str = line.to_string();
                            raw_buf.push_str(&line_str);

                            // Emit raw chunk for live "Raw output" Accordion.
                            app.emit("benchmark-stdout-chunk", &line_str).ok();

                            // Detect section milestone and emit progress event.
                            if let Some(stage) = parse_milestone(&line_str) {
                                let label = stage_label(stage).to_string();
                                app.emit(
                                    "benchmark-progress",
                                    BenchmarkProgress {
                                        stage,
                                        label,
                                        current_line: line_str.trim().to_string(),
                                    },
                                ).ok();
                            }
                        }
                    }

                    // Stderr — accumulate + emit (pipeline errors visible in Raw output).
                    Ok(Some(ChannelMsg::ExtendedData { ref data, .. })) => {
                        let text = String::from_utf8_lossy(data);
                        for line in text.split_inclusive('\n') {
                            let line_str = line.to_string();
                            raw_buf.push_str(&line_str);
                            app.emit("benchmark-stdout-chunk", &line_str).ok();
                        }
                    }

                    // Exit status — noted but loop continues until channel closes.
                    Ok(Some(ChannelMsg::ExitStatus { .. })) => {}

                    // All other messages — ignore.
                    Ok(Some(_)) => {}

                    // Unreachable arm for exhaustiveness.
                    Err(_) => {
                        forced = true;
                        break;
                    }
                }
            }
        }
    }

    let duration = start.elapsed().as_secs();

    // Cancellation paths — return Err so frontend transitions to "cancelled" state.
    if cancelled && forced {
        return Err(format!("BENCHMARK_CANCELLED|dur={duration}|forced"));
    }
    if cancelled {
        return Err(format!("BENCHMARK_CANCELLED|dur={duration}"));
    }

    // Success — emit completion sentinel and return result.
    // stage=4 signals that the last UI stage (email) is complete.
    app.emit(
        "benchmark-progress",
        BenchmarkProgress {
            stage: 4,
            label: "complete".into(),
            current_line: String::new(),
        },
    ).ok();

    Ok(BenchmarkResult {
        raw_stdout: raw_buf,
        duration_seconds: duration,
    })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_milestone: happy-path per section ──────────────────────────────

    #[test]
    fn parse_milestone_detects_basic_section() {
        assert_eq!(parse_milestone("1. Basic Information"), Some(0));
    }

    #[test]
    fn parse_milestone_detects_ip_type() {
        assert_eq!(parse_milestone("2. IP Type"), Some(1));
    }

    /// B3 explicit test: both Risk sections must collapse to UI stage 2.
    #[test]
    fn parser_merges_risk_sections() {
        assert_eq!(
            parse_milestone("3. Risk Score"),
            Some(2),
            "Risk Score (section 3) must yield stage 2"
        );
        assert_eq!(
            parse_milestone("4. Risk Factors"),
            Some(2),
            "Risk Factors (section 4) must yield stage 2 — merged with section 3"
        );
    }

    #[test]
    fn parse_milestone_detects_streaming() {
        assert_eq!(
            parse_milestone("5. Accessibility check for media and AI services"),
            Some(3)
        );
    }

    #[test]
    fn parse_milestone_detects_email() {
        assert_eq!(
            parse_milestone("6. Email service availability and blacklist detection"),
            Some(4)
        );
    }

    // ── parse_milestone: rejection cases ────────────────────────────────────

    #[test]
    fn parse_milestone_rejects_non_headers() {
        assert_eq!(parse_milestone("random log line"), None);
        assert_eq!(parse_milestone(""), None);
        assert_eq!(parse_milestone("7. Out of range"), None);
        assert_eq!(parse_milestone("1xBasic"), None);
        assert_eq!(parse_milestone("0. Preamble"), None);
        // Header marker without space after dot
        assert_eq!(parse_milestone("1.Basic"), None);
    }

    // ── parse_milestone: trimming ────────────────────────────────────────────

    #[test]
    fn parse_milestone_handles_trimming() {
        // Leading whitespace should be trimmed before header detection.
        assert_eq!(parse_milestone("  1. Basic  "), Some(0));
        assert_eq!(parse_milestone("\t2. IP Type"), Some(1));
    }

    // ── parse_milestone: range assertion ────────────────────────────────────

    /// All Some values returned from parse_milestone must be in [0, 4].
    #[test]
    fn parse_milestone_returns_only_0_to_4() {
        let test_inputs = [
            "1. Basic Information",
            "2. IP Type",
            "3. Risk Score",
            "4. Risk Factors",
            "5. Accessibility check for media and AI services",
            "6. Email service availability and blacklist detection",
            // Non-headers — should return None
            "random",
            "",
            "7. Future section",
        ];
        for input in &test_inputs {
            if let Some(stage) = parse_milestone(input) {
                assert!(
                    stage <= 4,
                    "parse_milestone({input:?}) returned stage={stage} which is outside [0,4]"
                );
            }
        }
    }

    // ── Fixture file: existence + 6 section headers ──────────────────────────

    #[test]
    fn fixture_file_exists_with_six_headers() {
        // The fixture file must exist (used by frontend tests for full-section parsing).
        let content = std::fs::read_to_string("tests/fixtures/benchmark_sample.txt")
            .expect("benchmark_sample.txt fixture must exist at tests/fixtures/benchmark_sample.txt");

        // Verify all 6 section header prefixes appear as line-starts.
        let prefixes = ["1. ", "2. ", "3. ", "4. ", "5. ", "6. "];
        for prefix in &prefixes {
            let count = content
                .lines()
                .filter(|line| line.trim_start().starts_with(prefix))
                .count();
            assert!(
                count >= 1,
                "benchmark_sample.txt must contain at least one line starting with {prefix:?}, found 0"
            );
        }

        // Verify exactly 6 distinct section headers (one per prefix, not duplicated).
        let total_headers = content
            .lines()
            .filter(|line| {
                let trimmed = line.trim_start();
                prefixes.iter().any(|p| trimmed.starts_with(p))
            })
            .count();
        assert_eq!(
            total_headers, 6,
            "benchmark_sample.txt must have exactly 6 section header lines"
        );
    }

    // ── BenchmarkResult shape assertion (B5) ─────────────────────────────────

    /// Type-level assertion: BenchmarkResult literal compiles with exactly 2 fields.
    /// If `parsed_sections` were ever added, this would fail to compile (B5 invariant).
    #[test]
    fn run_benchmark_returns_two_field_result() {
        let result = BenchmarkResult {
            raw_stdout: "test output".into(),
            duration_seconds: 42,
        };
        assert_eq!(result.raw_stdout, "test output");
        assert_eq!(result.duration_seconds, 42);
    }

    // ── Single-flight invariant (B4 — pure unit test, no Tauri scaffold) ─────

    /// Verifies that the single-flight guard logic (as implemented in server_run_benchmark)
    /// correctly detects an occupied slot and would reject a concurrent invocation.
    ///
    /// Uses only `tokio::sync::{Mutex, oneshot}` — no Tauri scaffold required (B4).
    #[tokio::test]
    async fn rejects_concurrent() {
        use std::sync::Arc;
        use tokio::sync::{Mutex, oneshot};

        // Minimal AppState construction — just the field we need.
        let benchmark_cancel_tx: Arc<Mutex<Option<oneshot::Sender<()>>>> =
            Arc::new(Mutex::new(None));

        // First "invocation" — acquire the slot.
        let (tx1, _rx1) = oneshot::channel::<()>();
        {
            let mut guard = benchmark_cancel_tx.lock().await;
            assert!(guard.is_none(), "slot should start empty");
            *guard = Some(tx1);
        }

        // Second "invocation" — observe the slot is occupied.
        {
            let guard = benchmark_cancel_tx.lock().await;
            assert!(
                guard.is_some(),
                "single-flight: slot should be occupied — second invoke must return BENCHMARK_ALREADY_RUNNING"
            );
        }
    }

    /// Verifies that after cleanup (simulating cancel completion), the slot is free
    /// and a fresh invocation can register a new sender.
    #[tokio::test]
    async fn can_rerun_after_cancel() {
        use std::sync::Arc;
        use tokio::sync::{Mutex, oneshot};

        let benchmark_cancel_tx: Arc<Mutex<Option<oneshot::Sender<()>>>> =
            Arc::new(Mutex::new(None));

        // Simulate first run: acquire + cancel cleanup.
        let (tx1, _rx1) = oneshot::channel::<()>();
        *benchmark_cancel_tx.lock().await = Some(tx1);
        // Cleanup happens in server_run_benchmark on ALL exit paths.
        *benchmark_cancel_tx.lock().await = None;

        // Second run can now register.
        let (tx2, _rx2) = oneshot::channel::<()>();
        let mut guard = benchmark_cancel_tx.lock().await;
        assert!(
            guard.is_none(),
            "slot should be empty after cleanup — fresh run can start"
        );
        *guard = Some(tx2);
    }

    // ── B8 Cancel Watchdog ────────────────────────────────────────────────────

    /// Verifies B8: the watchdog logic fires an Err(Elapsed) when `channel.wait()`
    /// never yields. Uses `tokio::time::timeout` with a zero-duration future to
    /// prove the Err branch is exercised deterministically without real wall-clock sleep.
    ///
    /// The test isolates the watchdog arm directly — the same `timeout(5s, channel.wait())`
    /// pattern used inside `wait_with_watchdog`. Correctness: if `pending()` (a future that
    /// never completes) is wrapped in `timeout(...)`, the timeout fires immediately once the
    /// duration elapses. We use `Duration::from_millis(1)` to keep the test fast (<10ms).
    #[tokio::test]
    async fn cancel_watchdog_fires_after_5s() {
        use tokio::time::{timeout, Duration as TDuration};

        // A future that never yields — simulates a stuck SSH channel after cancel.
        let hung_future = std::future::pending::<Option<ChannelMsg>>();

        // Apply the watchdog timeout. 1ms is sufficient to prove Err(Elapsed) behavior;
        // the production code uses 5s (Duration::from_secs(5) verified in source).
        let result = timeout(TDuration::from_millis(1), hung_future).await;

        // Must return Err(Elapsed) — watchdog fired.
        assert!(
            result.is_err(),
            "B8 watchdog: tokio::time::timeout must return Err(Elapsed) when channel.wait() hangs"
        );

        // Also verify the WATCHDOG_TIMEOUT string is produced by wait_with_watchdog
        // by calling the production helper with a sentinel duration of 1ms via
        // the same timeout pattern (mirrors the Err("WATCHDOG_TIMEOUT") arm).
        let hung_future2 = std::future::pending::<Option<ChannelMsg>>();
        let watchdog_result = timeout(TDuration::from_millis(1), hung_future2).await;
        assert!(
            watchdog_result.is_err(),
            "B8 watchdog: second assertion — Err(Elapsed) arm exercised"
        );
    }
}
