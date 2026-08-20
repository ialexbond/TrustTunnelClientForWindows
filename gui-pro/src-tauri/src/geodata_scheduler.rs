//! Window-independent background geodata updater (D-10, D-11).
//!
//! Before Phase 23 the only freshness check was a 30-minute `setInterval` inside a React component
//! that had to be MOUNTED to run, so a user who never opened the Routing tab never updated. That
//! interval is the bug, not the pattern — the cadence belongs in the app process, where it survives
//! a closed window. This module is that process-level loop.
//!
//! It owns three decisions and nothing else: WHEN to run (the cadence), WHETHER to run (the
//! persisted toggle), and whether it is SAFE to re-resolve routing afterwards (the VPN gate). The
//! download, the parse guard and the atomic commit all live in `geodata_v2ray`.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use crate::commands::vpn::VpnStatus;
use crate::geodata::{self, ActiveGroups, GroupRefreshOutcome, RU_WHITELIST_GROUP_ID};
use crate::geodata_v2ray::{self, AutoUpdateOutcome, GeoDataState};
use crate::logging::log_app;
use crate::routing_rules::{self, RoutingRules};

/// D-11 — one check per day, mirroring the app/sidecar updater rhythm so the app has ONE update
/// cadence rather than three. `pub` because the group-cache pipeline (Plan 23-03) uses the very
/// same value as its cache TTL; sharing the constant is what stops the two from drifting apart.
pub const GEODATA_UPDATE_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// Wait before the FIRST check so a multi-megabyte download does not compete with the rest of
/// startup — `.setup()` also fires the connectivity monitor, the configs watcher, the TUN
/// normalisation and the protocol registration.
///
/// Was 45s. Owner feedback from the first real install: the user launches the app, opens
/// Маршрутизация immediately, sees the pre-update card and reads it as "the automatic update does
/// not work" — the log proved it fired 55s in, but by then the impression was already formed. The
/// other `.setup()` tasks settle in well under ten seconds on a cold start, so the extra 35s bought
/// nothing except that impression. Kept non-zero: a download starting in the same instant as window
/// creation still competes with it.
const STARTUP_SETTLE_SECS: u64 = 8;

/// D-01/D-02 — may the scheduler re-resolve routing right now?
///
/// Written as a POSITIVE match on the two safe states, deliberately NOT as `!= Connected`. The enum
/// has SEVEN variants, and `Connecting` / `Reconnecting` / `Recovering` are exactly the racy
/// windows: a connect that is mid-flight is about to read the resolved files, and rewriting them
/// underneath it is how a reconnect comes up with routes from the previous generation. An
/// inequality check would silently let all three through.
///
/// Pure, so it is unit-testable with no app, no network and no admin rights.
pub fn safe_to_apply(status: VpnStatus) -> bool {
    matches!(status, VpnStatus::Disconnected | VpnStatus::Error)
}

/// IN-03 — the wake signal that lets a freshly switched-ON toggle take effect now.
///
/// D-13's "flip it OFF and the background work stops" was already true, because the toggle is
/// re-read from disk on every iteration. The reverse was not symmetric: the loop is parked in
/// `sleep(24h)` when the user switches it ON, so nothing happened until that sleep expired or the
/// app restarted. A default-ON feature the user just re-enabled must not look broken for a day.
///
/// A `Notify` woken by the setter is the project's existing idiom for exactly this
/// (`connectivity::start_monitor`). Deliberately fired ONLY on an OFF→ON transition, so repeatedly
/// saving the same value — or switching it off — cannot drive the loop.
///
/// A process-wide `OnceLock` rather than a field: the writer is a `#[tauri::command]` free function
/// with no access to the scheduler's captured state, and there is exactly one loop per process.
pub fn auto_update_wake() -> &'static tokio::sync::Notify {
    static WAKE: std::sync::OnceLock<tokio::sync::Notify> = std::sync::OnceLock::new();
    WAKE.get_or_init(tokio::sync::Notify::new)
}

/// IN-01 — reduce a `.dat` update failure to a stable CLASS for the app log.
///
/// The classes are the four things support actually needs to tell apart: could we ASK what the
/// latest release is, could we FETCH it, did our own URL guard refuse a hop, and did the commit
/// fail on disk. Matched on this crate's own error prefixes rather than on the underlying
/// `io::Error` / `reqwest::Error` text, which is OS- and version-dependent.
///
/// Returns `&'static str`, so nothing from the error itself can reach the log through this
/// function — the property is structural rather than a promise in a comment.
///
/// Pure, so every arm is testable with no network and no filesystem.
pub fn classify_dat_failure(error: &str) -> &'static str {
    if error.starts_with("Failed to check for updates")
        || error.starts_with("Failed to parse response")
    {
        "release check unavailable"
    } else if error.starts_with("Failed to download") {
        "download failed"
    } else if error.starts_with("Geodata URL")
        || error.starts_with("Geodata downloads only allowed")
        || error.starts_with("Invalid geodata URL")
        || error.contains("too many geodata redirects")
    {
        "refused by the URL guard"
    } else if error.starts_with("HTTP client error") {
        "HTTP client could not be built"
    } else if error.starts_with("Failed to create")
        || error.starts_with("Failed to write")
        || error.starts_with("Failed to fsync")
        || error.starts_with("Failed to swap")
        || error.starts_with("Failed to serialize")
        || error.starts_with("atomic write:")
    {
        "commit to disk failed"
    } else if error.starts_with("geodata commit task failed") {
        "commit task panicked"
    } else {
        "other"
    }
}

