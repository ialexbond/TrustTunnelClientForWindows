//! First-launch adoption of a legacy data root that the new install no longer reads.
//!
//! # Why this module exists at all
//!
//! Phase 32 moves the install to Program Files (`installMode: perMachine`) and NAMES the data root
//! `%LOCALAPPDATA%\TrustTunnel Client Pro` instead of deriving it from the executable's location
//! (plan 32-01). On the overwhelmingly common machine those two are the same folder, so the rule
//! moved and the files did not — that identity is D-05 and it is why this is a rule change rather
//! than a migration.
//!
//! It is NOT the same folder for one population: the installer's directory page is present, so
//! `$INSTDIR` is user-editable, and anybody who chose a custom directory has their servers,
//! credentials and known hosts sitting in that folder. After 32-01 the application looks in
//! `%LOCALAPPDATA%\TrustTunnel Client Pro` — empty — and their data is silently orphaned. Nothing
//! reports it; the app simply looks new. That is research finding F2.
//!
//! # Why adoption runs HERE, in the app, and not in the installer
//!
//! An installer runs once per machine and can only ever see one user profile, so it can never
//! migrate for the second or third user of a machine; and when Windows asks a *different*
//! administrator for the password, the installer sees that administrator's profile, not the
//! owner's. Recovering the pre-elevation user from inside the installer was investigated and
//! REJECTED (D-08): every candidate mechanism is a heuristic sitting next to a destructive step,
//! and enumerating `ProfileList` would copy one user's plaintext SSH credentials into another
//! user's profile — a confidentiality regression, not a fix. First-launch adoption runs as the
//! real user *by construction*, which is the whole argument for it (D-07).
//!
//! # Every property below is drawn from a defect that actually shipped
//!
//! An earlier adoption existed (`lib::adopt_legacy_data_into`, plan 30.1-08) and was deleted on
//! 2026-08-28 together with the data-root revert. The full diagnosis is
//! `.planning/phases/30.1-*/30.1-REGRESSION.md`; the short version, from a real Windows install:
//!
//! * `configs.json` stores every server as an ABSOLUTE path. The old code copied the manifest as
//!   a blob, so every entry still named the old root. The path-confinement guard follows the data
//!   root by construction, so it refused all of them — while the folder-as-truth reconciler
//!   adopted the copied `.toml` files as a SECOND set of servers. Five servers displayed as ten,
//!   and the visible half of each pair was dead. Hence: parse, rewrite, never blob-copy
//!   ([`rewrite_entries_onto_root`]).
//! * Letting the reconciler rebuild the manifest instead (Repair 1 shape (b)) loses `name`,
//!   `order` and `last_used` — the user's card names and their priority ordering. Those are the
//!   user's own data. Hence: preserve them, and `copy` with them (it is `#[serde(default)]` and
//!   durable user intent).
//! * The previous summary line was UNREACHABLE code (Repair 7), so "it logged nothing" proved
//!   nothing and OPEN-5 could not be closed. Hence: the report goes through an injected channel a
//!   test exercises, and lands in a file that does not depend on the async logger being up.
//! * A failure here must never be reported as a success, and reporting it is not enough on its
//!   own. The manifest is written AFTER `ssh_credentials.json` and every `.toml` are already in
//!   the destination, so a failed write dressed up as `ConcurrentlyAdopted` left a folder full of
//!   configs with nothing describing them — which the folder reconciler names for the user, and
//!   which the next launch then drops as duplicates. Hence: [`AdoptionOutcome::Failed`] is its own
//!   fact and crosses to the window as `Err`; the copies come back out ([`roll_back`]); and a
//!   manifest that is PRESENT and unreadable refuses before anything is copied rather than
//!   defaulting to an empty list and writing that emptiness back over the user's `name`, `order`
//!   and `last_used` (phase 32 review CR-02).
//! * `tauri_plugin_single_instance` is registered inside `run()` (OPEN-5), so a second process
//!   launched concurrently gets all the way through adoption before it is told to exit. The marker
//!   gate cannot cover that — both processes can observe it absent. Hence: an exclusive
//!   create-new lock file around the whole operation.
//!
//! # Shape
//!
//! The decision lives in [`rewrite_entries_onto_root`], a total function of plain values with no
//! filesystem access, so it is assertable directly — the project's `pure-rule-plus-tests` shape
//! (`ssh/mod.rs::resolve_data_root`, `autostart.rs::reconcile_action`). [`adopt_into`] is the
//! filesystem shell around it and takes both roots as parameters, so the tests never mutate the
//! process environment and never touch the real data root. [`run_first_launch_adoption`] is the
//! thin production wrapper: it is the ONLY place that resolves the roots, and it resolves the
//! destination through `ssh::user_data_dir()` — the single accessor. **Do not add a second
//! data-root lookup here, not even "just for the migration"**: that funnel is what makes every
//! confinement guard follow the data automatically.

use std::path::{Path, PathBuf};

use crate::commands::manifest::{
    adopt_orphans_in_dir, looks_like_config, read_manifest, write_bytes_atomic,
    write_manifest_atomic, ConfigEntry, Manifest, MANIFEST_SCHEMA_VERSION,
};

/// Marker file that gates the second run. Written LAST, inside the lock, after everything else
/// has landed — so a process that dies mid-adoption leaves no marker and the next launch retries.
///
/// Its CONTENT is the summary line. That is deliberate and it is Repair 7's requirement made
/// durable: the previous implementation's summary went only to the async logger, which is not up
/// this early AND early-returns entirely unless the `.enable_logs` marker exists — so the record of
/// what the migration did was unreachable twice over. A file written unconditionally in the
/// performed branch depends on nothing.
const ADOPTION_MARKER: &str = ".adopted-legacy-data";

/// Exclusive create-new lock file covering the whole adoption. See the module comment (OPEN-5).
const ADOPTION_LOCK: &str = ".adoption.lock";

/// The user's recorded refusal of the migration offer. Its presence is the whole answer; adoption
/// consults it and does nothing, and the offer is never asked a second time.
///
/// **Why a per-user file and not the machine hive.** Plan 32-08's `<mechanism_split>` designed this
/// answer to live in HKLM under the product key, for a good reason that stopped applying the moment
/// the owner chose `no-fork` (phase 32 task 1, reversing phase 31's D-01): that design had the
/// *installer* record the answer, and an installer runs elevated, so the user hive it can reach is
/// the elevating administrator's rather than the real user's. With no fork there is no installer
/// page — the APPLICATION asks, and the application runs as the real user by construction. That
/// inverts the argument completely:
/// * the app is not elevated, so it cannot write HKLM at all without an elevation prompt the answer
///   to a two-button question does not deserve;
/// * a machine-wide answer is SHARED by every Windows account, so one user's «Не переносить» would
///   silently decide for the next account's first launch — adoption never crosses profiles
///   (T-32-15/T-32-38) and neither may its answer.
///
/// It sits beside [`ADOPTION_MARKER`] rather than reusing it because every «did nothing» reason in
/// this module is its own word: folding a refusal into «already adopted» is exactly the shared value
/// that made the previous migration unexplainable after the event.
const MIGRATION_DECLINED_MARKER: &str = ".migration-declined";

/// A lock older than this is assumed to belong to a process that died mid-adoption and is removed.
///
/// Tolerating a stale lock is not optional: without it, one crash leaves a file in the data root
/// that makes every subsequent launch wait and then decline to adopt, forever. The window is
/// generous because a real adoption copies a browser profile, which is not instant.
const STALE_LOCK_AFTER: std::time::Duration = std::time::Duration::from_secs(120);

/// How long a process that lost the race waits for the winner before giving up and doing nothing.
const LOCK_WAIT_LIMIT: std::time::Duration = std::time::Duration::from_secs(20);

/// The registry key whose UNNAMED (default) value holds the legacy install directory.
///
/// The Tauri template's `MANUPRODUCTKEY`, i.e. `Software\${MANUFACTURER}\${PRODUCTNAME}`. Read from
/// **HKCU only**, and that is a decision rather than an omission: every install made before phase 32
/// was `currentUser` and wrote it there, which is exactly the population this module exists for.
/// HKLM now holds the CURRENT per-machine install directory — Program Files — which is where the
/// binaries live and where no user data has ever been, so reading it would point adoption at a
/// folder that cannot be a source.
///
/// Key off the default VALUE, never off the key's existence: `MUI_LANGDLL_REGISTRY_ROOT` writes
/// «Installer Language» into this same HKCU path regardless of install mode, so a machine that has
/// only ever seen the language written has the key with no path in it (plan 32-01's finding).
///
/// Deliberately spelled here rather than shared with `ssh::PRODUCT_DATA_FOLDER` or with
/// `updater::INSTALL_DIR_PRODUCT_KEY`: 32-01 split the install directory from the data root and
/// pinned the split with a compiled test, and this is an INSTALL-directory lookup.
#[cfg(windows)]
const LEGACY_INSTALL_PRODUCT_KEY: &str = r"Software\trusttunnel\TrustTunnel Client Pro";

/// The named files adopted verbatim, from `32-RESEARCH.md` § Runtime State Inventory.
///
/// `configs.json` is absent on purpose — it is never copied, only parsed and rewritten
/// ([`rewrite_entries_onto_root`]). Copying it as a blob is the shipped defect.
///
/// Three entries here are beyond the plan's literal list and are here for the same reason the rest
/// are: their loss reads to the user as the application having forgotten them, not as an error.
/// `app_settings.json` carries the «запуск вместе с системой» choice that plan 32-05's scheduled
/// task reads; `tray_hint_shown`, `.start_minimized` and `.enable_logs` are three switches the user
/// set by hand. `dns_snapshot.json` rides along because it is the machine's ORIGINAL DNS
/// configuration, saved so `dns_guard::sweep_stale_dns_on_startup` can put it back after a hard
/// death — leaving it behind means a machine still pointing at a dead tunnel resolver with the only
/// copy of the way back in a folder the app no longer reads.
const ADOPTED_FILES: &[&str] = &[
    "ssh_credentials.json",
    "known_hosts.json",
    "routing_rules.json",
    "exclusions.json",
    "active_groups.json",
    "connection_history.json",
    "app_settings.json",
    "dns_snapshot.json",
    "tray_hint_shown",
    ".start_minimized",
    ".enable_logs",
];

/// The directories adopted.
///
/// Three are NOT here, each for a stated reason. `runtime/` holds throwaway connect-override copies
/// which carry the endpoint password and are swept at every startup by `net_egress` — nothing
/// should outlive the session that wrote it, least of all across a migration. `logs/` is the
/// previous install's diary, not its state. `.sidecar-pro.pid` follows the BINARIES and not the
/// user's data (plan 32-01), so adopting it would hand the new install a pid from a directory it
/// no longer owns.
const ADOPTED_DIRS: &[&str] = &["webview_data", "geodata", "resolved", "group_cache"];

/// The one directory adopted all-or-nothing rather than file-by-file.
///
/// `webview_data` is the embedded browser's LIVE profile. `init_data_root_early` points WebView2 at
/// it in `main()`, and the main window is built before `.setup()` runs, so by the time adoption
/// executes the destination may already exist and be held open. Merging files into a live LevelDB
/// store is how one is corrupted — so this folder is adopted only when the destination has nothing
/// of its own. **Known limitation, recorded rather than hidden:** on a machine where WebView2 has
/// already created its profile before adoption reaches this point, the legacy browser profile is
/// NOT adopted and the user loses their in-webview settings while keeping every server, password
/// and rule. That is the safe side of the trade; moving adoption earlier than `.setup()` is the
/// fix, and it is not in this plan's scope.
const ADOPT_WHOLE_OR_NOT_AT_ALL: &str = "webview_data";

