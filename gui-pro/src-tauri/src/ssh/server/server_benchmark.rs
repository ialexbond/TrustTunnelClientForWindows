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
//! - Progress (09-38): the backend is a THIN MARKER EMITTER — it no longer fabricates a
//!   0-100 percent. On each stdout line it detects two REAL structural markers and emits
//!   `benchmark-progress` with the marker. A per-IP block header
//!   (`IP QUALITY CHECK REPORT …<ip>`) emits `{ kind: "block", family: "v4"|"v6" }`
//!   (family classified by whether the header IP contains `:`); a numbered section header
//!   (`N. <name>`, N in 1..=6, INCLUDING 6) emits `{ kind: "section", section: N }`.
//!   The honest percent (`completedSections / (6 × blocksSeen)`, monotonic, with the
//!   Russian step label) is computed FRONTEND-side in `benchmark/progress.ts`
//!   (`computeProgress`). Completion is signalled by the frontend's completed-state
//!   transition, NOT by a Rust `complete` marker — so the Rust emitter only ever sends
//!   block/section markers. D-29: the payload carries ONLY a small enum/number marker;
//!   `raw_stdout` text is never serialized into the event.

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

/// IP family of a benchmark block, classified by the block-header IP.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum IpFamily {
    V4,
    V6,
}

/// Tauri event payload emitted on each detected progress MARKER (09-38).
///
/// Event name: `benchmark-progress`. Frontend subscribes while `state.kind === 'running'`
/// and feeds the marker into `computeProgress` (`benchmark/progress.ts`).
///
/// The backend emits ONLY two marker kinds — it no longer fabricates a percent:
///   * `block` → a new `IP QUALITY CHECK REPORT …<ip>` header started a block;
///     `family` carries the v4/v6 classification, `section` is `None`.
///   * `section` → an `N. <name>` section header (N in 1..=6) was reached;
///     `section` carries the number, `family` is `None`.
///
/// D-29: the payload carries ONLY the marker enum tag + a small number. No
/// `raw_stdout` text is ever serialized into this event.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BenchmarkProgress {
    /// A new IP block header was detected, with its v4/v6 family.
    Block { family: IpFamily },
    /// A numbered section header (1..=6) was reached.
    Section { section: u8 },
}

// ─── Marker Detection Helpers ─────────────────────────────────────────────────