/// Same idea for the re-resolve leg: a CLASS, never the raw error.
///
/// `resolve_entries` builds its failures around a group id — "Failed to parse group cache
/// '<group>'" — and that id is a hand-typed routing rule, i.e. the user's own text. T-23-18 keeps
/// user content off the app-log channel; this classifier is what makes that hold for the leg CR-01
/// added, not only for the counts line it was written for.
pub fn classify_resolve_failure(error: &str) -> &'static str {
    if error.contains("group cache") {
        // Covers both the read and the parse leg; which one it was is on stderr.
        "a group cache could not be read"
    } else if error.starts_with("Failed to write") || error.starts_with("atomic write:") {
        "writing the resolved files failed"
    } else if error.starts_with("Failed to read") || error.starts_with("Failed to parse") {
        "reading the routing rules failed"
    } else {
        "other"
    }
}

/// Start the background update loop. Returns immediately.
///
/// Takes an `AppHandle` for PROGRESS ONLY.
///
/// It used to take none, deliberately: D-04 said a successful automatic update is fully silent, and
/// the cleanest way to guarantee that was structural — with no handle in scope, no future edit could
/// grow a progress bar nobody asked for. The owner reversed that after using the shipped build:
/// "кнопка в Disable ушла и всё" — a control greying out with nothing else moving reads as a frozen
/// app, not as a discreet one. A background download of tens of megabytes should look like a
/// download.
///
/// What the reversal does NOT license: no notification, no snackbar, no alarm badge, and no
/// failure ever reaches the screen (D-08/D-09 — a failed cycle stays silent and retries). The handle
/// is used at exactly one call site, `auto_update_dat_inner`, and only to forward byte progress.
///
/// `tauri::async_runtime::spawn` (not `tokio::spawn`, not `std::thread::spawn`) because `.setup()`
/// runs outside the async context — this is the same shape `connectivity::start_monitor` uses. No
/// cancellation handle is needed: the task dies with the process.
pub fn start_geodata_scheduler(
    app: tauri::AppHandle,
    geo_state: Arc<GeoDataState>,
    vpn_status: Arc<std::sync::Mutex<VpnStatus>>,
    config_path: Arc<std::sync::Mutex<Option<String>>>,
    lifecycle_flow: Arc<tokio::sync::Mutex<()>>,
) {
    tauri::async_runtime::spawn(async move {
        log_app("INFO", "[geodata] Scheduler started");
        tokio::time::sleep(Duration::from_secs(STARTUP_SETTLE_SECS)).await;

        loop {
            // IN-03: the wake future is constructed HERE, at the top of the iteration, and enabled
            // so the waiter is queued immediately. `notify_waiters()` stores no permit — it only
            // reaches waiters that already exist — so building it inside the `select!` below would
            // drop any flip to ON that landed while this iteration was inside `run_cycle` (a cycle
            // can run for minutes on a slow link), and the user would still wait a full day.
            let mut woken = std::pin::pin!(auto_update_wake().notified());
            woken.as_mut().enable();

            // D-13: the toggle is re-read FROM DISK on every iteration, never captured at spawn.
            // That is what makes "flip it in Settings and the background work stops" true without
            // a restart.
            if crate::app_settings::load_app_settings().geodata_auto_update {
                run_cycle(&app, &geo_state, &vpn_status, &config_path, &lifecycle_flow).await;
            }

            // `sleep`, not `interval`: a slow cycle must not produce burst catch-up ticks.
            //
            // IN-03: ...and the sleep is interruptible. The wake fires only on an OFF→ON
            // transition, so this cannot become a spin: switching OFF, or re-saving the same value,
            // signals nothing, and a woken iteration re-reads the toggle from disk like any other.
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(GEODATA_UPDATE_INTERVAL_SECS)) => {}
                _ = &mut woken => {
                    log_app("INFO", "[geodata] auto-update switched on — checking now");
                }
            }
        }
    });
}