/// What the adoption did. Every "did nothing" reason is its OWN variant on purpose: the previous
/// implementation could not distinguish "there was nothing to adopt" from "the adoption produced
/// nothing", which is precisely what made the regression unexplainable after the fact.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdoptionOutcome {
    /// The marker is present — this root has already been adopted into. No writes, no copies.
    AlreadyDone,
    /// The legacy root IS the data root. The D-05 common case, and by far the most frequent
    /// outcome in the field: the files never moved, so there is nothing to copy.
    SameRoot,
    /// No legacy root could be discovered.
    NoLegacyRoot,
    /// A legacy root was discovered but holds none of the artifacts this module knows about.
    NothingToAdopt,
    /// Another process held the lock and completed the adoption. This process performed nothing.
    ConcurrentlyAdopted,
    /// The user was asked and said «Не переносить». Nothing was copied, and nothing will be:
    /// [`MIGRATION_DECLINED_MARKER`] is on disk, so this branch is taken on every later launch too.
    /// Its own variant, not a reuse of [`AdoptionOutcome::AlreadyDone`] — «he refused» and «it is
    /// already done» are different facts, and a support conversation turns on which one happened.
    DeclinedByUser,
    /// The adoption ran and could NOT finish. Its own variant, and the reason it is one: «somebody
    /// else got there first» ([`AdoptionOutcome::ConcurrentlyAdopted`]) and «it failed» are
    /// different facts, and a support conversation turns entirely on which happened. Sharing a
    /// value between them sent a failed manifest write to the window as a success (CR-02) while the
    /// credentials and every `.toml` were already sitting in the destination with nothing
    /// describing them.
    ///
    /// `artifacts_copied` is what had been copied before the failure; `reason` is the writer's own
    /// error text, passed through [`path_free`] so a future `{path}` added to it cannot put a
    /// user's folder in a log or a window (D-29).
    Failed {
        artifacts_copied: usize,
        reason: String,
    },
    /// The adoption ran. Integer counts only — see [`adopt_into`] on why nothing else may be here.
    Adopted {
        artifacts_copied: usize,
        entries_rewritten: usize,
        rows_dropped: usize,
    },
}

/// The result of the pure rewrite decision: the merged entry list plus how many rows were dropped.
///
/// `PartialEq` but not `Eq`, because `ConfigEntry` is only `PartialEq` — it is a serde type shared
/// with the frontend and deriving `Eq` on it would be a change to a shipped struct for this
/// module's convenience. Nothing here needs total equality.
#[derive(Debug, Clone, PartialEq)]
pub struct RewriteOutcome {
    pub entries: Vec<ConfigEntry>,
    pub dropped: usize,
}

/// Rewrite legacy manifest entries onto `data_root`, merging them after `existing`.
///
/// **Pure.** No filesystem access, so the decision that produced the shipped defect is assertable
/// on its own terms rather than only through a directory full of files.
///
/// Rules, each of them a repair from `30.1-REGRESSION.md` § 5:
/// * every entry's absolute `path` is rewritten onto `data_root` by its filename (Repair 1a);
/// * a row whose canonical filename is already taken is DROPPED and counted (Repair 1a) — this is
///   what stops five servers becoming ten;
/// * `name`, `order`, `last_used` and `copy` carry through unchanged (Repair 1a's whole reason for
///   preferring shape (a) over shape (b));
/// * `id` carries through too: it is STORED at creation and returned verbatim by `list_configs`,
///   never re-derived, and the frontend uses it as the card's React key — re-deriving it here
///   would present as every card being replaced by a stranger with the same name.
///
/// `legacy_root` is not decoration: a manifest may legitimately hold a RELATIVE path (nothing
/// forbids one), and a relative path means "relative to the root that manifest lived in". It is
/// resolved against `legacy_root` before the filename is taken.
pub fn rewrite_entries_onto_root(
    existing: &[ConfigEntry],
    legacy: &[ConfigEntry],
    legacy_root: &Path,
    data_root: &Path,
) -> RewriteOutcome {
    let mut entries: Vec<ConfigEntry> = existing.to_vec();
    let mut taken: Vec<String> = entries
        .iter()
        .filter_map(|e| canonical_file_name(Path::new(&e.path)))
        .collect();

    // Push legacy orders past whatever the destination already had, so two lists that both start at
    // 0 do not interleave arbitrarily. With an EMPTY destination — the case this module exists for —
    // the offset is 0 and `order` therefore carries through verbatim, which is what the preservation
    // rule requires and what the test asserts.
    let order_offset = entries
        .iter()
        .map(|e| e.order)
        .max()
        .map(|m| m + 1)
        .unwrap_or(0);
    // There can be exactly one last-used server. Same shape: with an empty destination the flag
    // carries through verbatim; only a destination that already had one can suppress it.
    let mut last_used_taken = entries.iter().any(|e| e.last_used);

    let mut dropped = 0usize;
    for src in legacy {
        let raw = Path::new(&src.path);
        // A relative path in a manifest means "relative to the root that manifest lived in", which
        // is the only thing `legacy_root` is needed for — and the only reading of it that is not a
        // guess.
        let resolved = if raw.is_absolute() {
            raw.to_path_buf()
        } else {
            legacy_root.join(raw)
        };
        let (Some(file_name), Some(key)) = (
            resolved.file_name().map(|n| n.to_owned()),
            canonical_file_name(&resolved),
        ) else {
            // A row with no filename names no file. It cannot be rewritten onto anything.
            dropped += 1;
            continue;
        };
        if taken.contains(&key) {
            // Two rows resolving to one destination file. Keeping both is the arithmetic that
            // turned five servers into ten.
            dropped += 1;
            continue;
        }

        let mut carried = src.clone();
        carried.path = data_root.join(&file_name).to_string_lossy().to_string();
        carried.order = src.order.saturating_add(order_offset);
        carried.last_used = src.last_used && !last_used_taken;
        if carried.last_used {
            last_used_taken = true;
        }
        // `id`, `name` and `copy` are NOT touched. They are the user's data and the reason Repair 1
        // shape (a) was chosen over letting the reconciler rebuild the list.
        entries.push(carried);
        taken.push(key);
    }

    RewriteOutcome { entries, dropped }
}

/// The writer's own error text with anything path-shaped removed.
///
/// D-29. `atomic_write` and `write_manifest_atomic` format their errors from the OPERATION and
/// never from the destination, so today nothing here carries a path — but «never today» is not a
/// guard, and this string now reaches both the application log and the window. One `{path}` added
/// to an error message upstream would otherwise put a user's folder in front of somebody, and this
/// module is the one that copies `ssh_credentials.json`.
fn path_free(reason: &str) -> String {
    if reason.contains('\\') || reason.contains('/') {
        return "the destination refused the write".to_string();
    }
    reason.to_string()
}

/// Refuse the adoption because a manifest is PRESENT and could not be read.
///
/// Called only from the point in [`adopt_into`] where nothing has been copied yet, which is the
/// whole reason both manifests are read before step 1 rather than in the middle of step 2.
fn refuse_unreadable_manifest(emit: &mut dyn FnMut(&str), e: &str) -> AdoptionOutcome {
    let reason = path_free(e);
    emit("[adoption] refused - a manifest is present and could not be read - artifacts=0 rolled_back=0");
    emit(&format!("[adoption] the read failed - {reason}"));
    AdoptionOutcome::Failed {
        artifacts_copied: 0,
        reason,
    }
}

/// The lowercased filename of `p`, which is what "the same canonical filename" means on Windows.
fn canonical_file_name(p: &Path) -> Option<String> {
    p.file_name().and_then(|n| n.to_str()).map(|n| n.to_lowercase())
}

/// Lexical, case-insensitive directory equality after a best-effort canonicalisation.
///
/// Canonicalisation alone is not enough (it fails on a directory that does not exist yet, and it
/// returns the `\\?\` verbatim form for one side and not the other); string comparison alone is not
/// enough either (a junction, a `subst` drive or a OneDrive redirect makes two spellings of one
/// place). Doing both is the same belt-and-braces the manifest's own confinement fallback uses.
///
/// `pub(crate)` since 32-FIX-11: the startup leftover report asks the same question twice — «is
/// the data folder the program's own folder?» and «is this recorded path in the data folder?» —
/// and a second copy of a path-equality rule is exactly the drift this module's neighbours record
/// having happened before. One answer, one place.
pub(crate) fn same_dir(a: &Path, b: &Path) -> bool {
    fn norm(p: &Path) -> String {
        let canon = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        let s = canon.to_string_lossy().replace('/', "\\");
        s.trim_start_matches(r"\\?\")
            .trim_end_matches('\\')
            .to_lowercase()
    }
    norm(a) == norm(b)
}

/// Is this a `.toml` the application would call a server config? Case-insensitive on the extension,
/// matching the folder-as-truth scan, and gated on the application's own content predicate.
fn is_server_config(p: &Path) -> bool {
    let is_toml = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|x| x.eq_ignore_ascii_case("toml"))
        .unwrap_or(false);
    if !is_toml || p.file_name().and_then(|s| s.to_str()) == Some("Cargo.toml") {
        return false;
    }
    std::fs::read_to_string(p)
        .map(|c| looks_like_config(&c))
        .unwrap_or(false)
}

/// Does this directory hold anything this module knows how to adopt?
///
/// Answered separately from the adoption itself so «found a folder but there was nothing in it» is
/// a distinct reported outcome rather than a successful adoption of zero things.
fn holds_adoptable_data(root: &Path) -> bool {
    if ADOPTED_FILES.iter().any(|n| root.join(n).exists()) {
        return true;
    }
    if ADOPTED_DIRS.iter().any(|n| root.join(n).is_dir()) {
        return true;
    }
    if !read_manifest(root).unwrap_or_default().configs.is_empty() {
        return true;
    }
    std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .any(|e| is_server_config(&e.path()))
}

/// Copy one file when the destination does not already exist. `true` when a copy happened.
///
/// Never overwrites. A destination file that is already there was put there by the running install
/// and is newer than anything in a folder the app abandoned.
///
/// `created` is the ledger of what this run brought into being, and it exists for exactly one
/// reason: a failure after the copies must be able to take them back out (CR-02). Because a copy
/// happens ONLY when the destination did not exist, every path recorded here is one the user did
/// not have — so undoing the list can never remove something of his. That property is what makes
/// the rollback safe by construction rather than by care.
fn copy_file_if_absent(src: &Path, dst: &Path, created: &mut Vec<PathBuf>) -> bool {
    if !src.is_file() || dst.exists() {
        return false;
    }
    if let Some(parent) = dst.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if std::fs::copy(src, dst).is_ok() {
        created.push(dst.to_path_buf());
        return true;
    }
    false
}