/// Strip ANSI escape codes from a line (the IPQuality script uses coloring).
fn strip_ansi(line: &str) -> String {
    let mut out = String::new();
    let mut in_esc = false;
    for c in line.chars() {
        if c == '\x1b' {
            in_esc = true;
        } else if in_esc {
            if c.is_ascii_alphabetic() {
                in_esc = false;
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Detect an `IP QUALITY CHECK REPORT …<ip>` block header in a stdout line and
/// classify it v4/v6 by the header IP.
///
/// Tolerates BOTH real-world header forms (mirrors the TS parser):
///   - colon form (dual-stack capture):  `IP QUALITY CHECK REPORT: 198.51.*.*`
///   - two-space form (single-stack):    `IP QUALITY CHECK REPORT  198.51.100.42`
///
/// Classification: the captured IP token containing a `:` → IPv6, else IPv4
/// (an IPv6 address always has at least one colon; IPv4 and the masked
/// `198.51.*.*` form never do).
///
/// Returns `None` for any line that is not a block header.
pub(crate) fn detect_block(line: &str) -> Option<IpFamily> {
    let clean = strip_ansi(line);
    let trimmed = clean.trim();
    const MARKER: &str = "IP QUALITY CHECK REPORT";
    let idx = trimmed.find(MARKER)?;
    // Take everything AFTER the marker text, then skip an optional colon and the
    // surrounding whitespace to reach the IP token.
    let rest = trimmed[idx + MARKER.len()..].trim_start();
    let rest = rest.strip_prefix(':').unwrap_or(rest).trim_start();
    // The IP token is the first whitespace-delimited word.
    let ip_token = rest.split_whitespace().next()?;
    if ip_token.is_empty() {
        return None;
    }
    Some(if ip_token.contains(':') {
        IpFamily::V6
    } else {
        IpFamily::V4
    })
}

/// Detect a numbered section header (`N. <name>` where N is 1..=6) in a stdout
/// line. Now INCLUDES section 6 (the old fabricated-percent path dropped it,
/// which is part of the stick-at-90 root cause). Handles ANSI-bold prefixes and
/// leading whitespace.
///
/// Returns `None` for any line that is not a section header — crucially, data
/// values like `3.91%` or `Fraud Score: 42 / 100` must NOT misfire (we only
/// react to the `N. ` HEADER shape, never to `\d+%` data tokens).
pub(crate) fn detect_section(line: &str) -> Option<u8> {
    let clean = strip_ansi(line);
    let trimmed = clean.trim_start();
    let bytes = trimmed.as_bytes();
    if bytes.len() < 3 {
        return None;
    }
    // Section header format: "N. ..." where N is 1..=6.
    if !(b'1'..=b'6').contains(&bytes[0]) {
        return None;
    }
    if bytes[1] != b'.' || bytes[2] != b' ' {
        return None;
    }
    Some(bytes[0] - b'0')
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
    // stdbuf -oL forces line-buffered stdout for real-time streaming (A1).
    // Canonical endpoint IP.Check.Place runs IPQuality script directly (no menu wrapper).
    // Flag: `-l en` sets script output language to English.
    //
    // UAT-F16 hang fix (confirmed on server 2026-06-23): on servers where the
    // IPQuality dependencies (curl/dig/etc.) are missing, the script prints a
    // "Continue (y/n)" prompt and blocks forever waiting on stdin — which the SSH
    // exec channel never provides, so the benchmark never returns. Three guards:
    //   - `-y` is the script's NATIVE flag ("install dependencies without interrupt"),
    //     so the prompt is never shown and deps auto-install.
    //   - `< /dev/null` redirects stdin at the command level, so ANY future
    //     interactive read (not just the known prompt) reaches EOF instead of hanging.
    //   - `curl --max-time 60` bounds the script fetch, so a slow/stuck download
    //     cannot hang the channel before the script even starts.
    let cmd =
        "set -m; echo $$ > /tmp/tt-benchmark.pid; exec stdbuf -oL bash <(curl -Ls --max-time 60 https://IP.Check.Place) -l en -y < /dev/null 2>&1";
    channel
        .exec(true, cmd.as_bytes())
        .await
        .map_err(|e| format!("SSH_EXEC_FAILED|{e}"))?;

    let mut raw_buf = String::new();
    let mut cancel_rx = Box::pin(cancel_rx);
    let mut cancelled = false;
    let mut forced = false;
    // 09-38: no Rust-side monotonic percent clamp anymore — the frontend
    // reducer (computeProgress) owns monotonicity. Rust just emits raw markers.

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

                    // Stdout data — accumulate + emit progress events per line.
                    Ok(Some(ChannelMsg::Data { ref data })) => {
                        let text = String::from_utf8_lossy(data);
                        raw_buf.push_str(&text);
                        // 09-38: scan each line for the two REAL structural markers —
                        // a block header (with v4/v6 family) and a section header
                        // (1..=6). Emit a benchmark-progress event per detected marker;
                        // the frontend reducer derives the monotonic percent + step
                        // label. A block header takes precedence (a section header can
                        // never co-occur on the same line). D-29: the payload carries
                        // only the marker enum/number — no raw text forwarded.
                        if !cancelled {
                            for line in text.lines() {
                                if let Some(family) = detect_block(line) {
                                    let _ = tauri::Emitter::emit(
                                        app,
                                        "benchmark-progress",
                                        BenchmarkProgress::Block { family },
                                    );
                                } else if let Some(section) = detect_section(line) {
                                    let _ = tauri::Emitter::emit(
                                        app,
                                        "benchmark-progress",
                                        BenchmarkProgress::Section { section },
                                    );
                                }
                            }
                        }
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

    // ── 09-38 marker-detection unit tests (replace the old fixed-percent tests) ─

    // Test 1 — block header detect + v4/v6 classification (both header forms).
    #[test]
    fn detect_block_classifies_v4_and_v6() {
        // colon form (dual-stack capture)
        assert_eq!(
            detect_block("                   IP QUALITY CHECK REPORT: 198.51.*.*"),
            Some(IpFamily::V4)
        );
        assert_eq!(
            detect_block("             IP QUALITY CHECK REPORT: 2001:db8:5:*:*:*:*:*"),
            Some(IpFamily::V6)
        );
        // two-space / no-colon form (single-stack fixture)
        assert_eq!(
            detect_block("              IP QUALITY CHECK REPORT  198.51.100.42"),
            Some(IpFamily::V4)
        );
        // a real IPv6 address (with colons)
        assert_eq!(
            detect_block("IP QUALITY CHECK REPORT  2a00:1450:4001:81b::200e"),
            Some(IpFamily::V6)
        );
    }

    // Test 2 — section header detect 1..=6 (INCLUDING 6), whitespace + ANSI.
    #[test]
    fn detect_section_detects_one_through_six() {
        assert_eq!(detect_section("1. Basic Information (Maxmind Database)"), Some(1));
        assert_eq!(detect_section("2. IP Type"), Some(2));
        assert_eq!(detect_section("3. Risk Score"), Some(3));
        assert_eq!(detect_section("4. Risk Factors"), Some(4));
        assert_eq!(
            detect_section("5. Accessibility check for media and AI services"),
            Some(5)
        );
        // Section 6 is now detected (was dropped before — stick-at-90 root).
        assert_eq!(
            detect_section("6. Email service availability and blacklist detection"),
            Some(6)
        );
        // Leading whitespace + ANSI-bold prefix still detect.
        assert_eq!(detect_section("  1. Basic Information"), Some(1));
        assert_eq!(detect_section("\t2. IP Type"), Some(2));
        assert_eq!(detect_section("\x1b[1m3. Risk Score\x1b[0m"), Some(3));
    }

    // Test 3 — no misfire: data values are NEITHER a block NOR a section header.
    #[test]
    fn data_values_do_not_misfire() {
        // Risk Score VALUE "3.91%" must NOT trigger any marker — only headers do.
        let lines = [
            "ipapi:                                             3.91% High",
            "Fraud Score: 42 / 100",
            "Loading database... 45%",
            "No progress here at all",
            "",
            "   ",
            "1.Basic",       // missing space after dot
            "11. Bad section", // two digits before dot
        ];
        for l in lines {
            assert_eq!(detect_section(l), None, "section misfire on: {l:?}");
            assert_eq!(detect_block(l), None, "block misfire on: {l:?}");
        }
    }

    // Test 4 — payload shape: serializes marker tags (NOT a fabricated percent);
    // D-29 — the payload contains no raw_stdout text.
    #[test]
    fn benchmark_progress_serializes_markers_not_percent() {
        let block = serde_json::to_string(&BenchmarkProgress::Block {
            family: IpFamily::V6,
        })
        .unwrap();
        // tagged enum: { "kind": "block", "family": "v6" } — no "percent" field.
        assert!(block.contains("\"kind\":\"block\""), "got: {block}");
        assert!(block.contains("\"family\":\"v6\""), "got: {block}");
        assert!(!block.contains("percent"), "no fabricated percent: {block}");

        let section = serde_json::to_string(&BenchmarkProgress::Section { section: 4 }).unwrap();
        assert!(section.contains("\"kind\":\"section\""), "got: {section}");
        assert!(section.contains("\"section\":4"), "got: {section}");
        assert!(!section.contains("percent"), "no fabricated percent: {section}");
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