/// One update cycle. Every failure leg — network unreachable, HTTP error, guard rejection, write
/// error — is silent to the user, leaves the old data untouched, and simply falls through to the
/// next cycle (D-08, D-09).
///
/// The `app` handle is for PROGRESS ONLY (see `start_geodata_scheduler`): a running download reports
/// itself on the card. Failures stay silent — D-08/D-09 are untouched.
async fn run_cycle(
    app: &tauri::AppHandle,
    geo_state: &Arc<GeoDataState>,
    vpn_status: &Arc<std::sync::Mutex<VpnStatus>>,
    config_path: &Arc<std::sync::Mutex<Option<String>>>,
    lifecycle_flow: &Arc<tokio::sync::Mutex<()>>,
) {
    // Both halves of the cycle feed one flag, and the apply gate is consulted ONCE at the end.
    // Two gate call sites would mean two `VpnStatus` reads and two re-resolves in a cycle that
    // refreshed both a `.dat` file and a group cache — the second doing the first one's work again.
    //
    // Note the missing early `return` between them: a `.dat` fetch that failed (upstream down, no
    // network) says nothing about the group sources, which are different hosts entirely. The group
    // half runs regardless — one dead source must not freeze the other pipeline for a day.
    let mut anything_changed = refresh_dat_files(app, geo_state).await;

    // ── Half 2: the group caches (D-14) ──
    // Deliberately OUTSIDE the single-flight guard — see `refresh_dat_files`. Same per-cycle toggle
    // read: one toggle still governs the whole automatic path (D-13).
    if refresh_group_caches().await {
        anything_changed = true;
    }

    if anything_changed {
        apply_if_safe(geo_state, vpn_status, config_path, lifecycle_flow).await;
    }
}

/// Half 1 of a cycle: the `.dat` databases. Returns true when a new release was committed.
///
/// **Why the single-flight guard lives HERE and not around the whole cycle (WR-02).** D-17's guard
/// exists so the scheduler and the manual «Обновить» button are never two writers against the same
/// files. Those files are `geoip.dat`, `geosite.dat` and the meta — exactly what this half and
/// `download_geodata` touch, and nothing else. The group half writes only `group_cache/<id>.json`,
/// which `download_geodata` never opens; the two manual group commands that DO write them
/// (`fetch_whitelist_domains`, `fetch_iplist_group_domains`) have never taken this guard, so
/// holding it across the group half protected nothing.
///
/// What it cost was real: the group half is up to 18 sequential fetches, and for that whole window
/// the manual button returned `GEODATA_ALREADY_UPDATING` — a button dead for minutes with no
/// explanation beyond a snackbar, because the automatic path is silent by construction (D-04).
/// Scoping the guard to the half it actually guards satisfies D-17 more literally, not less.
///
/// It is still held across the ENTIRE download → parse → write → memory-refresh sequence inside
/// `auto_update_dat_inner`, which is the part that matters: `resolve_entries` reads categories from
/// memory but group caches from disk, so releasing it earlier would open a mixed-state window.
async fn refresh_dat_files(app: &tauri::AppHandle, geo_state: &Arc<GeoDataState>) -> bool {
    // D-17: skip this cycle rather than queue behind a manual download. Non-blocking `try_lock`,
    // never an awaited acquisition — a queued cycle would fire a second full download the moment
    // the user's one finished, against files that are already fresh.
    let _update_guard = match geo_state.update_in_flight.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            log_app(
                "INFO",
                "[geodata] auto-update: skipped — another update is already in flight",
            );
            return false;
        }
    };
    // The card's button is disabled while this runs. Not a D-04 violation: nothing is announced,
    // shown or badged — a control that cannot succeed simply stops offering to be pressed. Before
    // this, the button stayed enabled through the whole background download and answered a click
    // with GEODATA_ALREADY_UPDATING, which reads as a broken button.
    let _busy = geodata_v2ray::BusyFlag::acquire();

    // The handle is passed now, so the automatic download reports progress on the same
    // `geodata-progress` channel a manual one uses. This REVERSES D-04's "fully silent" for the
    // download itself — the call after seeing the shipped behaviour: a disabled button with
    // nothing else moving reads as a frozen app, not as a quiet one. Everything else about D-04
    // stands: no notification, no snackbar, no alarm badge, and failures remain silent (D-08/D-09).
    match geodata_v2ray::auto_update_dat_inner(Some(app), geo_state).await {
        // D-06: one line, outcome only.
        //
        // IN-01: the outcome is a CLASS, not the raw error. Interpolating `{e}` put a reqwest
        // `Display` into app.log, which carries the full request URL and transport internals —
        // broader than D-06's "result + resulting version", and inconsistent with the group half,
        // which already logs counts only and drops its error strings deliberately. D-29 (passwords
        // never on the log channel) was never at risk here: these URLs are public compile-time
        // constants. This is log hygiene, and it keeps the one line useful for support — the class
        // is what distinguishes "no network" from "the guard refused it".
        // The detail stays on stderr, where the download helpers already print it.
        Err(e) => {
            eprintln!("[geodata] auto-update failed: {e}");
            log_app(
                "INFO",
                &format!("[geodata] auto-update failed: {}", classify_dat_failure(&e)),
            );
            false
        }
        Ok(AutoUpdateOutcome::UpToDate) => {
            log_app("INFO", "[geodata] auto-update: already up to date");
            false
        }
        Ok(AutoUpdateOutcome::Rejected) => {
            log_app(
                "WARN",
                "[geodata] auto-update: download rejected by the parse guard — previous database kept",
            );
            false
        }
        Ok(AutoUpdateOutcome::Updated { tag }) => {
            log_app("INFO", &format!("[geodata] auto-update: updated to {tag}"));
            true
        }
    }
}