/// Undo the copies this run made: the files first, then the directories that held only them.
///
/// Safe by construction — see [`copy_file_if_absent`] on why nothing pre-existing can be in
/// `created`. Directories go through `remove_dir`, which REFUSES a non-empty one, so a folder that
/// also holds something of the user's survives untouched. Deepest path first, so a nested tree
/// empties from the leaves.
///
/// Returns how many of the created files are gone. A partial result is reported rather than
/// hidden: `artifacts=4 rolled_back=3` in the log says exactly what state the folder is in.
fn roll_back(created: &[PathBuf], data_root: &Path) -> usize {
    let mut removed = 0usize;
    for p in created {
        if std::fs::remove_file(p).is_ok() || !p.exists() {
            removed += 1;
        }
    }
    let mut dirs: Vec<PathBuf> = created
        .iter()
        .flat_map(|p| {
            p.ancestors()
                .skip(1)
                .map(|a| a.to_path_buf())
                .collect::<Vec<_>>()
        })
        // Never the data root itself: it is the running install's own folder, not ours to remove.
        .filter(|d| d.starts_with(data_root) && d != data_root)
        .collect();
    dirs.sort_by(|a, b| {
        b.components()
            .count()
            .cmp(&a.components().count())
            .then_with(|| a.cmp(b))
    });
    dirs.dedup();
    for d in dirs {
        let _ = std::fs::remove_dir(&d);
    }
    removed
}

/// Copy a directory tree, skipping every destination that already exists. Returns the file count.
///
/// Per-entry failures are counted as "not copied" and never abort the adoption: a single locked
/// file inside a browser profile must not cost the user their servers and passwords.
fn copy_dir_merging(src: &Path, dst: &Path, created: &mut Vec<PathBuf>) -> usize {
    if !src.is_dir() {
        return 0;
    }
    let _ = std::fs::create_dir_all(dst);
    let mut copied = 0usize;
    for entry in std::fs::read_dir(src).into_iter().flatten().flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        match entry.file_type() {
            Ok(t) if t.is_dir() => copied += copy_dir_merging(&from, &to, created),
            Ok(_) => {
                if copy_file_if_absent(&from, &to, created) {
                    copied += 1;
                }
            }
            Err(_) => {}
        }
    }
    copied
}

/// Holds the adoption lock for as long as it is alive, and removes it on the way out — including on
/// an early return and on a panic, which a hand-placed `remove_file` would not cover.
struct LockGuard(PathBuf);

impl Drop for LockGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Take the exclusive lock, clearing one that a dead process left behind.
///
/// `create_new` is the whole mechanism: it is a single atomic filesystem operation, so of two
/// processes arriving together exactly one can succeed. The marker cannot do this — both can read
/// it absent in the same instant, which is OPEN-5 stated precisely.
fn acquire_lock(lock: &Path) -> Option<LockGuard> {
    for attempt in 0..2 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(lock)
        {
            Ok(_) => return Some(LockGuard(lock.to_path_buf())),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if attempt == 0 && lock_is_stale(lock) {
                    let _ = std::fs::remove_file(lock);
                    continue;
                }
                return None;
            }
            // Anything else means this process cannot write into the data root at all, in which
            // case it could not complete an adoption either. Decline, leave no marker, and let the
            // next launch try again.
            Err(_) => return None,
        }
    }
    None
}

fn lock_is_stale(lock: &Path) -> bool {
    std::fs::metadata(lock)
        .and_then(|m| m.modified())
        .map(|t| t.elapsed().map(|d| d > STALE_LOCK_AFTER).unwrap_or(false))
        .unwrap_or(false)
}

/// Wait for whoever holds the lock to finish, so the loser reports the completed state rather than
/// racing it. Bounded: an adoption must never be the reason an application does not start.
fn wait_for_holder(marker: &Path, lock: &Path) {
    let deadline = std::time::Instant::now() + LOCK_WAIT_LIMIT;
    while std::time::Instant::now() < deadline {
        if marker.exists() || !lock.exists() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

/// Adopt `legacy_root` into `data_root`, once, under an exclusive lock, reporting integer counts.
///
/// Both roots are parameters rather than lookups so that the tests can run against a sandbox and
/// never real user data — and so that this function contains no second data-root accessor.
///
/// `emit` is the report channel. It is injected for one reason: the previous implementation's
/// summary line was unreachable code (Repair 7), so the only way to make "it reported what it did"
/// mean anything is for a test to hold the channel and read what came out of it. D-29 bounds what
/// may go through: a fixed phrase and integer counts, never a path and never a credential value.
pub fn adopt_into(
    legacy_root: Option<&Path>,
    data_root: &Path,
    emit: &mut dyn FnMut(&str),
) -> AdoptionOutcome {
    let marker = data_root.join(ADOPTION_MARKER);

    // The marker check comes FIRST, before the lock, and that ordering is load-bearing: on every
    // launch after the first this function must touch the data root not at all. Taking the lock
    // first would create and delete a file in the user's folder at every single startup, forever.
    if marker.exists() {
        return AdoptionOutcome::AlreadyDone;
    }

    // The recorded answer, second — a gate in FRONT of the existing branches, never a second
    // mechanism beside them. Everything below (the lock, the marker, the invariants, the report) is
    // untouched; all this adds is the one case where the user has already said no.
    //
    // It is checked here rather than further down, next to `same_dir`/`holds_adoptable_data`,
    // because the answer can only exist if the offer was drawn, and the offer is drawn only when
    // those branches would have fallen through anyway (see `offer_is_pending`, which mirrors them).
    // Placing it early means a declined machine touches the data root exactly as little as an
    // already-adopted one does: one `exists()` call and out.
    if data_root.join(MIGRATION_DECLINED_MARKER).exists() {
        return AdoptionOutcome::DeclinedByUser;
    }

    let Some(legacy) = legacy_root.filter(|p| p.is_dir()) else {
        return AdoptionOutcome::NoLegacyRoot;
    };
    // D-05, and the outcome on nearly every machine in the field: the binaries left the folder and
    // the data stayed. There is nowhere to copy to and nothing to copy.
    if same_dir(legacy, data_root) {
        return AdoptionOutcome::SameRoot;
    }
    if !holds_adoptable_data(legacy) {
        return AdoptionOutcome::NothingToAdopt;
    }

    let _ = std::fs::create_dir_all(data_root);
    let lock_path = data_root.join(ADOPTION_LOCK);
    let Some(_lock) = acquire_lock(&lock_path) else {
        // Somebody else is doing it (OPEN-5: `single_instance` is registered later in `run()`, so a
        // second process really does get this far). Let them finish, then report that this process
        // performed nothing. The marker stays theirs to write.
        wait_for_holder(&marker, &lock_path);
        return AdoptionOutcome::ConcurrentlyAdopted;
    };

    // Double-check under the lock. The loser of a race that finished while we were opening the lock
    // file arrives here with the marker already written, and must not adopt a second time.
    if marker.exists() {
        return AdoptionOutcome::AlreadyDone;
    }

    // ── 0. Both manifests, parsed, BEFORE a single byte is copied ─────────────────────────────
    //
    // `read_manifest` answers `Ok(default)` for «there is no manifest» and `Err` ONLY for «there is
    // one and it cannot be read» — a truncated write, a half-synced file, a scanner mid-quarantine.
    // `unwrap_or_default()` collapsed those two into the same empty list, and each collapse threw
    // away exactly the three fields Repair 1 shape (a) was chosen over shape (b) to preserve:
    //   * the LEGACY side — every `.toml` copied, then re-minted by the folder reconciler with a
    //     derived name, the order pushed to the end and `last_used` cleared;
    //   * the DESTINATION side — the running install's own rows discarded and then written back
    //     over, losing the same three fields for servers this migration was never about.
    // Neither was reported, and both were permanent, because the marker is written afterwards.
    //
    // They are read HERE, ahead of step 1, so that refusing costs nothing: not a byte has moved,
    // the legacy root is untouched, and the next launch — which may well be able to read the file —
    // retries from exactly where this one started.
    let existing = match read_manifest(data_root) {
        Ok(m) => m,
        Err(e) => return refuse_unreadable_manifest(emit, &e),
    };
    let legacy_manifest = match read_manifest(legacy) {
        Ok(m) => m,
        Err(e) => return refuse_unreadable_manifest(emit, &e),
    };

    // ── 1. The artifacts. `configs.json` is NOT among them — see step 2. ──────────────────────
    //
    // Every copy is recorded, because the manifest write at the end of step 2 can fail and a
    // destination holding the configs with no manifest describing them is the one state nobody can
    // recover from (CR-02).
    let mut created: Vec<PathBuf> = Vec::new();
    let mut artifacts_copied = 0usize;
    for name in ADOPTED_FILES {
        if copy_file_if_absent(&legacy.join(name), &data_root.join(name), &mut created) {
            artifacts_copied += 1;
        }
    }
    for entry in std::fs::read_dir(legacy).into_iter().flatten().flatten() {
        let from = entry.path();
        // Every `.toml` the app would call a server config — their names are the USER'S, so they
        // can only be found by scanning, never by an allow-list.
        if is_server_config(&from) {
            if let Some(name) = from.file_name() {
                if copy_file_if_absent(&from, &data_root.join(name), &mut created) {
                    artifacts_copied += 1;
                }
            }
        }
    }
    // The client configuration file is a `.toml` that may or may not satisfy the server predicate
    // depending on how it was written; copy it by name so it is adopted either way.
    if copy_file_if_absent(
        &legacy.join("trusttunnel_client.toml"),
        &data_root.join("trusttunnel_client.toml"),
        &mut created,
    ) {
        artifacts_copied += 1;
    }
    for name in ADOPTED_DIRS {
        let from = legacy.join(name);
        let to = data_root.join(name);
        if *name == ADOPT_WHOLE_OR_NOT_AT_ALL && to.exists() {
            continue; // a live WebView2 profile — see ADOPT_WHOLE_OR_NOT_AT_ALL
        }
        artifacts_copied += copy_dir_merging(&from, &to, &mut created);
    }

    // ── 2. The manifest: parsed and rewritten, NEVER copied ───────────────────────────────────
    //
    // This is the defect. Copying `configs.json` as a blob left every entry naming the old root;
    // the confinement guard follows the data root by construction and refused all of them, while
    // the folder reconciler minted a second set from the copied `.toml` files.
    let existing_n = existing.configs.len();
    let rewritten = rewrite_entries_onto_root(
        &existing.configs,
        &legacy_manifest.configs,
        legacy,
        data_root,
    );

    let mut kept: Vec<ConfigEntry> = Vec::with_capacity(rewritten.entries.len());
    let mut entries_rewritten = 0usize;
    let mut rows_dropped = rewritten.dropped;
    for (i, e) in rewritten.entries.into_iter().enumerate() {
        if i < existing_n {
            // A row that was ALREADY in the destination is not adoption's business, whatever state
            // its file is in. `prune_missing` owns that decision; a migration that quietly deletes
            // rows it did not create is how a migration becomes the thing you have to diagnose.
            kept.push(e);
            continue;
        }
        // A CARRIED row is kept only if the destination now holds a file the application would
        // actually call a server config.
        //
        // The test asks the same question of the destination that `adopt_orphans_in_dir` asks, so
        // anything weaker than the application's own predicate here puts a row in the manifest that
        // no file backs. `is_file()` was weaker: it let through a row naming a `.toml` that is not
        // a server config at all — `trusttunnel_client.toml` in the shape this module already
        // concedes it may take — and that row can never open, never appear, and never be removed by
        // anything except a prune. The comment on this branch has always said «or was never a
        // server config»; this is the line that finally asks it.
        if is_server_config(Path::new(&e.path)) {
            entries_rewritten += 1;
            kept.push(e);
        } else {
            rows_dropped += 1;
        }
    }

    let mut manifest = Manifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        configs: kept,
    };
    // A legacy `configs.json` can legitimately be stale — a `.toml` sitting there with no row
    // naming it. The application's own append-only adopter closes that gap, so the count invariant
    // holds immediately rather than after the first `list_configs`.
    adopt_orphans_in_dir(data_root, &mut manifest);
    // The atomic writer is mandatory here. A truncating write is banned in this area because the
    // native core reads these files and a half-written file aborts the connect.
    if let Err(e) = write_manifest_atomic(data_root, &manifest) {
        // Reporting the failure is necessary and NOT sufficient. By this line `ssh_credentials.json`
        // and every server `.toml` are already in the destination, and a destination holding configs
        // with no manifest describing them is exactly what the folder-as-truth reconciler mints
        // nameless rows out of — after which the next launch drops the legacy rows as duplicates and
        // the user's card names, ordering and last-used history are gone for good (CR-02).
        //
        // So the copies come back out. That returns the destination to the state a retry needs, and
        // the legacy root was never touched, so nothing of the user's is at stake in either place.
        // No marker is written, so the next launch does retry.
        let rolled_back = roll_back(&created, data_root);
        let reason = path_free(&e);
        emit(&format!(
            "[adoption] could not write the adopted manifest - artifacts={artifacts_copied} rolled_back={rolled_back}"
        ));
        // The cause, on its own line. `let _ = e;` threw away the only thing that says what to do
        // about it — disk full, denied, a scanner holding the file — and left support chasing a
        // concurrency bug that was not there.
        emit(&format!("[adoption] the write failed - {reason}"));
        return AdoptionOutcome::Failed {
            artifacts_copied,
            reason,
        };
    }

    // ── 3. The report, then the marker ────────────────────────────────────────────────────────
    //
    // Unconditional and on the performed branch's only path out. D-29 bounds the content: a fixed
    // phrase and integer counts, never a path and never a credential value. No colon appears in it
    // — a test asserts that, because `C:\…` is what a leaked path looks like.
    let summary = format!(
        "[adoption] adopted legacy data - artifacts={artifacts_copied} entries={entries_rewritten} dropped={rows_dropped}"
    );
    emit(&summary);

    // The marker is written LAST and carries the summary as its content: a durable record that does
    // not depend on the async logger being up (Repair 7). A process that died before this point
    // left no marker, so the next launch retries — which is why it is last.
    let _ = write_bytes_atomic(&marker, format!("{summary}\n").as_bytes());

    AdoptionOutcome::Adopted {
        artifacts_copied,
        entries_rewritten,
        rows_dropped,
    }
}

/// Read the legacy install directory out of the registry. `None` when there is nothing usable.
///
/// Through the `winreg` binding, never by parsing `reg.exe` output. That is a standing project
/// prohibition and plan 32-03 paid for it: `reg.exe` LOCALIZES the default-value column — it prints
/// `(по умолчанию)` on this machine — so a positional parse silently takes the wrong token and then
/// fails safe into looking correct.
#[cfg(windows)]
fn discover_legacy_root() -> Option<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(LEGACY_INSTALL_PRODUCT_KEY, KEY_READ)
        .ok()?;
    // The UNNAMED (default) value. See LEGACY_INSTALL_PRODUCT_KEY on why the key's mere existence
    // proves nothing.
    let raw: String = key.get_value("").ok()?;
    // The template writes `InstallLocation` and `UninstallString` wrapped in literal quote
    // characters (finding F7, confirmed on a real Windows install). This value is not one of those,
    // but stripping is free and a quoted path that reaches a filesystem call resolves to nothing.
    let trimmed = raw.trim().trim_matches('"').trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    // Reads only. The value is never interpolated into a command line and nothing here executes.
    if path.is_absolute() && path.is_dir() {
        Some(path)
    } else {
        None
    }
}

