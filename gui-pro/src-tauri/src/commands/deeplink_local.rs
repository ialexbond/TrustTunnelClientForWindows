//! Local (non-SSH) deeplink export — Phase 15 «QR config transfer».
//!
//! This is the LOCAL twin of the Control-Panel SSH export path
//! (`server_export_config_deeplink[_advanced]`). Instead of SSHing into the
//! server and asking its CLI for a `tt://` link, we read a stored client config
//! TOML from the app's `user_data_dir`, map its `[endpoint]` table forward
//! into a `DeepLinkConfig`, and call the compiled local encoder
//! `trusttunnel_deeplink::encode()` — no server round-trip. This lets a user
//! transfer a config to another device while offline (D-01/D-03).
//!
//! ## Invariants this module MUST uphold
//! - **D-01 — no SSH.** This is a plain `#[tauri::command]`, NOT `ssh_pool_command!`.
//!   Do NOT reference the CP path (`server_export_config_deeplink*`).
//! - **Pitfall 1 — no gap TLVs.** `encode()` alone emits a wire-identical link
//!   (it already writes the version tag + every optional field with the same
//!   omission rules the SSH `append_missing_tlvs` helper replicates). Applying
//!   `append_missing_tlvs` on top of `encode()` would DOUBLE-encode. Do NOT
//!   import `tlv_encoder`.
//! - **WR-04 — path guard.** A registered Tauri command is callable from ANY
//!   frontend JS, so `config_path` is untrusted. `validate_app_path` confines
//!   reads to `user_data_dir` (mirrors `read_client_config`).
//! - **D-29 — logging discipline.** The `tt://` link legitimately CARRIES the
//!   password (D-04); LOGGING it (or the file content) is forbidden. Any `[qr]`
//!   log line may reference only the config path / a boolean, never the
//!   link/content/password. Enforced by the source-scan spy `export_log_discipline_d29`.
//!
//! ## Status
//! 15-01 (this plan) writes the module SKELETON + the RED test suite that pins
//! the command name/signature and the forward-map contract. The function bodies
//! are deliberate `unimplemented` stubs so the behavior tests are genuinely RED;
//! 15-02 fills them in and turns B-01..B-09 green (B-10 is a guard, green from
//! the start).

use trusttunnel_settings::{trusttunnel_deeplink, Endpoint};
use trusttunnel_deeplink::{cert, DeepLinkConfig, Protocol};

/// Practical scannable ceiling for the `tt://` payload length (chars). Above
/// this the QR gets dense enough that phone cameras struggle, so an oversized
/// embedded certificate is dropped and the link is re-encoded without it (the
/// receiving sidecar falls back to its platform verifier — same graceful
/// degrade the CP flow uses with its ~2 KB cert gate). The link stays valid and
/// importable; only the pinned cert is omitted. `[15-RESEARCH §QR Capacity]`
pub const QR_LINK_BUDGET: usize = 1800;