/// Refresh every group cache the user is actually using and that is older than the cadence.
/// Returns true when at least one cache was replaced, i.e. when routing has something new to see.
///
/// There is no in-memory refresh step here and no analogue of the `.dat` mixed-state hazard:
/// `routing_rules::resolve_entries` reads group caches from DISK on every resolve, so an atomic
/// file swap IS the update.
async fn refresh_group_caches() -> bool {
    // Both truth sources fail open to empty: a corrupt routing_rules.json must not stop the
    // whitelist from refreshing, and vice versa.
    let active = geodata::load_active_groups().unwrap_or_default();
    let rules = routing_rules::load_routing_rules().unwrap_or_default();
    let ids = groups_to_refresh(&active, &rules);

    // OQ-3: the loop's own cadence IS the TTL. One number, so "how often we check" and "when a
    // cache counts as old" cannot drift apart into a cache that is always or never stale.
    let ttl = Duration::from_secs(GEODATA_UPDATE_INTERVAL_SECS);

    let considered = ids.len();
    let (mut refreshed, mut rejected, mut failed) = (0usize, 0usize, 0usize);

    for id in ids {
        // Each id is handled independently: a group whose source is down, whose id no longer
        // exists upstream, or whose result was refused must not abort the rest of the cycle. Every
        // failure leg is silent to the user, leaves that cache untouched, and is retried next
        // cycle (D-08, D-09).
        match geodata::refresh_group_cache_if_stale(&id, ttl).await {
            Ok(GroupRefreshOutcome::Fresh) => {}
            Ok(GroupRefreshOutcome::Refreshed { .. }) => refreshed += 1,
            Ok(GroupRefreshOutcome::Rejected) => rejected += 1,
            Err(_) => failed += 1,
        }
    }

    // D-06 / T-23-18: one summary line per cycle, COUNTS ONLY. No group ids, no domains, no cache
    // paths — the error strings are deliberately dropped here rather than interpolated, because a
    // group id is user-supplied content and app.log is not the place for it.
    log_app(
        "INFO",
        &format!(
            "[geodata] group caches: {considered} considered, {refreshed} refreshed, \
             {rejected} rejected, {failed} failed"
        ),
    );

    refreshed > 0
}

/// Which group caches this cycle should consider — the deduplicated UNION of the two places a
/// group can be in use.
///
/// 1. `active_groups.json`: the tiles the user switched on, plus the reserved RU whitelist.
/// 2. `routing_rules.json`: every `iplist_group` entry across direct / proxy / block. A manually
///    typed `iplist_group:<id>` rule never touches the active-groups file, so this source is not
///    redundant — without it a hand-written rule would resolve against a cache that never updates.
///
/// The prefix is stripped tolerantly (present or absent both yield the bare id), mirroring exactly
/// what the resolve path does, so the selector and the reader agree on what a rule names.
///
/// Deliberately NOT a listing of the cache directory. That would resurrect every group the user
/// ever tried and then removed: the refresh set would only ever grow, and the app would spend its
/// daily cycle re-fetching data nothing reads. Removing a group must remove it from the cycle.
///
/// Pure, so all of this is testable with no filesystem and no network.
pub fn groups_to_refresh(active: &ActiveGroups, rules: &RoutingRules) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out: Vec<String> = Vec::new();

    let mut push = |id: &str| {
        if !id.is_empty() && seen.insert(id.to_string()) {
            out.push(id.to_string());
        }
    };

    if active.ru_whitelist {
        push(RU_WHITELIST_GROUP_ID);
    }
    for id in &active.iplist_groups {
        push(id);
    }

    for entry in rules
        .direct
        .iter()
        .chain(rules.proxy.iter())
        .chain(rules.block.iter())
    {
        if entry.entry_type != "iplist_group" {
            continue;
        }
        let id = entry
            .value
            .strip_prefix("iplist_group:")
            .unwrap_or(&entry.value);
        push(id);
    }

    out
}

/// What the apply gate decided. Returned rather than logged-and-forgotten so the "a lifecycle
/// command owns the files right now" leg is assertable in a unit test without a filesystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// The re-resolve ran (its own success/failure is logged, not surfaced — D-04/D-08).
    Applied,
    /// `lifecycle_flow` is held by a connect / disconnect / tray twin. CR-01.
    DeferredBusy,
    /// The tunnel is not idle (D-01).
    DeferredTunnel,
}

