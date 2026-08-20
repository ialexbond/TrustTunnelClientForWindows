use crate::ssh::portable_data_dir;
use trusttunnel_settings::{endpoint_from_deeplink_config, trusttunnel_deeplink};

/// Decode a trusttunnel:// deeplink URL and return the TOML config content.
///
/// Supports two payload formats:
/// 1. Base64-encoded TOML text (legacy)
/// 2. Binary protocol parsed by the upstream `trusttunnel-deeplink` crate
///    (supports all fields: client_random_prefix, custom_sni, certificate, etc.)
#[tauri::command]
pub async fn decode_deeplink(url: String) -> Result<String, String> {
    let trimmed = url.trim();

    // ── 1. Try upstream binary decoder first ──────────────────────
    //    trusttunnel_deeplink::decode handles tt:// and tt://? schemes
    if let Ok(config) = trusttunnel_deeplink::decode(trimmed) {
        let endpoint = endpoint_from_deeplink_config(config)
            .map_err(|e| format!("Failed to convert deeplink config: {e}"))?;
        let endpoint_toml =
            toml::to_string(&endpoint).map_err(|e| format!("Failed to serialize endpoint: {e}"))?;

        // Wrap [endpoint] block into a full client config
        return Ok(crate::ssh::build_client_config(&endpoint_toml, "Imported from deeplink"));
    }

    // ── 2. Fallback: base64-encoded TOML ─────────────────────────
    let after_proto = if let Some(rest) = trimmed.strip_prefix("trusttunnel://") {
        rest.trim_start_matches('/')
    } else if let Some(rest) = trimmed.strip_prefix("tt://") {
        rest.trim_start_matches('/')
    } else {
        return Err("Invalid deeplink: must start with trusttunnel:// or tt://".into());
    };

    // Extract base64 payload from query or path
    let config_b64 = if let Some(query) = after_proto.split('?').nth(1) {
        query
            .split('&')
            .find_map(|p| p.strip_prefix("config="))
            .unwrap_or(query)
    } else {
        after_proto
    };

    // URL-decode into a BYTE buffer (CR-01). The base64 payload is binary text;
    // decoding `%XX` escapes into a String via `byte as char` corrupted any byte
    // >= 0x80 (it became a multi-byte UTF-8 sequence), feeding the base64 engines
    // a mangled payload. Decoding to bytes and base64-decoding those bytes
    // directly keeps the payload exact.
    let decoded_url = urlencoding_decode_bytes(&config_b64.replace('+', " "));

    // Base64 decode — try all variants
    use base64::Engine;
    let engines: &[base64::engine::GeneralPurpose] = &[
        base64::engine::general_purpose::STANDARD,
        base64::engine::general_purpose::URL_SAFE,
        base64::engine::general_purpose::STANDARD_NO_PAD,
        base64::engine::general_purpose::URL_SAFE_NO_PAD,
    ];

    let bytes = engines
        .iter()
        .find_map(|engine| engine.decode(&decoded_url).ok())
        .ok_or_else(|| "Failed to decode base64 config".to_string())?;

    // WR-05: only return the decoded text VERBATIM as a client config when it
    // actually parses as a TrustTunnel client config (a non-empty top-level
    // `[endpoint]` table). The old substring sniff (contains "hostname" /
    // "[endpoint]" / "username") shipped ANY base64 blob whose decoded text
    // merely mentioned those words — on the UNTRUSTED deeplink path. This
    // tightens the boundary to a structured shape check (the same discriminator
    // `save_client_config` and `import_config_from_string` use).
    if let Ok(text) = String::from_utf8(bytes.clone()) {
        if is_trusttunnel_client_config(&text) {
            return Ok(text);
        }
    }

    // Last resort: try to decode base64 payload as binary deeplink
    // Reconstruct a tt://? URI so the upstream parser can handle it
    let re_encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes);
    let synthetic_uri = format!("tt://?{re_encoded}");
    if let Ok(config) = trusttunnel_deeplink::decode(&synthetic_uri) {
        let endpoint = endpoint_from_deeplink_config(config)
            .map_err(|e| format!("Failed to convert deeplink config: {e}"))?;
        let endpoint_toml =
            toml::to_string(&endpoint).map_err(|e| format!("Failed to serialize endpoint: {e}"))?;
        return Ok(crate::ssh::build_client_config(&endpoint_toml, "Imported from deeplink"));
    }

    Err("Could not parse deeplink: unrecognized format".into())
}