/// Map a stored `[endpoint]` TOML struct forward into a `DeepLinkConfig` ready
/// for `encode()`. This inverts `trusttunnel_settings::endpoint_from_deeplink_config`
/// field-by-field (see the 13-field table in 15-RESEARCH §"Resolved Unknown 2").
///
/// Type reconciliations vs. the reverse map (`settings/src/lib.rs:116-139`):
/// - `client_random` / `custom_sni`: stored as `String` (`unwrap_or_default()` in
///   the reverse map), so an empty String means "absent" — map `"" → None` here so
///   `encode()` omits TLV 0x0B / 0x03. Passing `Some("")` for `custom_sni` would
///   write a stray empty-SNI TLV (encode has no empty-check there — Pitfall 2).
/// - `client_random` non-empty: hex-validate (the builder does `hex::decode` at
///   `types.rs:234-243`; we bypass the builder, so we replicate the check) — a
///   non-hex prefix would encode but fail on the RECEIVER's import, so surface it
///   as a broken-config `Err` rather than ship a silently-degraded link.
/// - `upstream_protocol`: stored as `String`; `"http3" → Http3`, everything else
///   (`""`, `"http2"`, or any legacy value) → `Http2` (the TOML default — Pitfall 3).
/// - `certificate`: PEM text → DER bytes via `cert::pem_to_der`; a malformed PEM
///   propagates as `Err` (an unusable cert should surface, not silently drop).
fn endpoint_to_deeplink_config(ep: Endpoint) -> Result<DeepLinkConfig, String> {
    // Row 9: PEM → DER. An EMPTY/whitespace-only certificate means "no pinned cert"
    // (the stored TOML default `certificate = ""` = verify via the system store), so it
    // must map to None — NOT be fed to `pem_to_der`, which would reject "" with
    // "no PEM blocks found in certificate field". This mirrors the empty→None handling
    // for custom_sni/client_random below. Only a NON-empty cert is parsed; a genuinely
    // malformed PEM still propagates as Err (an unusable pinned cert should surface).
    let certificate = ep
        .certificate
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(cert::pem_to_der)
        .transpose()
        .map_err(|e| e.to_string())?;

    // Row 10: String → Protocol enum. `""` / unknown default to Http2 (Pitfall 3).
    let upstream_protocol = match ep.upstream_protocol.as_str() {
        "http3" => Protocol::Http3,
        _ => Protocol::Http2,
    };

    // Rows 5/6: empty String → None (inverts the reverse map's `unwrap_or_default()`).
    // For `client_random`, a non-empty value must be valid hex — mirror the builder's
    // `hex::decode` guard (types.rs:234-243) so a broken prefix surfaces as an Err
    // rather than producing a link that fails on the receiver's import. We validate
    // inline (even length + all ASCII hex digits, exactly what `hex::decode` accepts)
    // to avoid pulling in the `hex` crate as a new direct dependency.
    let client_random_prefix = if ep.client_random.is_empty() {
        None
    } else {
        let s = &ep.client_random;
        let valid_hex = s.len().is_multiple_of(2) && s.bytes().all(|b| b.is_ascii_hexdigit());
        if !valid_hex {
            return Err(format!("invalid client_random hex prefix: {s}"));
        }
        Some(ep.client_random)
    };
    let custom_sni = if ep.custom_sni.is_empty() {
        None
    } else {
        Some(ep.custom_sni)
    };

    // Struct-literal form (like the reverse map at lib.rs:124-138); rows 1-4, 7, 8,
    // 11, 12, 13 are direct.
    let mut cfg = DeepLinkConfig {
        hostname: ep.hostname,
        addresses: ep.addresses,
        username: ep.username,
        password: ep.password,
        client_random_prefix,
        custom_sni,
        has_ipv6: ep.has_ipv6,
        skip_verification: ep.skip_verification,
        certificate,
        upstream_protocol,
        anti_dpi: ep.anti_dpi,
        name: ep.name,
        dns_upstreams: ep.dns_upstreams,
    };

    // Enforce the 4 required fields (hostname/addresses/username/password) before
    // encoding — a missing one errors here (B-08) instead of producing a bad link.
    cfg.validate().map_err(|e| e.to_string())?;

    // QR-budget graceful degrade (B-07): a pinned certificate is the only field
    // large enough to blow past the scannable ceiling. Encode once to MEASURE; if
    // the link would be too dense for a phone camera, drop the cert and let the
    // receiving sidecar fall back to its platform verifier (the same behaviour the
    // Control-Panel flow's `< 2048` cert gate relies on). Only the pinned cert is
    // omitted — the link stays valid and importable. `[15-RESEARCH §Resolved
    // Unknown 5]`. We measure exactly once (encode → optionally re-drop once).
    if cfg.certificate.is_some() {
        let probe = trusttunnel_deeplink::encode(&cfg).map_err(|e| e.to_string())?;
        if probe.len() > QR_LINK_BUDGET {
            cfg.certificate = None;
        }
    }

    Ok(cfg)
}