#[cfg(not(windows))]
fn discover_legacy_root() -> Option<PathBuf> {
    None
}

/// Would an adoption right now actually copy something? Both roots are parameters, for the same
/// reason [`adopt_into`] takes them: a probe the tests cannot aim at a sandbox is a probe nobody
/// asserts about.
///
/// **This is the offer's trigger condition, and it is deliberately the SAME condition as the
/// performed branch of `adopt_into`.** Every early return there is a `false` here, in the same
/// order. That correspondence is what makes the offer honest in both directions: the question is
/// never asked of somebody who has nothing to gain by answering it (the D-05 same-folder majority,
/// a clean machine, an already-adopted one), and it is never skipped for somebody whose data would
/// otherwise be adopted without being asked. A test pins the correspondence rather than a comment
/// promising it.
pub fn offer_is_pending(legacy_root: Option<&Path>, data_root: &Path) -> bool {
    if data_root.join(ADOPTION_MARKER).exists() {
        return false;
    }
    if data_root.join(MIGRATION_DECLINED_MARKER).exists() {
        return false;
    }
    let Some(legacy) = legacy_root.filter(|p| p.is_dir()) else {
        return false;
    };
    if same_dir(legacy, data_root) {
        return false;
    }
    holds_adoptable_data(legacy)
}

/// Write the user's refusal down. Idempotent; a second call over an existing marker is harmless.
///
/// The content is a fixed ASCII phrase and nothing else — no path, no timestamp, no account name
/// (D-29). What the file has to carry is its own existence; anything more is a field somebody
/// eventually reads out of a user's folder.
pub fn record_decline(data_root: &Path) -> Result<(), String> {
    let _ = std::fs::create_dir_all(data_root);
    write_bytes_atomic(
        &data_root.join(MIGRATION_DECLINED_MARKER),
        b"declined by the user at first launch\n",
    )
}

/// Record a refusal, but only in answer to a question that is genuinely outstanding.
///
/// **Why this gate exists.** `record_decline` writes a marker that is permanent: once
/// [`MIGRATION_DECLINED_MARKER`] is on disk, `offer_is_pending` answers `false` for ever and
/// `adopt_into` returns `DeclinedByUser` for ever. There is no surface that undoes it and nothing
/// in the application ever mentions the orphaned folder again. A decision that irreversible, about
/// the user's servers, passwords and known hosts, may only be recorded in reply to a question that
/// was actually being asked — and until this gate the command wrote it on ANY `accept = false`
/// call, from any state, including states where the dialog was never drawn. It is reachable only
/// from the renderer, so it takes a renderer defect or a stray dispatch to fire; but «only a bug
/// can reach it» is the argument for guarding it, not against.
///
/// Both roots are parameters for the reason every other entry point in this module takes them: a
/// gate the tests cannot aim at a sandbox is a gate nobody asserts about.
pub fn record_decline_if_outstanding(
    legacy_root: Option<&Path>,
    data_root: &Path,
) -> Result<(), String> {
    if !offer_is_pending(legacy_root, data_root) {
        return Err("no migration offer is outstanding".to_string());
    }
    record_decline(data_root)
}

/// The production wrapper: discover the legacy root, resolve the data root through the single
/// accessor, adopt, and report.
///
/// This is the ONLY place either root is looked up. In particular the destination comes from
/// `ssh::user_data_dir()` — the single accessor every path-confinement root already derives from —
/// so the guards keep following the data by construction. **Do not add a second lookup here**, not
/// even "just for the migration": that is how half a crate ends up pointing at the old root with
/// nothing to catch it.
pub fn run_first_launch_adoption() -> AdoptionOutcome {
    let data_root = crate::ssh::user_data_dir();
    let legacy = discover_legacy_root();

    let mut emit = |line: &str| {
        // Two channels on purpose. `log_app` is the normal one and is a no-op when file logging is
        // off — which is exactly why the previous implementation's summary proved nothing.
        crate::logging::log_app("info", line);
        // stderr always accepts it, and the marker file written by `adopt_into` carries the same
        // line durably. Between them the report cannot be unreachable.
        eprintln!("{line}");
    };

    adopt_into(legacy.as_deref(), &data_root, &mut emit)
}

/// The production probe: is the window supposed to ask the migration question on this launch?
///
/// Called from `.setup()` — which must NOT adopt while the answer is outstanding — and again by the
/// window through [`migration_offer_pending`]. It is deliberately re-derived from disk on both
/// calls rather than cached in application state: the fast path is one `exists()` on a marker that
/// is present on every launch after the first, and a cached answer is a second source of truth for
/// a fact the filesystem already holds.
pub fn first_launch_offer_pending() -> bool {
    offer_is_pending(discover_legacy_root().as_deref(), &crate::ssh::user_data_dir())
}

/// Does the window need to draw the migration offer?
///
/// The window asks this before it renders anything of its own; see `MigrationOfferGate.tsx`. A bare
/// boolean crosses — no path, no account, no counts (D-29).
#[tauri::command]
pub fn migration_offer_pending() -> bool {
    first_launch_offer_pending()
}