/// Shared shape-check (WR-05 + WR-06): is `content` a TrustTunnel client config?
///
/// A legitimate client config — whether produced by `build_client_config`
/// (ssh/mod.rs) or a hand-exported `trusttunnel_client.toml` — always carries a
/// non-empty top-level `[endpoint]` table. We require exactly that: the content
/// must parse as TOML AND expose a non-empty `endpoint` table. This is the SAME
/// discriminator `save_client_config` enforces (config.rs), so it never rejects
/// a config the app itself would write. Used on BOTH untrusted import paths
/// (the deeplink base64 fallback and the clipboard `import_config_from_string`)
/// so the trust boundary is hardened in one place.
fn is_trusttunnel_client_config(content: &str) -> bool {
    let Ok(value) = toml::from_str::<toml::Value>(content) else {
        return false;
    };
    value
        .get("endpoint")
        .and_then(|e| e.as_table())
        .is_some_and(|t| !t.is_empty())
}

/// Read the raw text of a user-picked config file so the frontend «Из файла» tile can route
/// it through `import_config_from_string` (the unique-filename + manifest-append +
/// host+user-dedup path). The OS file picker (`tauri-plugin-dialog::open`) is the trusted
/// boundary — the user explicitly chose the path — so the SOURCE is intentionally NOT
/// constrained to the data dir (mirrors `copy_config_to_app_dir`, which also reads an
/// arbitrary picked source). It only READS; the write goes through the validated import path.
/// D-29: returns the content to the caller for the import round-trip but never LOGS it.
#[tauri::command]
pub async fn read_config_file_for_import(path: String) -> Result<String, String> {
    // WR-04: a registered Tauri command is callable from ANY frontend JS, not only the
    // file-picker flow — the OS picker is a UI convention, not an enforced trust boundary.
    // Without constraints this is an arbitrary-host-filesystem read primitive over IPC
    // (`read_config_file_for_import({path: "C:/Users/.../secret.txt"})` returns the bytes).
    // The import only ever needs `.toml` content, so constrain the read defensively even
    // though the source is user-picked: require a `.toml` extension and cap the size (configs
    // are tiny; 64 KiB matches the existing TOML-content validators). This does not replace
    // the picker — it shrinks the blast radius of the registered command.
    // IN-05: classify via the shared extension helper so this picker door and the drag-drop
    // door (import_dropped_content) parse extensions identically. `Path::extension` reads the
    // last path segment's extension, so a directory in the path containing a `.` does not skew it.
    if crate::commands::paths::lowercase_extension(&path) != "toml" {
        return Err("Only .toml config files can be imported".into());
    }
    let meta = std::fs::metadata(&path).map_err(|e| format!("Failed to read file: {e}"))?;
    if meta.len() > 64 * 1024 {
        return Err("Config file too large (max 64 KiB)".into());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read file: {e}"))
}

/// Import a config string (TOML content) and ADD it to the app data directory.
///
/// HEADLINE FIX (T-11-08 / Pitfall 2): this used to write the FIXED
/// `trusttunnel_client.toml`, so a SECOND import silently OVERWROTE the first =
/// data loss. It now allocates a UNIQUE filename (branded from the config's name/user
/// via the manifest helper, falling back to `config-<n>.toml`) and APPENDS a manifest
/// entry — two imports => two files + two manifest entries.
///
/// Duplicate handling (D-13, simplified IN-36): the duplicate key is (endpoint host, username)
/// — the connection identity, NOT whole-file equality. A host+user collision AUTO-adds the
/// incoming config as a COPY «<base> (копия N)» (NO modal prompt, NO replace); a fresh config is
/// added normally. A re-import / drop NEVER overwrites an existing config (a copy is recoverable,
/// an overwrite is not).
///
/// deeplink-never-auto is unchanged: decode happens only on the explicit user click that
/// produced `content`; this command never auto-connects. Returns the destination file path.
#[tauri::command]
pub async fn import_config_from_string(
    content: String,
    source: String,
    // The source file's ORIGINAL filename (drag-drop / «Из файла»), so the stored config keeps
    // its branded «[<CC>_]TrustTunnel_<login>.toml» name verbatim instead of a content-derived
    // one (the country-code prefix lives only in the filename). `None` for clipboard/deeplink
    // (no filename) → fall back to the content-derived branded stem (unchanged behaviour).
    original_file_name: Option<String>,
    // Phase 19 UAT: best-effort country code so a content-derived import (link/clipboard, which has NO
    // source filename) gets the UNIFIED «[<CC>_]TrustTunnel_<login>.toml» name every other add-path
    // uses. Usually `None` from the FE → the backend derives it via GeoIP of the endpoint IP below.
    country_code: Option<String>,
) -> Result<String, String> {
    // WR-06: parsing as TOML is NOT enough — the clipboard import path is
    // UNTRUSTED, and any valid-TOML paste would otherwise be written verbatim as
    // the active config and then fail opaquely at connect time. Require the same
    // client-config shape (a non-empty `[endpoint]` table) the deeplink fallback
    // (WR-05) and `save_client_config` require, via the shared helper.
    if !is_trusttunnel_client_config(&content) {
        return Err("Config is missing the [endpoint] section".into());
    }

    let config_dir = portable_data_dir();
    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {e}"))?;

    use crate::commands::manifest;

    // Phase 19 UAT: unify the imported .toml filename with «[<CC>_]TrustTunnel_<login>». Only the
    // content-derived path (no source filename) lacked the country prefix. Derive it BEST-EFFORT via
    // GeoIP of the endpoint's REAL IP (addresses[0]) — the same source deploy/Users feed into the
    // branded name — OUTSIDE the manifest lock. A provided country_code wins; a source filename or a
    // GeoIP failure → None → unchanged behaviour. D-29: only the endpoint host is sent to GeoIP.
    let country: Option<String> = match (&country_code, &original_file_name) {
        (Some(c), _) => Some(c.clone()),
        (None, None) => match manifest::geoip_host_from_content(&content) {
            Some(host) => crate::commands::geoip::get_server_geoip(host)
                .await
                .ok()
                .map(|g| g.country_code)
                .filter(|c| !c.is_empty()),
            None => None,
        },
        _ => None, // a source filename is used verbatim (already branded) — no GeoIP needed
    };

    // PP-2 (16-PERF-AUDIT §m-2): run the ENTIRE import — ghost-prune → duplicate decision →
    // unique-name allocation → atomic `.toml` write → manifest append — under ONE hold of
    // MANIFEST_LOCK inside `import_config_under_lock`. The pre-PP-2 path made the duplicate DECISION
    // outside any lock (find_duplicate released the lock before the write), so two near-simultaneous
    // imports of the same (host, user) could both write an ORIGINAL — two non-copy twins. The single
    // held lock closes that TOCTOU window: the second caller checks only after the first's write is
    // committed, so it lands as a «(копия)». D-13 «add as copy» + atomic write (PP-1) preserved.
    let (dest_str, was_copy) =
        manifest::import_config_under_lock(&config_dir, &content, original_file_name.as_deref(), country.as_deref())?;

    // D-29: log ONLY the source label + destination path — NEVER `content` (it carries the user's
    // host/username/secret). The copy-vs-original distinction is neutral metadata, safe to log.
    if was_copy {
        eprintln!("[deeplink] Config copy imported from {source}: {dest_str}");
    } else {
        eprintln!("[deeplink] Config imported from {source}: {dest_str}");
    }

    Ok(dest_str)
}

/// Percent-decode `input` into a raw byte buffer (CR-01).
///
/// Operates entirely on bytes: a valid `%XX` escape pushes the decoded byte
/// verbatim (including high bytes >= 0x80, which the old String-based decoder
/// corrupted via `byte as char`). An invalid/short `%` escape is preserved
/// literally. This is the correct primitive for a base64 payload, which is
/// binary text — not a Unicode string.
///
/// Lives here, above the `#[cfg(test)]` seam and `mod tests`, rather than at the
/// bottom of the file: production items after the test module are invisible in the
/// module outline and easy to mistake for test scaffolding.
fn urlencoding_decode_bytes(input: &str) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

/// PP-2 test seam: the single-lock import helper the `wave0_pp2` RED test drives. Delegates to
/// `manifest::import_config_under_lock` (the whole check→write→append under one MANIFEST_LOCK hold)
/// with no source filename, so two racing imports of the same (host, user) yield one original + one
/// copy — never two originals. Kept thin so production and the test exercise the SAME critical
/// section.
#[cfg(test)]
fn import_under_lock(dir: &std::path::Path, content: &str) -> Result<(String, bool), String> {
    crate::commands::manifest::import_config_under_lock(dir, content, None, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    // C-22 / D-14 regression guard: the incoming tt:// URL is UNTRUSTED external
    // input. `decode_deeplink` is the trusted validation boundary — a URL that is
    // not a trusttunnel://`/`tt:// scheme, or whose payload is unparseable, MUST be
    // rejected HERE (scheme guard at L27-33, final Err at L81), never deeper where a
    // malformed config could be written. These tests prove rejection happens at the
    // boundary so the frontend pre-fill path (which only carries the raw URL to the
    // modal) can never silently import garbage.

    #[tokio::test]
    async fn rejects_non_tt_scheme() {
        // A plain https URL is not a deep-link scheme → rejected by the scheme guard.
        let result = decode_deeplink("https://evil.example/x".into()).await;
        assert!(result.is_err(), "non-tt scheme must be rejected at decode");
    }

    #[tokio::test]
    async fn rejects_garbage_url() {
        // Not even a URL → rejected (no scheme prefix).
        let result = decode_deeplink("not-a-url".into()).await;
        assert!(result.is_err(), "garbage input must be rejected at decode");
    }

    #[tokio::test]
    async fn rejects_tt_scheme_with_unparseable_payload() {
        // Correct scheme but the payload is not valid base64/binary deeplink →
        // rejected at the final Err (L81), not written as a config.
        let result = decode_deeplink("tt://!!!not-base64!!!".into()).await;
        assert!(
            result.is_err(),
            "tt:// with an unparseable payload must be rejected at decode"
        );
    }

    // WR-04 regression: read_config_file_for_import is callable from ANY frontend JS, so
    // it must constrain the read (extension + size cap) rather than be a raw
    // arbitrary-file-read primitive over IPC.
    #[tokio::test]
    async fn read_config_for_import_rejects_non_toml_extension() {
        // A non-.toml path is rejected BEFORE any read happens (so it can never return the
        // bytes of, e.g., an arbitrary secret.txt).
        let result = read_config_file_for_import("C:/Users/x/secret.txt".into()).await;
        assert!(result.is_err(), "non-.toml path must be rejected");
        assert!(
            result.unwrap_err().contains(".toml"),
            "the rejection must cite the .toml constraint"
        );
    }

    #[tokio::test]
    async fn read_config_for_import_reads_small_toml() {
        // A real .toml under the cap reads back its content.
        let dir = std::env::temp_dir().join(format!(
            "tt_wr04_read_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("import.toml");
        std::fs::write(&p, "[endpoint]\nhostname = \"a.example.com\"\n").unwrap();
        let out = read_config_file_for_import(p.to_string_lossy().to_string())
            .await
            .expect("a small .toml reads back");
        assert!(out.contains("hostname"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn read_config_for_import_rejects_oversize_toml() {
        // A .toml over the 64 KiB cap is rejected (configs are tiny — an oversized file is
        // not a legitimate import, and we never read it fully).
        let dir = std::env::temp_dir().join(format!(
            "tt_wr04_big_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("huge.toml");
        std::fs::write(&p, "x".repeat(64 * 1024 + 1)).unwrap();
        let result = read_config_file_for_import(p.to_string_lossy().to_string()).await;
        assert!(result.is_err(), "an oversize .toml must be rejected");
        assert!(result.unwrap_err().contains("too large"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    // CR-01 regression: percent-decoding MUST operate on raw bytes. The old
    // `byte as char` reinterpreted each decoded byte as a Unicode scalar
    // (Latin-1), so any byte >= 0x80 was re-encoded as a multi-byte UTF-8
    // sequence — corrupting the payload before base64 decode. This test feeds a
    // `%XX` sequence with XX >= 0x80 and asserts the EXACT bytes come back. The
    // pre-fix `urlencoding_decode` returned a String whose `.as_bytes()` was the
    // mangled UTF-8 (0xC3 0xBF for %FF), failing this assertion.
    #[test]
    fn urlencoding_decode_bytes_preserves_high_bytes() {
        // %FF (0xFF) and %80 (0x80) are both >= 0x80 — the exact bytes that the
        // old char-based decoder corrupted.
        let out = urlencoding_decode_bytes("%FF%80%41");
        assert_eq!(out, vec![0xFF_u8, 0x80_u8, 0x41_u8]);
    }

    #[test]
    fn urlencoding_decode_bytes_passes_through_plain_ascii() {
        // Non-percent bytes pass through untouched; an invalid `%` escape is kept
        // verbatim (no panic, no swallow).
        let out = urlencoding_decode_bytes("ab%2Fcd%zz");
        assert_eq!(out, b"ab/cd%zz".to_vec());
    }

    // WR-05 / WR-06 shared shape-check: the discriminator must REJECT random
    // valid TOML (the over-broad substring sniff accepted anything mentioning
    // "username"/"hostname") and ACCEPT a real-shaped client config.
    #[test]
    fn shape_check_rejects_random_valid_toml() {
        // Valid TOML, but NOT a client config — no [endpoint] table. The old
        // substring sniff would have accepted this because it mentions "username".
        let blob = "title = \"hello\"\nusername = \"someone\"\n[server]\nport = 8080\n";
        assert!(toml::from_str::<toml::Value>(blob).is_ok(), "fixture must be valid TOML");
        assert!(
            !is_trusttunnel_client_config(blob),
            "random valid TOML mentioning 'username' must be rejected"
        );
    }

    #[test]
    fn shape_check_rejects_empty_endpoint_table() {
        // An [endpoint] header with no keys is not a usable config.
        let blob = "loglevel = \"info\"\n[endpoint]\n";
        assert!(!is_trusttunnel_client_config(blob), "empty [endpoint] must be rejected");
    }

    #[test]
    fn shape_check_rejects_non_toml() {
        assert!(!is_trusttunnel_client_config("not = = toml ]["), "garbage must be rejected");
    }

    #[test]
    fn shape_check_accepts_real_client_config() {
        // The exact shape build_client_config (ssh/mod.rs) produces: a non-empty
        // top-level [endpoint] table. This MUST be accepted so a legitimate
        // imported config is never wrongly rejected.
        let config = crate::ssh::build_client_config(
            "host = \"1.2.3.4\"\nport = 443\nusername = \"alice\"\npassword = \"secret\"\n",
            "test",
        );
        assert!(
            is_trusttunnel_client_config(&config),
            "a real build_client_config output must be accepted"
        );
    }

    // WR-06: the clipboard import command must reject any valid TOML that is not
    // a client config (was: accepted ANY valid TOML and wrote it verbatim).
    #[tokio::test]
    async fn import_rejects_valid_toml_without_endpoint() {
        let blob = "title = \"random\"\n[whatever]\nx = 1\n".to_string();
        let result = import_config_from_string(blob, "clipboard-toml".into(), None, None).await;
        assert!(
            result.is_err(),
            "valid TOML without an [endpoint] table must be rejected at import"
        );
    }

    // ─── T-11-08: import ADDS, never overwrites (Pitfall 2) ──────────────────
    //
    // The headline data-loss fix. `import_config_from_string` is hardwired to
    // `portable_data_dir()`, so these tests exercise the SAME unique-filename +
    // manifest-append + host+user-dup logic through the manifest helpers (which take an
    // explicit dir) over a tempdir — proving the behaviour without writing into the real
    // app data dir during a unit run.

    use crate::commands::manifest;

    fn sample(content_name: &str, host: &str, user: &str, password: &str) -> String {
        // The exact shape build_client_config produces — a non-empty [endpoint] table.
        crate::ssh::build_client_config(
            &format!(
                "hostname = \"{host}\"\nusername = \"{user}\"\npassword = \"{password}\"\n"
            ),
            content_name,
        )
        // Inject a top-level `name` so the import stem is branded (mirrors a real config).
        .replace(
            "loglevel = \"info\"",
            &format!("name = \"{content_name}\"\nloglevel = \"info\""),
        )
    }

    fn tmpdir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "tt_deeplink_import_{}_{}",
            std::process::id(),
            DL_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    static DL_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

    /// HEADLINE (T-11-08): two distinct imports produce two distinct files on disk + two
    /// manifest entries — the fixed-`trusttunnel_client.toml` overwrite bug is gone.
    #[test]
    fn import_appends_not_overwrites() {
        let dir = tmpdir();
        let a = sample("Germany", "de.example.com", "user-a", "SECRET-A");
        let b = sample("Netherlands", "nl.example.com", "user-b", "SECRET-B");

        // First import: no dup → unique file + append.
        let stem_a = manifest::import_stem_from_content(&a, None);
        let dest_a = manifest::unique_import_path(&dir, &stem_a);
        std::fs::write(&dest_a, &a).unwrap();
        manifest::append_config_to_manifest(&dir, &dest_a.to_string_lossy()).unwrap();

        // Second import: a DIFFERENT host+user → unique file + append (no overwrite).
        let stem_b = manifest::import_stem_from_content(&b, None);
        let dest_b = manifest::unique_import_path(&dir, &stem_b);
        std::fs::write(&dest_b, &b).unwrap();
        manifest::append_config_to_manifest(&dir, &dest_b.to_string_lossy()).unwrap();

        assert_ne!(dest_a, dest_b, "two imports must write two DISTINCT files");
        assert!(dest_a.is_file() && dest_b.is_file(), "both files on disk");

        let m = manifest::read_manifest(&dir).unwrap();
        assert_eq!(m.configs.len(), 2, "two imports => two manifest entries");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// D-13: a host+user collision is detected from the already-imported config so the
    /// modal can offer replace/add-copy — the dup helper finds the first match.
    #[test]
    fn dup_key_host_user() {
        let dir = tmpdir();
        let first = sample("First", "dup.example.com", "same-user", "SECRET-1");

        let stem = manifest::import_stem_from_content(&first, None);
        let dest = manifest::unique_import_path(&dir, &stem);
        std::fs::write(&dest, &first).unwrap();
        manifest::append_config_to_manifest(&dir, &dest.to_string_lossy()).unwrap();

        // A SECOND config with the same (host, user) is a duplicate.
        let incoming = sample("Second", "dup.example.com", "same-user", "SECRET-2");
        let (host, user) = manifest::host_user_from_content(&incoming);
        assert_eq!((host.as_str(), user.as_str()), ("dup.example.com", "same-user"));
        let found = manifest::find_duplicate_by_host_user(&dir, &host, &user);
        assert!(found.is_some(), "host+user collision must be detectable");

        // A DIFFERENT host is NOT a duplicate.
        let other = sample("Other", "other.example.com", "same-user", "X");
        let (oh, ou) = manifest::host_user_from_content(&other);
        assert!(
            manifest::find_duplicate_by_host_user(&dir, &oh, &ou).is_none(),
            "a different host must NOT be a duplicate"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// D-29: the import path logs ONLY the source label + destination path, never the
    /// content/password. This is a static guard — the source of import_config_from_string
    /// must not pass `content`/`password` to any log macro. Asserted by reading this file's
    /// own source at test time so a future edit that adds a leaking log line fails here.
    #[test]
    fn import_log_discipline_d29() {
        let src = include_str!("deeplink.rs");
        // Every eprintln! on the import route must reference only `source`/path tokens.
        for line in src.lines() {
            let l = line.trim();
            if l.starts_with("eprintln!") && (l.contains("[deeplink]")) {
                assert!(
                    !l.contains("{content}") && !l.contains("password"),
                    "D-29: a [deeplink] log line must never include content/password: {l}"
                );
            }
        }
    }

    // ─── Phase 17 (17-03) — PP-2 import TOCTOU single-lock (GREEN) ──────────────────────────
    //
    // Landed by 17-03: 17-01 wrote this as `wave0_red`-gated RED (the single-lock helper
    // `import_under_lock` did not exist yet); 17-03 added it — the whole dup-check + write +
    // manifest-append run under ONE MANIFEST_LOCK hold (`manifest::import_config_under_lock`) — and
    // DELETED the gate so it runs under default `cargo test --lib` and passes.
    //
    // PP-2 defect (16-PERF-AUDIT §m-2): the pre-fix dup check (`find_duplicate_by_host_user`) and
    // the write were separate lock-takes, so two near-simultaneous imports of the SAME (host, user)
    // both read «no duplicate» and each wrote an ORIGINAL — two originals instead of one original +
    // one «(копия)». The single-lock helper serializes check+write: the second import observes the
    // first's committed write and lands as a copy.

    /// GREEN (17-03): two sequential-but-racing imports of the same (host, user) under the
    /// single-lock helper yield exactly ONE original + ONE copy — never two originals.
    #[test]
    fn wave0_pp2_concurrent_dup_import_yields_one_original_one_copy() {
        let dir = tmpdir();
        let host = "race.example.com";
        let user = "same-user";
        let first = sample("First", host, user, "SECRET-1");
        let second = sample("Second", host, user, "SECRET-2");

        // Both imports go through the SAME single-lock helper. The second, seeing the first's
        // committed write, must land as a copy — not a second original.
        import_under_lock(&dir, &first).unwrap();
        import_under_lock(&dir, &second).unwrap();

        let m = manifest::read_manifest(&dir).unwrap();
        assert_eq!(
            m.configs.len(),
            2,
            "a dup import must add a copy, not overwrite — two manifest entries total"
        );
        // Exactly one entry keeps the plain «First» base (the original); the other is a
        // «(копия …)» — NOT two originals.
        let copies = m
            .configs
            .iter()
            .filter(|c| c.name.contains("копия"))
            .count();
        assert_eq!(
            copies, 1,
            "exactly one of the two must be a copy (one original + one copy, never two originals)"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