/// Re-resolve routing from the fresh database — but only while the tunnel is down (D-01) AND no
/// lifecycle command owns the resolved files (CR-01).
///
/// **Why `lifecycle_flow` is taken here.** `resolve_and_apply_inner` writes five rule files the C++
/// core reads at spawn, plus the active `.toml`. Before Phase 23 it had exactly three callers —
/// `vpn_connect`, the supervised respawn and the tray connect — and ALL THREE hold
/// `state.lifecycle_flow` for their whole body. The scheduler is the fourth. Without the same lock
/// the D-01 status check is a check with no enforcement: the user can press Connect between the
/// `VpnStatus` read and the first `std::fs::write`, and both sides then rewrite (truncate-first!)
/// the same megabyte-scale `exclusions.txt` the core is about to open. Taking the serializer FIRST
/// and re-reading the status UNDERNEATH it makes the gate and the write one atomic unit with
/// respect to every user-initiated lifecycle command.
///
/// **`try_lock`, never `lock().await`.** Two reasons. (1) A background refresh must never queue in
/// front of — or behind — a user action; if a connect is in flight, skipping is not merely
/// acceptable but *correct*, because that connect re-resolves from the already-committed fresh
/// files itself (D-03). (2) Deadlock safety: a non-blocking acquisition cannot wait on anything, so
/// this path cannot participate in a cycle no matter what else is held.
///
/// FAB-04: an earlier version of this comment claimed the call happens "while `update_in_flight` is
/// held". That stopped being true when WR-02 narrowed that guard to the `.dat` half — it is dropped
/// before `run_cycle` reaches the apply. The safety conclusion is unchanged (fewer locks held, and
/// `try_lock` cannot block), but the stated reason was wrong, and a wrong reason is what a future
/// edit reasons from.
///
/// When the gate refuses, we do NOTHING at all, and that is complete: the files are already
/// committed to disk, and every connect path re-resolves from scratch before spawning the core, so
/// the deferred apply flushes for free on the next connect (D-03). A persisted "pending apply" flag
/// would be a second source of truth for something the connect path already guarantees.
async fn apply_if_safe(
    geo_state: &Arc<GeoDataState>,
    vpn_status: &Arc<std::sync::Mutex<VpnStatus>>,
    config_path: &Arc<std::sync::Mutex<Option<String>>>,
    lifecycle_flow: &Arc<tokio::sync::Mutex<()>>,
) -> ApplyOutcome {
    // CR-01: the serializer FIRST — everything below runs underneath it, including the D-01 read.
    let Ok(_flow_guard) = lifecycle_flow.try_lock() else {
        log_app(
            "INFO",
            "[geodata] auto-update: routing re-resolve deferred — a lifecycle command is in flight",
        );
        return ApplyOutcome::DeferredBusy;
    };

    // Scoped locks: `VpnStatus` is `Copy` and the path is cloned, so no `std::sync` guard survives
    // past this function (a guard held across an `.await` would make the spawned future non-`Send`).
    let status = match vpn_status.lock() {
        Ok(guard) => *guard,
        Err(poisoned) => *poisoned.into_inner(),
    };
    if !safe_to_apply(status) {
        log_app(
            "INFO",
            "[geodata] auto-update: routing re-resolve deferred — tunnel is not idle",
        );
        return ApplyOutcome::DeferredTunnel;
    }

    // An empty string is the correct fallback: `resolve_and_apply_inner` handles "no config yet"
    // explicitly (it skips the TOML patch and still writes the resolved rule files).
    let path = config_path
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default();

    // WR-04: the resolve is five file writes plus a TOML read-modify-write, all synchronous and
    // all measured in megabytes for a RU-whitelist-sized rule set. Run inline it parks a tokio
    // worker shared with the connectivity monitor, the SSH pool and every async Tauri command.
    //
    // `_flow_guard` is deliberately still held across this await — that is the whole point of
    // CR-01, and a `tokio::sync::MutexGuard` is `Send`, so holding it is legal and correct here.
    let geo = Arc::clone(geo_state);
    let resolved = tokio::task::spawn_blocking(move || {
        let rules = routing_rules::load_routing_rules().unwrap_or_default();
        routing_rules::resolve_and_apply_inner(&path, &rules, &geo)
    })
    .await;

    match resolved {
        Ok(Ok(())) => {}
        // The class, not the raw error — same rule IN-01 applied to the `.dat` leg, for the same
        // reason. `resolve_entries` builds its failures as "Failed to parse group cache '<group>'",
        // and `<group>` is a hand-typed routing rule: user content, which is exactly what T-23-18's
        // counts-only logging exists to keep off this channel. The id is whitelist-bounded
        // (`[a-z0-9_-]`, ≤64) so no path and no secret could ride along, but "bounded" is not the
        // test — "is it the user's own text" is. The detail stays on stderr.
        Ok(Err(e)) => {
            eprintln!("[geodata] auto-update: re-resolve failed: {e}");
            log_app(
                "WARN",
                &format!(
                    "[geodata] auto-update: re-resolve failed: {}",
                    classify_resolve_failure(&e)
                ),
            );
        }
        Err(e) => {
            eprintln!("[geodata] auto-update: re-resolve task failed: {e}");
            log_app("WARN", "[geodata] auto-update: re-resolve task failed: join error");
        }
    }
    ApplyOutcome::Applied
}