/// Read a stored client config by path and return its `tt://` deeplink, built
/// LOCALLY (no SSH — D-01). Signature is FROZEN by 15-01; 15-03 invokes this exact
/// name from `ConfigQr`.
///
/// Flow: guard the untrusted path → read the config TOML → parse ONLY the
/// `[endpoint]` table into `Endpoint` → forward-map to `DeepLinkConfig` →
/// `trusttunnel_deeplink::encode()` ALONE (NO `append_missing_tlvs` — that would
/// double-encode; Pitfall 1) → return the `tt://` string.
#[tauri::command]
pub async fn export_config_deeplink_local(config_path: String) -> Result<String, String> {
    // WR-04: a registered Tauri command is callable from ANY frontend JS, so
    // `config_path` is untrusted. Confine reads to `user_data_dir`. First line.
    crate::commands::paths::validate_app_path(&config_path)?;

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read config: {e}"))?;

    // Parse ONLY the [endpoint] table (the full client TOML also carries
    // killswitch/exclusions/etc. the encoder ignores). Typed serde parse returns
    // Err on malformed TOML — never panics (T-15-03).
    let value: toml::Value =
        toml::from_str(&content).map_err(|e| format!("Failed to parse config: {e}"))?;
    let ep_table = value
        .get("endpoint")
        .ok_or_else(|| "config missing [endpoint]".to_string())?;
    let ep: Endpoint = ep_table
        .clone()
        .try_into()
        .map_err(|e: toml::de::Error| e.to_string())?;

    let cfg = endpoint_to_deeplink_config(ep)?;

    // encode() ALONE is wire-identical to the CP/server link (it writes the version
    // tag + every optional field with the same omission rules). Do NOT layer
    // `append_missing_tlvs` (Pitfall 1). The QR-budget cert degrade already happened
    // inside `endpoint_to_deeplink_config`.
    let link = trusttunnel_deeplink::encode(&cfg).map_err(|e| e.to_string())?;

    // D-29: the link CARRIES the password (D-04); logging it (or the file content)
    // is forbidden. This log line references only the non-sensitive config path.
    eprintln!("[qr] built deeplink for {config_path}");

    Ok(link)
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Fixtures ─────────────────────────────────────────────────────────────

    /// A small, valid self-signed leaf certificate in PEM form. Used by the
    /// small-cert embed test (B-06). `pem_to_der` parses this to DER bytes.
    const SMALL_PEM: &str = "-----BEGIN CERTIFICATE-----\n\
MIIBhTCCASugAwIBAgIUJt3q8n7Q3mF3Yx6mQ3q3qQ3q3owCgYIKoZIzj0EAwIw\n\
FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI0MDEwMTAwMDAwMFoXDTM0MDEwMTAw\n\
MDAwMFowFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D\n\
AQcDQgAEExampleExampleExampleExampleExampleExampleExampleExampleEx\n\
ampleExampleExampleExampleExampleExampleQ==\n\
-----END CERTIFICATE-----\n";

    /// Build a fully-populated `Endpoint` with every field set to a NON-default
    /// value, so the field-map coverage test (B-01) proves each of the 13 fields
    /// is carried, not silently dropped. Individual tests mutate the fields they
    /// exercise (empty client_random/custom_sni, missing hostname, oversized cert).
    fn full_endpoint() -> Endpoint {
        Endpoint {
            hostname: "vpn.example.com".to_string(),
            addresses: vec!["1.2.3.4:443".to_string()],
            has_ipv6: false, // non-default (TOML default is true) → forces the 0x04 TLV
            username: "alice".to_string(),
            password: "s3cr3t".to_string(),
            client_random: "aabb".to_string(),
            skip_verification: true, // non-default → forces the 0x07 TLV
            certificate: None,
            upstream_protocol: "http3".to_string(), // non-default → forces the 0x09 TLV
            anti_dpi: true,                          // non-default → forces the 0x0A TLV
            custom_sni: "sni.example.com".to_string(),
            dns_upstreams: vec!["tls://dns.adguard-dns.com".to_string()],
            name: Some("Example VPN".to_string()),
        }
    }

    // ── B-01: forward map covers all 13 fields ───────────────────────────────
    #[test]
    fn map_covers_all_13_fields() {
        let cfg = endpoint_to_deeplink_config(full_endpoint())
            .expect("forward map must succeed for a fully-populated endpoint");

        // 1 hostname · 2 addresses · 3 username · 4 password
        assert_eq!(cfg.hostname, "vpn.example.com");
        assert_eq!(cfg.addresses, vec!["1.2.3.4:443".to_string()]);
        assert_eq!(cfg.username, "alice");
        assert_eq!(cfg.password, "s3cr3t");
        // 5 client_random (String) → client_random_prefix (Option<String>)
        assert_eq!(cfg.client_random_prefix, Some("aabb".to_string()));
        // 6 custom_sni (String) → Option<String>
        assert_eq!(cfg.custom_sni, Some("sni.example.com".to_string()));
        // 7 has_ipv6 · 8 skip_verification (both direct)
        assert!(!cfg.has_ipv6);
        assert!(cfg.skip_verification);
        // 9 certificate (None here — cert embed is B-06)
        assert!(cfg.certificate.is_none());
        // 10 upstream_protocol (String) → Protocol (enum)
        assert_eq!(cfg.upstream_protocol, Protocol::Http3);
        // 11 anti_dpi (direct)
        assert!(cfg.anti_dpi);
        // 12 dns_upstreams (direct)
        assert_eq!(cfg.dns_upstreams, vec!["tls://dns.adguard-dns.com".to_string()]);
        // 13 name (direct)
        assert_eq!(cfg.name, Some("Example VPN".to_string()));
    }

    // ── B-02: empty client_random / custom_sni → None (TLV omitted) ──────────
    #[test]
    fn empty_client_random_and_sni_omit_tlv() {
        let mut ep = full_endpoint();
        ep.client_random = String::new();
        ep.custom_sni = String::new();

        let cfg = endpoint_to_deeplink_config(ep)
            .expect("forward map must succeed with empty client_random/custom_sni");

        // Empty string inverts to None so the encoder omits TLV 0x0B / 0x03.
        assert_eq!(cfg.client_random_prefix, None);
        assert_eq!(cfg.custom_sni, None);

        // And the round-trip through the wire yields an endpoint with those absent.
        let link = trusttunnel_deeplink::encode(&cfg).expect("encode");
        let decoded = trusttunnel_deeplink::decode(&link).expect("decode");
        assert_eq!(decoded.client_random_prefix, None);
        assert_eq!(decoded.custom_sni, None);
    }

    // ── B-03: upstream_protocol defaults ─────────────────────────────────────
    #[test]
    fn protocol_defaults() {
        let mut ep = full_endpoint();

        ep.upstream_protocol = String::new(); // "" → Http2 (TOML default)
        assert_eq!(
            endpoint_to_deeplink_config(ep).expect("map").upstream_protocol,
            Protocol::Http2,
            "empty upstream_protocol must default to Http2"
        );

        let mut ep = full_endpoint();
        ep.upstream_protocol = "http2".to_string();
        assert_eq!(
            endpoint_to_deeplink_config(ep).expect("map").upstream_protocol,
            Protocol::Http2
        );

        let mut ep = full_endpoint();
        ep.upstream_protocol = "http3".to_string();
        assert_eq!(
            endpoint_to_deeplink_config(ep).expect("map").upstream_protocol,
            Protocol::Http3
        );
    }

    // ── B-04: wire round-trip (encode → decode → reverse map) ────────────────
    #[test]
    fn wire_round_trip() {
        // Mirror settings/src/lib.rs:207-231. Use a config WITHOUT the non-default
        // has_ipv6/skip toggles so the reverse-map comparison is clean on the
        // identity fields we assert (host/user/password/name/dns).
        let mut ep = full_endpoint();
        ep.has_ipv6 = true;
        ep.skip_verification = false;
        ep.anti_dpi = false;
        ep.upstream_protocol = "http2".to_string();

        let cfg = endpoint_to_deeplink_config(ep).expect("forward map");
        let link = trusttunnel_deeplink::encode(&cfg).expect("encode");
        let ep2 = trusttunnel_settings::endpoint_from_deeplink_config(
            trusttunnel_deeplink::decode(&link).expect("decode"),
        )
        .expect("reverse map");

        assert_eq!(ep2.hostname, "vpn.example.com");
        assert_eq!(ep2.username, "alice");
        assert_eq!(ep2.password, "s3cr3t");
        assert_eq!(ep2.name, Some("Example VPN".to_string()));
        assert_eq!(ep2.dns_upstreams, vec!["tls://dns.adguard-dns.com".to_string()]);
        assert_eq!(ep2.addresses, vec!["1.2.3.4:443".to_string()]);
    }

    // ── B-05: link round-trips through the app importer (decode_deeplink) ─────
    #[tokio::test]
    async fn importer_round_trip() {
        let cfg = endpoint_to_deeplink_config(full_endpoint()).expect("forward map");
        let link = trusttunnel_deeplink::encode(&cfg).expect("encode");

        // Feed the encode() link to the app's own importer. It must produce a full
        // client config TOML carrying a non-empty [endpoint] table.
        let toml_out = crate::commands::deeplink::decode_deeplink(link)
            .await
            .expect("decode_deeplink must accept an encode() link");

        let value: toml::Value =
            toml::from_str(&toml_out).expect("importer output must be valid TOML");
        let endpoint = value
            .get("endpoint")
            .and_then(|e| e.as_table())
            .expect("importer output must contain an [endpoint] table");
        assert!(
            !endpoint.is_empty(),
            "the [endpoint] table must be non-empty (is_trusttunnel_client_config)"
        );
    }

    // ── B-06: small cert PEM embeds as DER ───────────────────────────────────
    #[test]
    fn small_cert_embeds_der() {
        let mut ep = full_endpoint();
        ep.certificate = Some(SMALL_PEM.to_string());

        let cfg = endpoint_to_deeplink_config(ep).expect("forward map with a small cert");
        let expected_der = cert::pem_to_der(SMALL_PEM).expect("pem_to_der");

        assert_eq!(
            cfg.certificate,
            Some(expected_der),
            "a small cert must embed as its DER bytes (via pem_to_der)"
        );
    }

    // ── B-06b (regression): EMPTY-STRING certificate → None, not a PEM parse error ──
    // Real stored configs carry `certificate = ""` (present but empty = no pinned cert,
    // verified via the system store). TOML deserializes that to Some("") on the Endpoint,
    // NOT None. Before the empty→None filter, Some("") was fed to `pem_to_der`, which
    // rejected "" with "no PEM blocks found in certificate field" — so the QR modal errored
    // for every config without a pinned cert (owner-reported on «admen (копия 2)»). This
    // pins that an empty (and whitespace-only) cert maps to None and still yields a link.
    #[test]
    fn empty_certificate_maps_to_none_not_pem_error() {
        for blank in ["", "   ", "\n\t "] {
            let mut ep = full_endpoint();
            ep.certificate = Some(blank.to_string());

            let cfg = endpoint_to_deeplink_config(ep)
                .unwrap_or_else(|e| panic!("empty cert ({blank:?}) must not error, got: {e}"));
            assert!(
                cfg.certificate.is_none(),
                "an empty/whitespace certificate ({blank:?}) must map to None (no pinned cert)"
            );
            let link = trusttunnel_deeplink::encode(&cfg).expect("encode with no cert");
            assert!(link.starts_with("tt://"), "must still produce a tt:// link");
        }
    }

    // ── B-07: oversized cert dropped so the link stays under QR budget ───────
    #[test]
    fn large_cert_stays_under_budget() {
        // Build an oversized PEM by concatenating many copies of the small cert
        // (a chain) so the embedded DER would blow past the QR budget.
        let big_pem = SMALL_PEM.repeat(40);
        let mut ep = full_endpoint();
        ep.certificate = Some(big_pem);

        let cfg = endpoint_to_deeplink_config(ep).expect("forward map with an oversized cert");
        // 15-02's degrade drops the cert when the encoded link would exceed
        // QR_LINK_BUDGET, so the produced config must NOT carry the oversized cert.
        assert!(
            cfg.certificate.is_none(),
            "an oversized cert must be dropped so the link stays scannable"
        );

        let link = trusttunnel_deeplink::encode(&cfg).expect("encode after degrade");
        assert!(
            link.len() < QR_LINK_BUDGET,
            "the degraded link ({} chars) must stay under the QR budget ({})",
            link.len(),
            QR_LINK_BUDGET
        );
        // And the degraded link is still importable.
        assert!(
            trusttunnel_deeplink::decode(&link).is_ok(),
            "the cert-dropped link must still decode"
        );
    }

    // ── B-08: missing required field → Err, never panic ──────────────────────
    #[test]
    fn missing_hostname_errors() {
        let mut ep = full_endpoint();
        ep.hostname = String::new();

        let err = endpoint_to_deeplink_config(ep)
            .expect_err("an empty hostname must return Err (validate()), not a mapped config");
        // Assert the SPECIFIC validate() rejection, not just any Err — otherwise the
        // 15-01 `unimplemented` stub (which also returns Err) would false-green this.
        // `DeepLinkConfig::validate()` errors on an empty hostname with
        // «Missing required field: hostname» (deeplink error.rs). 15-02 calls
        // `cfg.validate()` in the forward map, turning this genuinely GREEN.
        assert!(
            err.contains("hostname"),
            "the error must name the missing hostname field, got: {err}"
        );
    }

    // ── B-09: path outside user_data_dir rejected (WR-04) ────────────────
    #[tokio::test]
    async fn path_outside_data_dir_rejected() {
        // An absolute path outside the app data dir must be rejected by the
        // validate_app_path guard the command applies to its untrusted arg.
        let result =
            export_config_deeplink_local("C:/Users/x/secret.txt".to_string()).await;
        let err = result.expect_err(
            "a path outside user_data_dir must be rejected (validate_app_path)",
        );
        // Assert the SPECIFIC path-guard rejection, not just any Err — otherwise the
        // 15-01 `unimplemented` stub (which also returns Err) would false-green this.
        // 15-02 wires `validate_app_path` as the command's first line, whose message
        // is «...outside the application data directory» (paths.rs:49). This keeps
        // B-09 genuinely RED until the guard exists.
        assert!(
            err.contains("outside the application data directory"),
            "the rejection must come from validate_app_path, got: {err}"
        );
    }

    // ── B-10: D-29 log discipline (source-scan spy) ──────────────────────────
    //
    // Mirror `import_log_discipline_d29` (deeplink.rs:501-514) retargeted at THIS
    // file. The tt:// link carries the password by design (D-04) — logging it (or
    // the file content) is forbidden. This reads the module source at test time so
    // a future edit that adds a leaking `[qr]` log line fails HERE. It is a GUARD:
    // green from the start (the stub has no leaking log line) and must stay green
    // through 15-02.
    #[test]
    fn export_log_discipline_d29() {
        let src = include_str!("deeplink_local.rs");
        for line in src.lines() {
            let l = line.trim();
            if l.starts_with("eprintln!") && l.contains("[qr]") {
                assert!(
                    !l.contains("{content}") && !l.contains("{link}") && !l.contains("password"),
                    "D-29: a [qr] log line must never include content/link/password: {l}"
                );
            }
        }
    }
}