/// The user answered. `accept = true` performs the adoption now; `accept = false` records the
/// refusal and performs nothing, on this launch or any later one.
///
/// **Both arms go through [`run_first_launch_adoption`]**, and that is the point rather than an
/// economy: the decline arm writes its marker and then runs the very same entry point the accept
/// arm runs, so the refusal is proved by the module's own gate returning `DeclinedByUser` instead
/// of by this function promising not to call it. A gate nothing exercises is a gate nobody can
/// trust.
///
/// Returns the outcome's NAME — an ASCII word from a closed set, never a path and never a count.
/// The window only distinguishes «finished» from «failed»; the word exists so the console line and
/// a bug report say which branch ran.
///
/// Off the UI thread: a real adoption copies a browser profile, and a synchronous command would
/// hold the webview still while it did. The offer is drawn under a loader precisely so the data is
/// correct beneath it when the app appears; a frozen window under that loader would defeat it.
#[tauri::command]
pub async fn resolve_migration_offer(accept: bool) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        if !accept {
            // Recorded FIRST. If the write fails the adoption must not proceed as if the user had
            // said yes — a refusal that silently becomes an acceptance is the one outcome this
            // whole surface exists to prevent.
            //
            // Through the gate, not through `record_decline` directly: the marker is permanent and
            // there is no surface that undoes it, so it may only be written in answer to a question
            // that was genuinely outstanding. See `record_decline_if_outstanding`. Both roots are
            // resolved here, once, the same way `run_first_launch_adoption` resolves them.
            let data_root = crate::ssh::user_data_dir();
            record_decline_if_outstanding(discover_legacy_root().as_deref(), &data_root)?;
        }
        let outcome = run_first_launch_adoption();
        // An adoption that FAILED crosses as `Err`, never as one of the words below. Every word
        // here means «the answer landed»; the window shows the application on all of them. Mapping
        // a failure onto one of them is what told the user his data had been migrated while it had
        // not been (CR-02).
        if let AdoptionOutcome::Failed { reason, .. } = outcome {
            return Err(reason);
        }
        Ok(match outcome {
            AdoptionOutcome::AlreadyDone => "already-done".to_string(),
            AdoptionOutcome::SameRoot => "same-root".to_string(),
            AdoptionOutcome::NoLegacyRoot => "no-legacy-root".to_string(),
            AdoptionOutcome::NothingToAdopt => "nothing-to-adopt".to_string(),
            AdoptionOutcome::ConcurrentlyAdopted => "concurrently-adopted".to_string(),
            AdoptionOutcome::DeclinedByUser => "declined".to_string(),
            AdoptionOutcome::Adopted { .. } => "adopted".to_string(),
            // Handled above; the early return keeps the word list a list of successes.
            AdoptionOutcome::Failed { .. } => unreachable!("returned above"),
        })
    })
    .await
    .map_err(|e| format!("the adoption task did not finish: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::manifest::{read_manifest, write_manifest_atomic, Manifest};
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A body that satisfies the application's own `looks_like_config` predicate.
    const CONFIG_BODY: &str = "[endpoint]\nhostname = \"example.org\"\nusername = \"u\"\n";

    /// A distinctive plaintext secret, so a test can prove it never reached the report channel.
    const SECRET: &str = "hunter2-NEVER-IN-A-LOG";

    static SANDBOX_SEQ: AtomicU32 = AtomicU32::new(0);

    /// A fresh, empty directory under the OS temp dir.
    ///
    /// Deliberately NOT the data root and deliberately not reached through
    /// `user_data_dir()`: there is a verified backup of his live folder at
    /// `C:\Users\<user>\Documents\TrustTunnel-backup-2026-09-05` precisely because this class of
    /// code has destroyed data before, and a test that can see real data is a test that can eat it.
    fn sandbox(tag: &str) -> PathBuf {
        let n = SANDBOX_SEQ.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "tt-adopt-{}-{}-{}-{}",
            std::process::id(),
            tag,
            n,
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).expect("sandbox");
        p
    }

    /// A refusal is one-way and there is no surface that undoes it, so it may only be recorded in
    /// answer to a question that is genuinely outstanding.
    ///
    /// Both directions, in twin sandboxes, because the pair is the whole point: refusing where
    /// nothing was asked must write NOTHING (a marker there silences the offer for ever, about the
    /// user's servers and credentials, on a machine where nobody was ever asked), and refusing
    /// where the offer IS pending must still work — a gate that also blocked the real answer would
    /// be worse than the hole it closes.
    #[test]
    fn a_refusal_is_only_recorded_against_a_question_that_was_asked() {
        // (1) Nothing to offer: the legacy root is empty, so no question exists.
        let legacy = sandbox("decline-nothing-legacy");
        let data = sandbox("decline-nothing-data");
        let outcome = record_decline_if_outstanding(Some(&legacy), &data);
        assert!(
            outcome.is_err(),
            "a refusal was recorded although no offer was outstanding: {outcome:?}"
        );
        assert!(
            !data.join(MIGRATION_DECLINED_MARKER).exists(),
            "the permanent decline marker was written on a machine where the question was never \
             asked. Once it exists the offer is silenced for ever and there is no way back — so \
             the write itself, not only its return value, is what must not happen"
        );

        // (2) The real answer, in a twin sandbox seeded so an adoption WOULD copy something.
        let legacy_real = sandbox("decline-pending-legacy");
        let data_real = sandbox("decline-pending-data");
        write(&legacy_real, "srv.toml", CONFIG_BODY);
        assert!(
            offer_is_pending(Some(&legacy_real), &data_real),
            "fixture check: this sandbox must have an outstanding offer, otherwise the arm below \
             proves nothing"
        );
        record_decline_if_outstanding(Some(&legacy_real), &data_real)
            .expect("the genuine refusal must be recorded");
        assert!(
            data_real.join(MIGRATION_DECLINED_MARKER).exists(),
            "«Не переносить» must still be written down — a gate that blocked the real answer \
             would be worse than the hole it closes"
        );

        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&legacy_real);
        let _ = std::fs::remove_dir_all(&data_real);
    }

    fn write(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&p, body).expect("write fixture");
        p
    }

    fn entry(root: &Path, file: &str, name: &str, order: u32, last_used: bool) -> ConfigEntry {
        ConfigEntry {
            id: format!("id-{file}"),
            name: name.to_string(),
            path: root.join(file).to_string_lossy().to_string(),
            order,
            last_used,
            copy: false,
        }
    }

    /// Count the `.toml` files in `dir` that the APPLICATION would call a server config.
    ///
    /// Composed from `manifest::looks_like_config` rather than re-typing the predicate: a second
    /// copy of "what counts as a server config" would let this test agree with itself instead of
    /// with the reconciler, and disagreeing with the reconciler is exactly how the duplicate rows
    /// appeared in the first place.
    fn config_files_on_disk(dir: &Path) -> usize {
        let mut n = 0;
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            // Case-INSENSITIVE on the extension, and `Cargo.toml` excluded by name, because that
            // is exactly what `adopt_orphans_in_dir` and the fs-watcher do. A helper stricter than
            // production counts a different population from the one production adopts, and then
            // the count invariant compares two answers to two different questions.
            let ext = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|x| x.to_ascii_lowercase())
                .unwrap_or_default();
            if ext != "toml" || p.file_name().and_then(|s| s.to_str()) == Some("Cargo.toml") {
                continue;
            }
            if let Ok(c) = std::fs::read_to_string(&p) {
                if crate::commands::manifest::looks_like_config(&c) {
                    n += 1;
                }
            }
        }
        n
    }

    /// Every file under `dir`, with its size and modification time, sorted. The subject of the
    /// idempotence assertion: a returned "I did nothing" flag is the code's own opinion of itself,
    /// while this is the filesystem's.
    fn snapshot(dir: &Path) -> Vec<(String, u64, Option<std::time::SystemTime>)> {
        fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, u64, Option<std::time::SystemTime>)>) {
            for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let p = e.path();
                let rel = p
                    .strip_prefix(base)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .to_string();
                match e.metadata() {
                    Ok(m) if m.is_dir() => {
                        out.push((rel, 0, None));
                        walk(&p, base, out);
                    }
                    Ok(m) => out.push((rel, m.len(), m.modified().ok())),
                    Err(_) => out.push((rel, 0, None)),
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, dir, &mut out);
        out.sort();
        out
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // 1-3: the pure decision. No filesystem — these are the three repairs stated directly.
    // ─────────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn an_entry_naming_the_legacy_root_comes_back_naming_the_data_root() {
        // GUARDS: the shipped defect. `configs.json` was copied as a BLOB, so every entry still
        // named the old root; the confinement guard (which follows the data root by construction)
        // refused all five, and the folder-as-truth reconciler minted a second set from the copied
        // `.toml` files. Five servers displayed as ten with the visible half dead, on the
        // own machine. 30.1-REGRESSION.md § 2 step 3 + § 5 Repair 1.
        let legacy = PathBuf::from(r"D:\Custom\TrustTunnel Client Pro");
        let data = PathBuf::from(r"C:\Users\u\AppData\Local\TrustTunnel Client Pro");

        let out = rewrite_entries_onto_root(
            &[],
            &[entry(&legacy, "server-a.toml", "Нидерланды", 0, true)],
            &legacy,
            &data,
        );

        assert_eq!(out.entries.len(), 1);
        assert_eq!(
            out.entries[0].path,
            data.join("server-a.toml").to_string_lossy().to_string(),
            "the entry must name the CURRENT data root; carrying the legacy path is the blob-copy \
             defect that refused every server on a real install"
        );
    }

    #[test]
    fn name_order_last_used_and_copy_survive_the_rewrite_byte_identically() {
        // GUARDS: Repair 1 shape (b) — "let the reconciler rebuild the manifest" — is simpler and
        // self-consistent with folder-as-truth, and it LOSES the user's card names, their priority
        // ordering and which server they last used. Those are the user's own data, which is why
        // shape (a) was chosen. `copy` rides along because it is durable user intent
        // (`#[serde(default)]`, set at every copy-creation site) and a lost `copy` flag makes the
        // delete identity-sweep eat a copy the user deliberately made.
        let legacy = PathBuf::from(r"D:\Custom\TT");
        let data = PathBuf::from(r"C:\Data\TT");
        let mut src = entry(&legacy, "s.toml", "Мой сервер", 7, true);
        src.copy = true;

        let out = rewrite_entries_onto_root(&[], std::slice::from_ref(&src), &legacy, &data);

        let got = &out.entries[0];
        assert_eq!(got.name, src.name, "the user named this card");
        assert_eq!(got.order, src.order, "the user ordered this list");
        assert_eq!(got.last_used, src.last_used, "the user last used this server");
        assert_eq!(got.copy, src.copy, "the user deliberately made this a copy");
        assert_eq!(got.id, src.id, "the id is the card's React key and is never re-derived");
    }

    #[test]
    fn two_rows_resolving_to_one_canonical_filename_yield_one_row_and_a_dropped_count() {
        // GUARDS: the arithmetic of the shipped defect. Ten rows for five servers happened because
        // nothing de-duplicated across roots — the de-dup key could not see across directories
        // (30.1-REGRESSION.md § 2 step 6). Two rows that land on the same destination file must
        // collapse to one, and the drop must be COUNTED so the report can say it happened.
        let legacy = PathBuf::from(r"D:\Custom\TT");
        let data = PathBuf::from(r"C:\Data\TT");

        let out = rewrite_entries_onto_root(
            &[],
            &[
                entry(&legacy, "dup.toml", "first", 0, true),
                entry(&legacy, "DUP.toml", "second", 1, false),
            ],
            &legacy,
            &data,
        );

        assert_eq!(out.entries.len(), 1, "one destination file cannot be two rows");
        assert_eq!(out.dropped, 1, "the drop must be counted, not silently swallowed");
        assert_eq!(out.entries[0].name, "first", "the first row wins; the later one is the dup");
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // 4-5: the two machine-checkable invariants, over a real filesystem.
    // ─────────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn after_adoption_the_entry_count_equals_the_config_file_count_on_disk() {
        // GUARDS: invariant (ii) from 30.1-REGRESSION.md's "regression tests this needs". On the
        // a real machine `configs.json` held ten entries against five files. The count is the
        // cheapest possible statement of "the manifest describes what is actually there".
        let legacy = sandbox("count-legacy");
        let data = sandbox("count-data");
        for f in ["a.toml", "b.toml", "c.toml"] {
            write(&legacy, f, CONFIG_BODY);
        }
        let manifest = Manifest {
            schema_version: 1,
            configs: vec![
                entry(&legacy, "a.toml", "A", 0, true),
                entry(&legacy, "b.toml", "B", 1, false),
                entry(&legacy, "c.toml", "C", 2, false),
            ],
        };
        write_manifest_atomic(&legacy, &manifest).expect("seed legacy manifest");

        let mut emit = |_: &str| {};
        let outcome = adopt_into(Some(&legacy), &data, &mut emit);
        assert!(matches!(outcome, AdoptionOutcome::Adopted { .. }), "got {outcome:?}");

        let adopted = read_manifest(&data).expect("read adopted manifest");
        assert_eq!(
            adopted.configs.len(),
            config_files_on_disk(&data),
            "the manifest must describe exactly the server configs that are on disk"
        );
        assert_eq!(adopted.configs.len(), 3);

        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn after_adoption_no_manifest_entry_resolves_outside_the_data_root() {
        // GUARDS: invariant (i). The path-confinement guard derives from `user_data_dir()` by
        // construction, so an entry outside the data root is an entry the app will refuse forever
        // — silently, with the file sitting right there on disk. Every one of the five
        // servers was in exactly that state.
        let legacy = sandbox("confine-legacy");
        let data = sandbox("confine-data");
        write(&legacy, "srv.toml", CONFIG_BODY);
        write_manifest_atomic(
            &legacy,
            &Manifest {
                schema_version: 1,
                configs: vec![entry(&legacy, "srv.toml", "S", 0, true)],
            },
        )
        .expect("seed");

        let mut emit = |_: &str| {};
        adopt_into(Some(&legacy), &data, &mut emit);

        let adopted = read_manifest(&data).expect("read");
        assert!(!adopted.configs.is_empty(), "nothing to measure means nothing was proven");
        for c in &adopted.configs {
            assert!(
                Path::new(&c.path).starts_with(&data),
                "entry {:?} resolves outside the data root {:?} — the guard will refuse it and \
                 the user will see an empty list with their files still on disk",
                c.path,
                data
            );
        }

        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&data);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // 6-8: the branches that must do nothing, each distinguishable from the others.
    // ─────────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_second_adoption_mutates_nothing_on_disk() {
        // GUARDS: idempotence, asserted on OBSERVED FILESYSTEM MUTATION rather than on a returned
        // flag. A function that reports "I did nothing" is giving its own opinion of itself; the
        // directory listing is not. Note the assertion also covers the lock file: the marker check
        // must come BEFORE the lock is taken, or every launch would create and delete a file in
        // the user's data root forever.
        let legacy = sandbox("idem-legacy");
        let data = sandbox("idem-data");
        write(&legacy, "one.toml", CONFIG_BODY);
        write_manifest_atomic(
            &legacy,
            &Manifest {
                schema_version: 1,
                configs: vec![entry(&legacy, "one.toml", "One", 0, true)],
            },
        )
        .expect("seed");

        let mut emit = |_: &str| {};
        let first = adopt_into(Some(&legacy), &data, &mut emit);
        assert!(matches!(first, AdoptionOutcome::Adopted { .. }), "got {first:?}");

        let before = snapshot(&data);
        let mut lines: Vec<String> = Vec::new();
        let second = {
            let mut e2 = |s: &str| lines.push(s.to_string());
            adopt_into(Some(&legacy), &data, &mut e2)
        };

        assert_eq!(second, AdoptionOutcome::AlreadyDone);
        assert_eq!(snapshot(&data), before, "the second run wrote, copied or deleted something");
        assert!(lines.is_empty(), "a no-op must not report a migration");

        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn a_legacy_root_that_is_the_data_root_copies_nothing_and_says_so_in_its_own_words() {
        // GUARDS: the D-05 common case, which is the outcome on nearly every machine in the field
        // — the binaries left the folder and the data stayed. It gets its own explicit arm because
        // "did nothing because it is the same place" and "did nothing because there was nothing
        // there" are different facts, and a shared value for them is what made the previous
        // failure unexplainable after the event.
        let root = sandbox("same-root");
        write(&root, "x.toml", CONFIG_BODY);
        let before = snapshot(&root);

        let mut lines: Vec<String> = Vec::new();
        let outcome = {
            let mut emit = |s: &str| lines.push(s.to_string());
            adopt_into(Some(&root), &root, &mut emit)
        };

        assert_eq!(outcome, AdoptionOutcome::SameRoot);
        assert_eq!(snapshot(&root), before, "the same place must not be copied onto itself");
        assert!(lines.is_empty(), "nothing happened, so nothing may be reported as having happened");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn nothing_found_and_nothing_to_take_each_report_that_nothing_was_adopted() {
        // GUARDS: "the report must be able to say NO." An outcome that spelled these the same as a
        // successful adoption would make the log useless for the one question anybody will ask
        // after a support call — did it run, and did it find anything?
        let data = sandbox("empty-data");
        let empty_legacy = sandbox("empty-legacy");

        let mut lines: Vec<String> = Vec::new();
        let (none, empty) = {
            let mut emit = |s: &str| lines.push(s.to_string());
            let a = adopt_into(None, &data, &mut emit);
            let b = adopt_into(Some(&empty_legacy), &data, &mut emit);
            (a, b)
        };

        assert_eq!(none, AdoptionOutcome::NoLegacyRoot);
        assert_eq!(empty, AdoptionOutcome::NothingToAdopt);
        assert_ne!(none, empty, "«not found» and «found but empty» are different facts");
        assert!(
            !matches!(none, AdoptionOutcome::Adopted { .. })
                && !matches!(empty, AdoptionOutcome::Adopted { .. }),
            "neither may claim a migration"
        );
        assert!(lines.is_empty(), "no migration happened, so no migration may be reported");
        assert!(
            !data.join(ADOPTION_MARKER).exists(),
            "an adoption that did not happen must not leave a marker suppressing the one that could"
        );

        let _ = std::fs::remove_dir_all(&data);
        let _ = std::fs::remove_dir_all(&empty_legacy);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // 9-10: the two properties the previous implementation could not demonstrate at all.
    // ─────────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_summary_reaches_the_emit_channel_and_carries_integer_counts_only() {
        // GUARDS: Repair 7. The previous implementation's D-29 summary line was UNREACHABLE for
        // two independent reasons — `LOG_TX` was unset that early, and `init_logging()` itself
        // early-returns unless the `.enable_logs` marker exists. So "it logged nothing" proved
        // nothing, and OPEN-5 could not be closed even in principle. This test exercises the
        // CHANNEL rather than the return value, which is what turns the report into evidence.
        //
        // It is also the D-29 spy: the legacy root here holds a plaintext credentials file, and no
        // emitted line may contain the secret in it, nor any filesystem path.
        let legacy = sandbox("emit-legacy");
        let data = sandbox("emit-data");
        write(&legacy, "srv.toml", CONFIG_BODY);
        write(
            &legacy,
            "ssh_credentials.json",
            &format!("{{\"host\":{{\"password\":\"{SECRET}\"}}}}"),
        );
        write_manifest_atomic(
            &legacy,
            &Manifest {
                schema_version: 1,
                configs: vec![
                    entry(&legacy, "srv.toml", "S", 0, true),
                    entry(&legacy, "srv.toml", "S dup", 1, false),
                ],
            },
        )
        .expect("seed");

        let mut lines: Vec<String> = Vec::new();
        let outcome = {
            let mut emit = |s: &str| lines.push(s.to_string());
            adopt_into(Some(&legacy), &data, &mut emit)
        };

        assert!(matches!(outcome, AdoptionOutcome::Adopted { .. }), "got {outcome:?}");
        assert!(!lines.is_empty(), "the summary line must be REACHABLE, which is the whole point");

        let summary = lines.join("\n");
        assert!(
            summary.contains("artifacts=") && summary.contains("entries=") && summary.contains("dropped="),
            "the summary must name what it did in integers: {summary}"
        );
        assert!(
            summary.contains("dropped=1"),
            "the duplicate row was dropped and the report must say so: {summary}"
        );
        for line in &lines {
            assert!(!line.contains(SECRET), "a password reached the report channel: {line}");
            assert!(
                !line.contains('\\') && !line.contains('/') && !line.contains(':'),
                "the report carries integer counts only — no path may appear in it (D-29): {line}"
            );
        }

        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn two_threads_entering_adoption_against_one_root_perform_exactly_one_adoption() {
        // GUARDS: OPEN-5. `tauri_plugin_single_instance` is registered inside `run()`, so a second
        // process launched concurrently executes its FULL adoption before it is told to exit. The
        // marker gate cannot cover that — both processes can observe it absent at the same instant
        // — which is why this test exists: it is what forces the exclusive lock. Threads stand in
        // for processes; the lock is a filesystem object and does not care which it is.
        let legacy = sandbox("race-legacy");
        let data = sandbox("race-data");
        for f in ["r1.toml", "r2.toml"] {
            write(&legacy, f, CONFIG_BODY);
        }
        write_manifest_atomic(
            &legacy,
            &Manifest {
                schema_version: 1,
                configs: vec![
                    entry(&legacy, "r1.toml", "R1", 0, true),
                    entry(&legacy, "r2.toml", "R2", 1, false),
                ],
            },
        )
        .expect("seed");

        let handles: Vec<_> = (0..2)
            .map(|_| {
                let l = legacy.clone();
                let d = data.clone();
                std::thread::spawn(move || {
                    let mut emit = |_: &str| {};
                    adopt_into(Some(&l), &d, &mut emit)
                })
            })
            .collect();
        let outcomes: Vec<AdoptionOutcome> =
            handles.into_iter().map(|h| h.join().expect("thread")).collect();

        let performed = outcomes
            .iter()
            .filter(|o| matches!(o, AdoptionOutcome::Adopted { .. }))
            .count();
        assert_eq!(performed, 1, "exactly one adoption may run; got {outcomes:?}");
        assert!(
            outcomes.iter().any(|o| matches!(
                o,
                AdoptionOutcome::ConcurrentlyAdopted | AdoptionOutcome::AlreadyDone
            )),
            "the loser must observe the completed state, not fail: {outcomes:?}"
        );

        let adopted = read_manifest(&data).expect("read");
        assert_eq!(
            adopted.configs.len(),
            config_files_on_disk(&data),
            "a race must not leave the manifest disagreeing with the disk"
        );
        assert!(
            !data.join(ADOPTION_LOCK).exists(),
            "the lock must be released, or the next launch waits on a file nobody holds"
        );

        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&data);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // 11-13: the recorded answer (phase 32 plan 08, `no-fork`). The offer is drawn by the
    // APPLICATION at first launch, so these arms are the whole of «the user was asked».
    // ─────────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_recorded_decline_skips_the_adoption_while_no_answer_performs_it() {
        // GUARDS: the offer would be theatre without this. Two sandboxes seeded IDENTICALLY, so
        // the only difference between them is the recorded answer — one is declined, one was never
        // asked. The declined root must come out untouched and the un-asked root must be adopted,
        // and both facts are read off the FILESYSTEM rather than off a returned flag, because a
        // function's opinion of what it did is exactly what the previous migration got wrong.
        //
        // «Absent means adopt» is not a convenience default: a user who never saw the offer (a
        // silent self-update, a launch where the window never opened) is not harmed by an adoption
        // that finds nothing, and IS harmed by an orphaning that finds something and ignores it.
        let declined_legacy = sandbox("declined-legacy");
        let declined_data = sandbox("declined-data");
        let asked_legacy = sandbox("unasked-legacy");
        let asked_data = sandbox("unasked-data");
        for legacy in [&declined_legacy, &asked_legacy] {
            write(legacy, "srv.toml", CONFIG_BODY);
            write(legacy, "ssh_credentials.json", "{}");
        }

        record_decline(&declined_data).expect("record the refusal");
        let before_declined = snapshot(&declined_data);

        let mut lines: Vec<String> = Vec::new();
        let (declined, adopted) = {
            let mut emit = |s: &str| lines.push(s.to_string());
            let a = adopt_into(Some(&declined_legacy), &declined_data, &mut emit);
            let b = adopt_into(Some(&asked_legacy), &asked_data, &mut emit);
            (a, b)
        };

        assert_eq!(declined, AdoptionOutcome::DeclinedByUser);
        assert!(matches!(adopted, AdoptionOutcome::Adopted { .. }), "got {adopted:?}");
        assert_eq!(
            snapshot(&declined_data),
            before_declined,
            "«Не переносить» must mean nothing was copied — not «copied, then not mentioned»"
        );
        assert!(
            !declined_data.join("srv.toml").exists() && !declined_data.join("ssh_credentials.json").exists(),
            "the declined root must hold none of the legacy artifacts"
        );
        assert!(
            asked_data.join("srv.toml").exists() && asked_data.join("ssh_credentials.json").exists(),
            "with no answer recorded the adoption must run, or an un-asked user is orphaned"
        );
        assert!(
            !declined_data.join(ADOPTION_MARKER).exists(),
            "a refusal is not an adoption and must not leave the adoption's marker behind"
        );

        for p in [&declined_legacy, &declined_data, &asked_legacy, &asked_data] {
            let _ = std::fs::remove_dir_all(p);
        }
    }

    /// Answer the OTHER half of the «exactly when»: would an adoption against a destination in
    /// this state actually copy anything?
    ///
    /// Read off the FILESYSTEM as well as the returned outcome, and the two are required to agree —
    /// «I did nothing» is the function's opinion of itself, and this module exists because a
    /// previous migration's opinion of itself was wrong.
    ///
    /// Its own fresh sandbox every time, seeded by the same closure the probe's sandbox was: an
    /// adoption WRITES (the marker, on the branch that performs), so asking the probe and the
    /// adoption about one directory in sequence would let the first answer change the second.
    fn an_adoption_would_copy_something(
        legacy: Option<&Path>,
        seed: &dyn Fn(&Path),
        tag: &str,
    ) -> bool {
        let data = sandbox(tag);
        seed(&data);
        let before = snapshot(&data);
        let mut emit = |_: &str| {};
        let outcome = adopt_into(legacy, &data, &mut emit);
        let performed = matches!(outcome, AdoptionOutcome::Adopted { .. });
        assert_eq!(
            performed,
            snapshot(&data) != before,
            "«it adopted» and «the folder changed» must be the same fact; got {outcome:?}"
        );
        let _ = std::fs::remove_dir_all(&data);
        performed
    }

    /// Assert BOTH directions of the biconditional for one state of the destination.
    fn the_offer_and_the_adoption_agree(
        legacy: Option<&Path>,
        seed: &dyn Fn(&Path),
        tag: &str,
        why: &str,
    ) -> bool {
        let probe_root = sandbox(&format!("{tag}-probe"));
        seed(&probe_root);
        let pending = offer_is_pending(legacy, &probe_root);
        let _ = std::fs::remove_dir_all(&probe_root);

        let would_copy = an_adoption_would_copy_something(legacy, seed, &format!("{tag}-adopt"));
        assert_eq!(
            pending, would_copy,
            "«pending exactly when an adoption would copy something» — {why}: pending={pending}, \
             would copy={would_copy}"
        );
        pending
    }

    #[test]
    fn the_offer_is_pending_exactly_when_an_adoption_would_copy_something() {
        // GUARDS: the correspondence `offer_is_pending` claims in its own doc comment. The two are
        // separate functions — the probe runs before the window exists, the adoption runs after the
        // answer — so nothing but a test keeps them saying the same thing. Drift in either
        // direction is a defect with a face: ask the D-05 majority a question that has no effect on
        // them, or adopt somebody's data without asking.
        //
        // BOTH directions are asserted, one state at a time. Asserting only `offer_is_pending`
        // would leave the name of this test a promise: an «exactly when» checked in one direction
        // is not an «exactly when», and the half that was missing is the half that says the
        // adoption behind the question actually does what the question offered.
        let legacy = sandbox("pending-legacy");
        write(&legacy, "srv.toml", CONFIG_BODY);
        let empty_legacy = sandbox("pending-empty-legacy");

        let nothing = |_: &Path| {};
        let declined = |d: &Path| {
            record_decline(d).expect("record the refusal");
        };
        let already = |d: &Path| {
            write_bytes_atomic(&d.join(ADOPTION_MARKER), b"already\n").expect("mark adopted");
        };

        assert!(
            the_offer_and_the_adoption_agree(
                Some(&legacy),
                &nothing,
                "pending-live",
                "a discovered legacy root elsewhere, holding data, with no answer on file — the one \
                 population the offer exists for"
            ),
            "this state must be pending, in both directions"
        );
        assert!(
            !the_offer_and_the_adoption_agree(
                None,
                &nothing,
                "pending-none",
                "nothing discovered — nothing to ask about"
            ),
            "this state must not be pending, in either direction"
        );
        assert!(
            !the_offer_and_the_adoption_agree(
                Some(&empty_legacy),
                &nothing,
                "pending-empty",
                "found a folder with nothing in it — asking would promise a migration of nothing"
            ),
            "this state must not be pending, in either direction"
        );
        assert!(
            !the_offer_and_the_adoption_agree(
                Some(&legacy),
                &declined,
                "pending-declined",
                "a refusal is not re-asked, and nothing is copied behind it either"
            ),
            "this state must not be pending, in either direction"
        );
        assert!(
            !the_offer_and_the_adoption_agree(
                Some(&legacy),
                &already,
                "pending-already",
                "an adopted root has nothing left to offer and nothing left to copy"
            ),
            "this state must not be pending, in either direction"
        );

        // The D-05 same-folder case cannot go through the helper: its legacy root IS the
        // destination, so the two must be one directory rather than a seeded twin.
        let same = sandbox("pending-same");
        write(&same, "x.toml", CONFIG_BODY);
        let before = snapshot(&same);
        let mut emit = |_: &str| {};
        let same_outcome = adopt_into(Some(&same), &same, &mut emit);
        assert!(
            !offer_is_pending(Some(&same), &same),
            "the D-05 same-folder case: the files never moved, so the question has no content"
        );
        assert!(
            !matches!(same_outcome, AdoptionOutcome::Adopted { .. }),
            "and the adoption behind it copies nothing either; got {same_outcome:?}"
        );
        assert_eq!(snapshot(&same), before, "the same place must not be copied onto itself");

        for p in [&legacy, &empty_legacy, &same] {
            let _ = std::fs::remove_dir_all(p);
        }
    }

    #[test]
    fn the_recorded_refusal_carries_no_path_and_no_account() {
        // GUARDS: D-29 applied to the one new file this plan writes into the user's folder. The
        // adoption's own report is already spied on for this; the refusal marker is written on a
        // different path and would otherwise be the one artifact nobody checked. A path here would
        // be the beginning of the same leak — the marker's job is to EXIST, and a field added
        // «while we are here» is a field somebody eventually reads out of a user's folder.
        let data = sandbox("decline-content");
        record_decline(&data).expect("record the refusal");

        let body = std::fs::read_to_string(data.join(MIGRATION_DECLINED_MARKER)).expect("read it back");
        assert!(!body.is_empty(), "an empty marker is indistinguishable from a failed write");
        assert!(
            body.is_ascii(),
            "the marker is a machine fact, not a message to the user: {body:?}"
        );
        assert!(
            !body.contains(':') && !body.contains('\\') && !body.contains('/'),
            "a path is what a leak looks like here: {body:?}"
        );
        assert!(
            record_decline(&data).is_ok(),
            "recording twice must be harmless — the window can be answered on a launch that already \
             had the file, and a hard error there would surface as a failed refusal"
        );

        let _ = std::fs::remove_dir_all(&data);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // 14: the write that fails. CR-02 — by the time the manifest is written the credentials and
    // every `.toml` are already in the destination, so a failure reported as a success is not
    // untidy, it is the 30.1 regression by a new route.
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// Hold `path` open with a share mode that permits READING but not deletion, so a rename can
    /// neither replace nor remove it. That is precisely what an antivirus scanner or a backup agent
    /// holding a file looks like to `atomic_write`, and it is the failure CR-02 names — the read of
    /// the destination manifest still succeeds, only the write fails, which is the case that leaves
    /// the copies stranded.
    #[cfg(windows)]
    fn hold_undeletable(path: &Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_SHARE_READ only. Without FILE_SHARE_DELETE the `MoveFileExW` behind `fs::rename`
        // cannot delete the destination it is replacing and fails with a sharing violation.
        const FILE_SHARE_READ: u32 = 0x0000_0001;
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ)
            .open(path)
            .expect("hold the destination manifest open")
    }

    #[cfg(windows)]
    #[test]
    fn a_failed_manifest_write_is_reported_as_a_failure_and_leaves_no_half_adopted_root() {
        // GUARDS: CR-02. The old code returned `ConcurrentlyAdopted` here — "another process got
        // there first" — for a case where no other process exists, discarded the error, and the
        // window read it as success. The destination was left holding the credentials and every
        // `.toml` with NO manifest describing them, which is the state the folder-as-truth
        // reconciler turns into nameless rows and the next launch then drops as duplicates. The
        // user's card names, ordering and last-used history are gone, permanently, and he was told
        // it worked.
        let legacy = sandbox("writefail-legacy");
        let data = sandbox("writefail-data");
        write(&legacy, "srv.toml", CONFIG_BODY);
        write(
            &legacy,
            "ssh_credentials.json",
            &format!("{{\"h\":{{\"password\":\"{SECRET}\"}}}}"),
        );
        write_manifest_atomic(
            &legacy,
            &Manifest {
                schema_version: 1,
                configs: vec![entry(&legacy, "srv.toml", "Мой сервер", 0, true)],
            },
        )
        .expect("seed legacy");
        // A destination whose manifest READS fine, so the only thing that fails is the write.
        write_manifest_atomic(&data, &Manifest { schema_version: 1, configs: vec![] })
            .expect("seed destination");

        let held = hold_undeletable(&data.join("configs.json"));
        let mut lines: Vec<String> = Vec::new();
        let outcome = {
            let mut emit = |s: &str| lines.push(s.to_string());
            adopt_into(Some(&legacy), &data, &mut emit)
        };
        drop(held);

        match &outcome {
            AdoptionOutcome::Failed { reason, .. } => {
                assert!(!reason.is_empty(), "the diagnostic is the whole reason this variant exists");
            }
            other => panic!(
                "a failed manifest write must be its OWN fact, never «another process did it»; got {other:?}"
            ),
        }

        // The destination must be back where it started: nothing half-adopted for the reconciler
        // to mint nameless rows out of.
        assert!(
            !data.join("srv.toml").exists(),
            "the copied config was left behind with no manifest describing it — this is what the \
             reconciler turns into a nameless row and the next launch drops as a duplicate"
        );
        assert!(
            !data.join("ssh_credentials.json").exists(),
            "the credentials were left behind by an adoption that did not finish"
        );
        assert!(
            !data.join(ADOPTION_MARKER).exists(),
            "a failed adoption must leave no marker, or the retry that could recover never runs"
        );
        assert!(!data.join(ADOPTION_LOCK).exists(), "the lock must be released on the failure leg");

        for line in &lines {
            assert!(!line.contains(SECRET), "a password reached the report channel: {line}");
            assert!(
                !line.contains('\\') && !line.contains('/'),
                "no path may appear in the failure report either (D-29): {line}"
            );
        }

        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&data);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // 15: the two chains that lose `name`, `order` and `last_used` — the three fields Repair 1
    // shape (a) was chosen over shape (b) precisely to preserve. Both are a `read_manifest` error
    // collapsed into an empty list by `unwrap_or_default()`, and both are permanent, because the
    // marker is written afterwards and the next launch never retries.
    // ─────────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn an_unreadable_legacy_manifest_refuses_rather_than_deriving_the_names_it_could_not_read() {
        // GUARDS: chain 1. `read_manifest` answers `Ok(default)` for «there is no manifest» and
        // `Err` ONLY for «there is one and it cannot be read» — a truncated write, a half-synced
        // file, a scanner mid-quarantine. Defaulting the second to an empty list copies every
        // `.toml` and then lets the folder reconciler re-mint them with a DERIVED name, the order
        // pushed to the end and `last_used` cleared. The servers still work; the user's card names
        // and his ordering do not come back, and he is told the migration succeeded.
        let legacy = sandbox("badlegacy-legacy");
        let data = sandbox("badlegacy-data");
        write(&legacy, "srv.toml", CONFIG_BODY);
        write(&legacy, "configs.json", "{ this was never valid json");

        let mut lines: Vec<String> = Vec::new();
        let outcome = {
            let mut emit = |s: &str| lines.push(s.to_string());
            adopt_into(Some(&legacy), &data, &mut emit)
        };

        assert!(
            matches!(outcome, AdoptionOutcome::Failed { .. }),
            "a manifest that is present and unreadable is a failure, not an empty one; got {outcome:?}"
        );
        assert!(
            !data.join("srv.toml").exists(),
            "nothing may be copied on the strength of a manifest that could not be read — the copy              is what the reconciler then names for him"
        );
        assert!(
            !data.join(ADOPTION_MARKER).exists(),
            "no marker, or the launch that could still read the manifest never gets to try"
        );

        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn an_unreadable_destination_manifest_is_never_written_over_with_an_empty_one() {
        // GUARDS: chain 2, the same collapse on the other root and worse, because these rows are
        // not the migration's to lose. An unreadable DESTINATION `configs.json` defaulted to an
        // empty list, the adoption merged onto that emptiness, and then WROTE it back — so the
        // running install's own cards lost their names, their order and their last-used flag to a
        // migration that was never about them. The bytes on disk are the subject of the assertion,
        // not a returned flag: «it did not write» is the code's opinion of itself.
        let legacy = sandbox("baddest-legacy");
        let data = sandbox("baddest-data");
        write(&legacy, "srv.toml", CONFIG_BODY);
        write_manifest_atomic(
            &legacy,
            &Manifest {
                schema_version: 1,
                configs: vec![entry(&legacy, "srv.toml", "Мой сервер", 0, true)],
            },
        )
        .expect("seed legacy");
        write(&data, "dest.toml", CONFIG_BODY);
        write(&data, "configs.json", "{\"schema_version\": 1, \"configs\": [ truncated");
        let before = std::fs::read(data.join("configs.json")).expect("read the seeded manifest");

        let mut lines: Vec<String> = Vec::new();
        let outcome = {
            let mut emit = |s: &str| lines.push(s.to_string());
            adopt_into(Some(&legacy), &data, &mut emit)
        };

        assert!(
            matches!(outcome, AdoptionOutcome::Failed { .. }),
            "an unreadable destination manifest is a failure, not an empty one; got {outcome:?}"
        );
        assert_eq!(
            std::fs::read(data.join("configs.json")).expect("read it back"),
            before,
            "the destination manifest was overwritten — every name, order and last_used it held is              gone, for servers this migration was never about"
        );
        assert!(
            !data.join("srv.toml").exists(),
            "nothing may be copied into a destination whose own manifest could not be read"
        );
        assert!(!data.join(ADOPTION_MARKER).exists(), "no marker, so the next launch retries");

        for line in &lines {
            assert!(!line.contains(SECRET), "a password reached the report channel: {line}");
            assert!(
                !line.contains('\\') && !line.contains('/'),
                "no path may appear in a refusal either (D-29): {line}"
            );
        }

        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&data);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // 16: the measuring stick itself. `config_files_on_disk` is what the count invariant is read
    // off, so a helper that disagrees with the reconciler about what counts as a server config
    // measures its own opinion — which is the exact mistake (a second opinion about what a server
    // is) that turned five servers into ten.
    // ─────────────────────────────────────────────────────────────────────────────────────────

    /// How many rows the APPLICATION's own reconciler mints for the configs in `dir`.
    fn configs_the_reconciler_sees(dir: &Path) -> usize {
        let mut m = Manifest { schema_version: 1, configs: vec![] };
        crate::commands::manifest::adopt_orphans_in_dir(dir, &mut m);
        m.configs.len()
    }

    #[test]
    fn the_helper_and_the_reconciler_agree_about_what_counts_as_a_server_config() {
        // GUARDS: the helper was case-SENSITIVE on the extension while production is case-
        // INSENSITIVE (`adopt_orphans_in_dir`: «`config.TOML` counts too, matching the fs-watcher»),
        // and it did not exclude `Cargo.toml` while production does. Each case gets its OWN
        // directory on purpose: put them together and the two errors cancel to the same integer,
        // and the count invariant reads green while measuring nothing.
        let upper = sandbox("helper-upper");
        write(&upper, "SHOUTY.TOML", CONFIG_BODY);
        assert_eq!(
            config_files_on_disk(&upper),
            configs_the_reconciler_sees(&upper),
            "an uppercase extension is a server config to the reconciler and to the fs-watcher; a \
             helper that cannot see it can disagree with the thing it is measuring"
        );

        let cargoish = sandbox("helper-cargo");
        write(&cargoish, "Cargo.toml", CONFIG_BODY);
        assert_eq!(
            config_files_on_disk(&cargoish),
            configs_the_reconciler_sees(&cargoish),
            "production excludes `Cargo.toml` by name; a helper that counts it invents a server \
             nothing in the application would ever show"
        );

        let plain = sandbox("helper-plain");
        write(&plain, "srv.toml", CONFIG_BODY);
        write(&plain, "notes.toml", "[ui]\ntheme = \"dark\"\n");
        assert_eq!(config_files_on_disk(&plain), 1, "the ordinary case must still be 1");
        assert_eq!(configs_the_reconciler_sees(&plain), 1);

        for d in [&upper, &cargoish, &plain] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────
    // 17: the count invariant against the cases the easy one skips — a legacy directory that is
    // not a clean room, and a destination that is already in use.
    // ─────────────────────────────────────────────────────────────────────────────────────────

    #[test]
    fn the_count_invariant_holds_on_a_messy_legacy_root_and_a_destination_already_in_use() {
        // GUARDS: the invariant is stated over «the server configs on disk», and the existing test
        // only ever asks it of an empty destination and an all-valid legacy root. A real legacy
        // INSTALL directory is not a clean room: the binaries are in it, so are the atomic-write
        // temps a crash left behind, and so is `trusttunnel_client.toml` — the single likeliest
        // inhabitant of one, and the one this module already hand-copies by name because (its own
        // words) it «may or may not satisfy the server predicate depending on how it was written».
        //
        // When it does NOT satisfy it, the keep-filter let its legacy row through anyway, because
        // the filter asked `is_file()` while its own comment claimed it was rejecting a row that
        // «was never a server config». So the manifest carried a row the application will never
        // show and can never open, and the invariant it is supposed to hold was false.
        let legacy = sandbox("messy-legacy");
        let data = sandbox("messy-data");

        // The user's servers.
        write(&legacy, "Netherlands.toml", CONFIG_BODY);
        write(&legacy, "SHOUTY.TOML", CONFIG_BODY);
        // The likeliest inhabitant, in the shape that is not a server config.
        write(&legacy, "trusttunnel_client.toml", "[client]\nmode = \"tun\"\n");
        // The junk a real folder holds.
        write(&legacy, "notes.toml", "[ui]\ntheme = \"dark\"\n");
        write(&legacy, "configs.json.4321.0.tmp", "{}");
        write(&legacy, "srv.toml.recovered", CONFIG_BODY);
        write(&legacy, "uninstall.exe", "MZ");
        write(&legacy, "ssh_credentials.json", "{}");
        // Neither of these may cross: `runtime/` holds password-bearing throwaways and `logs/` is
        // the previous install's diary.
        write(&legacy, "runtime/override.toml", CONFIG_BODY);
        write(&legacy, "logs/app.log", "hi");

        write_manifest_atomic(
            &legacy,
            &Manifest {
                schema_version: 1,
                configs: vec![
                    entry(&legacy, "Netherlands.toml", "Нидерланды", 0, true),
                    entry(&legacy, "trusttunnel_client.toml", "Старый", 1, false),
                    entry(&legacy, "SHOUTY.TOML", "Shouty", 2, false),
                    // A row whose file is simply gone — a folder the user has been deleting from.
                    entry(&legacy, "gone.toml", "Удалённый", 3, false),
                ],
            },
        )
        .expect("seed legacy");

        // A destination already in use: one tracked config, and one the folder holds with no row
        // (the reconciler's own append-only path put it there).
        write(&data, "dest.toml", CONFIG_BODY);
        write(&data, "orphan.toml", CONFIG_BODY);
        write_manifest_atomic(
            &data,
            &Manifest {
                schema_version: 1,
                configs: vec![entry(&data, "dest.toml", "Уже был", 0, false)],
            },
        )
        .expect("seed destination");

        let mut emit = |_: &str| {};
        let outcome = adopt_into(Some(&legacy), &data, &mut emit);
        assert!(matches!(outcome, AdoptionOutcome::Adopted { .. }), "got {outcome:?}");

        let adopted = read_manifest(&data).expect("read the adopted manifest");
        assert_eq!(
            adopted.configs.len(),
            config_files_on_disk(&data),
            "the manifest must describe exactly the server configs on disk — rows were {:?}",
            adopted
                .configs
                .iter()
                .map(|c| Path::new(&c.path).file_name().map(|n| n.to_string_lossy().to_string()))
                .collect::<Vec<_>>()
        );

        // The row that is not a server config must not be in the list. The FILE is still adopted —
        // it is the client configuration and losing it is a regression of its own — it simply is
        // not a server card.
        assert!(
            data.join("trusttunnel_client.toml").is_file(),
            "the client configuration must still be adopted; only its phantom server row is wrong"
        );
        assert!(
            !adopted
                .configs
                .iter()
                .any(|c| c.path.to_lowercase().ends_with("trusttunnel_client.toml")),
            "a row the application can never open must not be in the manifest"
        );

        // The user data Repair 1 shape (a) exists to preserve, across a NON-EMPTY destination.
        let nl = adopted
            .configs
            .iter()
            .find(|c| c.path.ends_with("Netherlands.toml"))
            .expect("the adopted server must be there");
        let shouty = adopted
            .configs
            .iter()
            .find(|c| c.path.ends_with("SHOUTY.TOML"))
            .expect("an uppercase extension is a server config in production");
        assert_eq!(nl.name, "Нидерланды", "the user named this card");
        assert!(nl.last_used, "the user last used this server, and the destination had no claim");
        assert_eq!(shouty.name, "Shouty");
        assert!(nl.order < shouty.order, "the user's ordering must survive the offset");

        // Nothing that was never meant to cross did.
        assert!(!data.join("notes.toml").exists(), "a stray non-config .toml is not adoptable data");
        assert!(!data.join("runtime").exists(), "runtime/ carries endpoint passwords and never crosses");
        assert!(!data.join("logs").exists(), "logs/ is the previous install's diary, not its state");
        assert!(!data.join("uninstall.exe").exists(), "the binaries follow the install, not the data");

        let _ = std::fs::remove_dir_all(&legacy);
        let _ = std::fs::remove_dir_all(&data);
    }
}