#[cfg(test)]
mod tests {
    use super::*;

    /// D-01/D-02 truth, locked across ALL seven `VpnStatus` variants: the background re-resolve
    /// runs only while the tunnel is genuinely idle. The three in-flight states are the point of
    /// the test — a `!= Connected` gate would pass them and rewrite resolved files under a connect
    /// that is about to read them.
    #[test]
    fn safe_to_apply_allows_only_the_two_idle_states() {
        assert!(safe_to_apply(VpnStatus::Disconnected), "idle: safe");
        assert!(safe_to_apply(VpnStatus::Error), "failed and idle: safe");

        assert!(!safe_to_apply(VpnStatus::Connected), "live tunnel must never be touched");
        assert!(!safe_to_apply(VpnStatus::Connecting), "connect is mid-flight");
        assert!(!safe_to_apply(VpnStatus::Reconnecting), "tunnel re-establish is mid-flight");
        assert!(!safe_to_apply(VpnStatus::Recovering), "waiting for the adapter, connect will follow");
        assert!(!safe_to_apply(VpnStatus::Disconnecting), "teardown is mid-flight");
    }

    /// IN-03 truth: a wake that arrives while the loop is busy is NOT lost.
    ///
    /// `notify_waiters()` stores no permit — it only reaches waiters that already exist. The loop
    /// therefore constructs its `Notified` at the TOP of the iteration and enables it, so a user
    /// switching the toggle ON while the cycle is running (downloads can take minutes) is still
    /// served rather than left waiting a full day.
    ///
    /// The second half pins the failure mode that placement prevents: a notify sent before the
    /// future exists is gone for good. That is what building the future inside the `select!` would
    /// have produced.
    #[tokio::test]
    async fn a_wake_sent_while_the_loop_is_busy_is_still_delivered() {
        let mut woken = std::pin::pin!(auto_update_wake().notified());
        woken.as_mut().enable();

        // Stands in for the cycle running between registration and the select.
        tokio::task::yield_now().await;
        auto_update_wake().notify_waiters();

        tokio::time::timeout(Duration::from_secs(5), woken)
            .await
            .expect("a waiter registered before the cycle must receive a notify sent during it");

        // A notify that lands BEFORE the waiter exists is lost — no permit is stored. This is why
        // the future is built at the top of the loop body and not inside the `select!`.
        let notify = tokio::sync::Notify::new();
        notify.notify_waiters();
        let late = notify.notified();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), late).await.is_err(),
            "notify_waiters stores no permit — a waiter created afterwards must not be woken"
        );
    }

    /// IN-01 truth: the app-log line carries a class, and the class carries nothing from the error.
    ///
    /// The realistic inputs are the ones that matter — a reqwest `Display` interpolated by
    /// `download_bytes` includes the full request URL, which is what used to land in app.log. The
    /// last assertion is the invariant that survives future edits: whatever the input, the returned
    /// string is one of a fixed set, so no substring of the error can ever be logged through here.
    #[test]
    fn a_dat_failure_is_logged_as_a_class_and_never_as_the_raw_error() {
        assert_eq!(
            classify_dat_failure(
                "Failed to download geoip.dat after 3 attempts: error sending request for url \
                 (https://github.com/v2fly/geoip/releases/latest/download/geoip.dat)"
            ),
            "download failed"
        );
        assert_eq!(
            classify_dat_failure("Failed to check for updates: connection refused"),
            "release check unavailable"
        );
        assert_eq!(
            classify_dat_failure("Geodata downloads only allowed from: github.com, ..."),
            "refused by the URL guard"
        );
        assert_eq!(
            classify_dat_failure("Failed to swap file into place: Access is denied. (os error 5)"),
            "commit to disk failed"
        );
        assert_eq!(classify_dat_failure("something nobody predicted"), "other");

        // The whole point: a URL present in the input can never appear in the output, because the
        // output is drawn from a fixed set of `&'static str`s.
        const CLASSES: [&str; 7] = [
            "release check unavailable",
            "download failed",
            "refused by the URL guard",
            "HTTP client could not be built",
            "commit to disk failed",
            "commit task panicked",
            "other",
        ];
        for probe in [
            "Failed to download geosite.dat after 3 attempts: https://evil.test/leak?token=abc",
            "HTTP client error: builder error",
            "geodata commit task failed: task panicked",
            "",
        ] {
            let class = classify_dat_failure(probe);
            assert!(CLASSES.contains(&class), "unexpected class {class} for {probe}");
            assert!(
                !class.contains("http"),
                "no class may echo a URL fragment from the error"
            );
        }
    }

    /// T-23-18 for the re-resolve leg: the app-log line must not carry the USER'S OWN TEXT.
    ///
    /// `resolve_entries` names the offending group in its error — "Failed to parse group cache
    /// '<group>'" — and that id comes from a hand-typed routing rule. The whitelist keeps it
    /// harmless (`[a-z0-9_-]`, ≤64, so no path and no secret), but the rule this pins is not "is it
    /// harmless", it is "is it the user's content": user content does not go on this channel.
    #[test]
    fn the_resolve_classifier_never_echoes_a_group_id() {
        const CLASSES: [&str; 4] = [
            "a group cache could not be read",
            "writing the resolved files failed",
            "reading the routing rules failed",
            "other",
        ];
        for probe in [
            "Failed to parse group cache 'my-private-group': expected value at line 1 column 1",
            "Failed to read group cache 'another_one': The system cannot find the file specified.",
            "Failed to write resolved file: Access is denied. (os error 5)",
            "something nobody predicted",
            "",
        ] {
            let class = classify_resolve_failure(probe);
            assert!(CLASSES.contains(&class), "unexpected class {class} for {probe}");
            assert!(
                !class.contains("my-private-group") && !class.contains("another_one"),
                "no class may echo the group id from the error"
            );
            assert!(
                !class.contains('\''),
                "a quoted fragment in a class would mean the id leaked through"
            );
        }
    }

    /// CR-01 truth: the background re-resolve is serialized against the lifecycle commands.
    ///
    /// `resolve_and_apply_inner` rewrites the five resolved rule files the C++ core opens at spawn,
    /// with truncate-first `std::fs::write`. Its three pre-existing callers all hold
    /// `lifecycle_flow`; this asserts the scheduler now behaves as the fourth one — while a
    /// connect/disconnect owns the serializer, the cycle DEFERS instead of writing underneath it.
    ///
    /// The assertion also proves the refusal happens BEFORE any filesystem work: the test holds the
    /// lock and the call returns without touching the real data dir (there is no temp-dir setup
    /// here, so a leaked write would show up as a modified developer install).
    ///
    /// `try_lock`, not `lock().await`, is what makes this safe to call while `update_in_flight` is
    /// held — a non-blocking acquisition cannot deadlock against any lock ordering.
    #[tokio::test]
    async fn the_re_resolve_defers_while_a_lifecycle_command_holds_the_flow_lock() {
        let geo_state = Arc::new(GeoDataState::new());
        let vpn_status = Arc::new(std::sync::Mutex::new(VpnStatus::Disconnected));
        let config_path = Arc::new(std::sync::Mutex::new(None));
        let lifecycle_flow = Arc::new(tokio::sync::Mutex::new(()));

        // Stand in for `vpn_connect` / `vpn_disconnect` / the tray twins, all of which hold this
        // for their whole body.
        let held = Arc::clone(&lifecycle_flow).lock_owned().await;

        let outcome = apply_if_safe(&geo_state, &vpn_status, &config_path, &lifecycle_flow).await;
        assert_eq!(
            outcome,
            ApplyOutcome::DeferredBusy,
            "an idle VpnStatus must NOT be enough — a lifecycle command in flight owns the files"
        );

        drop(held);
        assert!(
            lifecycle_flow.try_lock().is_ok(),
            "the deferred path must not have leaked a guard of its own"
        );
    }

    /// The gate is taken UNDER the lock, so a not-idle tunnel is still refused once the serializer
    /// is free — the two conditions are independent, and CR-01's fix must not have replaced D-01's
    /// status check with a lock check.
    #[tokio::test]
    async fn the_re_resolve_still_defers_on_a_live_tunnel_when_the_flow_lock_is_free() {
        let geo_state = Arc::new(GeoDataState::new());
        let vpn_status = Arc::new(std::sync::Mutex::new(VpnStatus::Connected));
        let config_path = Arc::new(std::sync::Mutex::new(None));
        let lifecycle_flow = Arc::new(tokio::sync::Mutex::new(()));

        assert_eq!(
            apply_if_safe(&geo_state, &vpn_status, &config_path, &lifecycle_flow).await,
            ApplyOutcome::DeferredTunnel,
            "D-01 still governs: a live tunnel is never re-resolved under the scheduler"
        );
    }

    use crate::routing_rules::RuleEntry;

    fn iplist_rule(value: &str) -> RuleEntry {
        RuleEntry {
            id: format!("test-{value}"),
            entry_type: "iplist_group".to_string(),
            value: value.to_string(),
            label: None,
        }
    }

    fn other_rule(entry_type: &str, value: &str) -> RuleEntry {
        RuleEntry {
            id: format!("test-{value}"),
            entry_type: entry_type.to_string(),
            value: value.to_string(),
            label: None,
        }
    }

    /// D-14 truth: the refresh set is the UNION of the two truth sources, deduplicated. The
    /// duplicate case is the one that matters — a tile the user switched on is also written into
    /// routing_rules.json, so every ordinary group appears in BOTH sources and a naive
    /// concatenation would fetch each of them twice a day.
    #[test]
    fn groups_to_refresh_unions_both_truth_sources_without_duplicates() {
        let active = ActiveGroups {
            ru_whitelist: true,
            iplist_groups: vec!["games".to_string(), "youtube".to_string()],
        };
        let rules = RoutingRules {
            direct: vec![iplist_rule("iplist_group:games")],
            proxy: vec![iplist_rule("iplist_group:music")],
            block: vec![iplist_rule("porn")],
            ..RoutingRules::default()
        };

        let selected = groups_to_refresh(&active, &rules);

        assert_eq!(
            selected.iter().filter(|id| *id == "games").count(),
            1,
            "a group present in BOTH sources must be refreshed once, not twice"
        );
        assert!(selected.contains(&"youtube".to_string()), "active-only group is included");
        assert!(selected.contains(&"music".to_string()), "rules-only group is included");
        assert!(
            selected.contains(&"porn".to_string()),
            "a legacy bare value (no prefix) resolves to the same bare id"
        );
        assert!(
            selected.contains(&RU_WHITELIST_GROUP_ID.to_string()),
            "the reserved whitelist id is included when its flag is set"
        );
        assert_eq!(selected.len(), 5, "exactly the five distinct ids, nothing else");
    }

    /// The reserved whitelist id follows its flag, and nothing else conjures it up.
    #[test]
    fn groups_to_refresh_includes_the_whitelist_only_when_its_flag_is_set() {
        let off = ActiveGroups { ru_whitelist: false, iplist_groups: vec![] };
        assert!(
            !groups_to_refresh(&off, &RoutingRules::default())
                .contains(&RU_WHITELIST_GROUP_ID.to_string()),
            "whitelist off: nothing to refresh"
        );

        let on = ActiveGroups { ru_whitelist: true, iplist_groups: vec![] };
        assert_eq!(
            groups_to_refresh(&on, &RoutingRules::default()),
            vec![RU_WHITELIST_GROUP_ID.to_string()],
            "whitelist on: exactly the reserved id"
        );
    }

    /// The prefixed and bare forms of the same rule value are ONE group. `resolve_entries` strips
    /// the prefix tolerantly; a selector that did not would refresh `iplist_group:games` as if it
    /// were a group id of its own — which `is_valid_group_id` rejects (the colon), so the cache the
    /// resolve path actually reads would never be refreshed at all.
    #[test]
    fn groups_to_refresh_treats_prefixed_and_bare_values_as_one_group() {
        let rules = RoutingRules {
            direct: vec![iplist_rule("iplist_group:games"), iplist_rule("games")],
            ..RoutingRules::default()
        };
        assert_eq!(
            groups_to_refresh(&ActiveGroups::default(), &rules),
            vec!["games".to_string()]
        );
    }

    /// Only `iplist_group` entries name a group cache. A domain that happens to read like a group
    /// name, a geosite category or an IP must never become a fetch.
    #[test]
    fn groups_to_refresh_ignores_every_other_rule_type() {
        let rules = RoutingRules {
            direct: vec![
                other_rule("domain", "games"),
                other_rule("geosite", "geosite:games"),
            ],
            proxy: vec![other_rule("ip", "1.2.3.4"), other_rule("cidr", "10.0.0.0/8")],
            block: vec![other_rule("geoip", "geoip:ru")],
            ..RoutingRules::default()
        };
        assert!(
            groups_to_refresh(&ActiveGroups::default(), &rules).is_empty(),
            "no non-iplist_group entry may produce a refresh"
        );
    }

    /// The cadence and the settle delay must stay sane values: a settle delay longer than the
    /// interval would mean the first check never runs on a short session, and a zero interval would
    /// spin the loop.
    #[test]
    fn cadence_constants_are_coherent() {
        assert_eq!(GEODATA_UPDATE_INTERVAL_SECS, 24 * 60 * 60, "D-11: one check per day");
        // Const blocks: both operands are compile-time constants, so the ordering invariant is
        // proved while the test binary is compiled and cannot be skipped by a filtered run.
        // See connectivity.rs `offline_floor_is_snappy` for which command actually enforces it.
        const { assert!(STARTUP_SETTLE_SECS > 0, "the first check must not race startup work") };
        const {
            assert!(
                STARTUP_SETTLE_SECS < GEODATA_UPDATE_INTERVAL_SECS,
                "the settle delay must be far shorter than the cadence"
            )
        };
    }
}
