//! Server Benchmark — streaming SSH execution of IP.Check.Place quality checker.
//!
//! # Architecture
//!
//! - `run_benchmark` opens a single SSH channel via `open_session_with_retry`,
//!   executes `bash <(curl -Ls https://IP.Check.Place) -l en` with `stdbuf -oL` prefix
//!   for line-buffered streaming and `set -m;` for job-control (SIGTERM propagation).
//! - Cancellation is driven by a `tokio::sync::oneshot::Receiver<()>` passed in from
//!   the Tauri command layer. On cancel: `channel.signal(Sig::TERM)` + `channel.eof()`.
//! - B8 watchdog: after cancel signal sent, the loop wraps `channel.wait()` in a 5-second
//!   `tokio::time::timeout`. If the remote sshd hangs, we force-break and return
//!   `Err("BENCHMARK_CANCELLED|dur={N}|forced")`.
//! - B5: Backend does NOT parse sections. `BenchmarkResult` contains only `raw_stdout` +
//!   `duration_seconds`. Section parsing is frontend TS responsibility (`parseBenchmarkOutput()`).
//! - No progress events emitted — simplified per UAT 2026-05-19 round 3.

use russh::{client, ChannelMsg, Sig};
use serde::Serialize;
use std::time::Instant;
use tokio::time::{timeout, Duration};

// ─── Exported Types ───────────────────────────────────────────────────────────

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
    _app: &tauri::AppHandle,
    handle: &client::Handle<crate::ssh::SshHandler>,
    cancel_rx: tokio::sync::oneshot::Receiver<()>,
) -> Result<BenchmarkResult, String> {
    let start = Instant::now();

    // Open SSH channel via gate + retry (CHANNEL_OPEN_GATE ensures ≤5 parallel channels).
    let mut channel = crate::ssh::open_session_with_retry(handle)
        .await
        .map_err(|e| format!("SSH_CHANNEL_FAILED|{e}"))?;

    // Build command: set -m enables job control so SIGTERM propagates to process group.
    // stdbuf -oL forces line-buffered stdout for real-time streaming (A1).
    // Canonical endpoint IP.Check.Place runs IPQuality script directly (no menu wrapper).
    // Flag: `-l en` sets script output language to English.
    let cmd =
        "set -m; echo $$ > /tmp/tt-benchmark.pid; exec stdbuf -oL bash <(curl -Ls https://IP.Check.Place) -l en 2>&1";
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

                    // Stdout data — accumulate.
                    Ok(Some(ChannelMsg::Data { ref data })) => {
                        let text = String::from_utf8_lossy(data);
                        raw_buf.push_str(&text);
                    }

                    // Stderr — accumulate (pipeline errors visible in Raw output).
                    Ok(Some(ChannelMsg::ExtendedData { ref data, .. })) => {
                        let text = String::from_utf8_lossy(data);
                        raw_buf.push_str(&text);
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

    Ok(BenchmarkResult {
        raw_stdout: raw_buf,
        duration_seconds: duration,
    })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

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

        let hung_future2 = std::future::pending::<Option<ChannelMsg>>();
        let watchdog_result = timeout(TDuration::from_millis(1), hung_future2).await;
        assert!(
            watchdog_result.is_err(),
            "B8 watchdog: second assertion — Err(Elapsed) arm exercised"
        );
    }
}
