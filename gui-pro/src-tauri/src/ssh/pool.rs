use std::sync::Arc;
use std::time::Duration;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use tokio::sync::Mutex as TokioMutex;
use russh::client;
use super::{SshHandler, SshParams, ssh_connect, open_session_with_retry};

struct CachedSsh {
    key: String,
    handle: Arc<client::Handle<SshHandler>>,
}

/// One-way, NON-secret digest of the auth-determining material (WR-02 / D-11).
///
/// The pool cache key was `host:port:ssh_user` only, so a changed
/// password / key / auth method on the SAME host:port:user would silently
/// reuse a connection opened with the OLD credential. Folding this fingerprint
/// into the key means any credential change produces a DIFFERENT key, forcing a
/// fresh connection — the stale-credential socket is never handed back.
///
/// It digests the password (and key material), so it is effectively a secret
/// derivative: D-29 forbids it from ever reaching a log sink. There is no
/// `eprintln!` / `println!` / `emit_log` of `key` or this fingerprint anywhere
/// in this module, and a static-grep test below enforces that invariant.
///
/// `DefaultHasher` is intentional: this is a cache DISCRIMINATOR, not a security
/// primitive. Collision resistance against an attacker is irrelevant — we only
/// need "different credential ⇒ different string". No new crate is pulled in.
fn auth_fingerprint(params: &SshParams) -> String {
    let mut h = DefaultHasher::new();
    // Hash each field with its own write so e.g. ("a", "bc") and ("ab", "c")
    // do not collide — the per-field Hash impl length-prefixes the bytes.
    params.auth_method.as_deref().unwrap_or("").hash(&mut h);
    params.ssh_password.hash(&mut h);
    params.key_path.as_deref().unwrap_or("").hash(&mut h);
    params.key_data.as_deref().unwrap_or("").hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Single-slot SSH connection pool for server management commands.
///
/// Reuses one persistent SSH connection per server, eliminating 200-500ms
/// TCP+auth overhead per request. Keepalive packets prevent SSH timeout.
pub struct SshPool {
    inner: Arc<TokioMutex<Option<CachedSsh>>>,
}

impl Default for SshPool {
    fn default() -> Self {
        Self::new()
    }
}

impl SshPool {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(TokioMutex::new(None)),
        }
    }

    /// Get or create a connection for the given SSH params.
    /// Reuses existing connection if same server and still alive.
    /// Disconnects old connection when switching to a different server.
    pub async fn acquire(&self, params: &SshParams, app: Option<tauri::AppHandle>) -> Result<Arc<client::Handle<SshHandler>>, String> {
        // WR-02 / D-11: append a non-secret auth digest. A changed credential on
        // the same host:port:user yields a new key → a fresh connection, never
        // reuse of the old-credential pooled socket. The fingerprint MUST NEVER
        // be logged (it digests the password — D-29); do not add any print of `key`.
        let key = format!("{}:{}:{}:{}", params.host, params.port, params.ssh_user, auth_fingerprint(params));
        let mut guard = self.inner.lock().await;

        // Reuse if same server and connection is alive
        if let Some(ref cached) = *guard {
            if cached.key == key && !cached.handle.is_closed() {
                return Ok(Arc::clone(&cached.handle));
            }
            // Different server or dead connection — disconnect old
            let old = guard.take().unwrap();
            old.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
        }

        // Create new connection
        let handle = ssh_connect(
            &params.host,
            params.port,
            &params.ssh_user,
            &params.ssh_password,
            params.key_path.as_deref(),
            params.key_data.as_deref(),
            params.auth_method.as_deref(),
            app,
        ).await?;

        let arc = Arc::new(handle);
        Self::spawn_keepalive(Arc::clone(&arc));

        *guard = Some(CachedSsh {
            key,
            handle: Arc::clone(&arc),
        });

        Ok(arc)
    }

    /// Disconnect and clear the cached connection.
    pub async fn invalidate(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(cached) = guard.take() {
            cached.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await.ok();
        }
    }

    /// Spawn a background task that keeps the connection alive every 60s.
    /// Opens a lightweight SSH channel as a heartbeat probe.
    /// Self-terminates when the handle is closed or probe fails.
    fn spawn_keepalive(handle: Arc<client::Handle<SshHandler>>) {
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
                if handle.is_closed() {
                    break;
                }
                // Open a session channel as keepalive probe, then drop it.
                // Use the retry helper so a single transient ChannelOpenFailure
                // (e.g. from a concurrent panel-mount storm) does not kill the
                // keepalive loop and force a full reconnect on the next command.
                match open_session_with_retry(&handle).await {
                    Ok(channel) => { channel.close().await.ok(); }
                    Err(_) => break,
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build SshParams with the given auth-determining fields. host/port/user are
    /// fixed so tests isolate the auth component of the cache key.
    fn params(
        password: &str,
        auth_method: Option<&str>,
        key_path: Option<&str>,
        key_data: Option<&str>,
    ) -> SshParams {
        SshParams {
            host: "10.0.0.1".into(),
            port: 22,
            ssh_user: "root".into(),
            ssh_password: password.into(),
            key_path: key_path.map(str::to_string),
            key_data: key_data.map(str::to_string),
            auth_method: auth_method.map(str::to_string),
        }
    }

    fn cache_key(p: &SshParams) -> String {
        // Mirror the construction in `acquire` so the test exercises the real key shape.
        format!("{}:{}:{}:{}", p.host, p.port, p.ssh_user, auth_fingerprint(p))
    }

    #[test]
    fn fingerprint_changes_when_password_changes() {
        let a = auth_fingerprint(&params("old-pass", None, None, None));
        let b = auth_fingerprint(&params("new-pass", None, None, None));
        assert_ne!(a, b, "a changed password must yield a different fingerprint");
    }

    #[test]
    fn fingerprint_changes_when_auth_method_changes() {
        let a = auth_fingerprint(&params("p", Some("password"), None, None));
        let b = auth_fingerprint(&params("p", Some("key"), None, None));
        assert_ne!(a, b, "a changed auth method must yield a different fingerprint");
    }

    #[test]
    fn fingerprint_changes_when_key_path_or_key_data_changes() {
        let base = auth_fingerprint(&params("p", Some("key"), None, None));
        let path_changed = auth_fingerprint(&params("p", Some("key"), Some("/keys/id_ed25519"), None));
        let data_changed = auth_fingerprint(&params("p", Some("key"), None, Some("-----BEGIN OPENSSH PRIVATE KEY-----")));
        assert_ne!(base, path_changed, "a changed key_path must yield a different fingerprint");
        assert_ne!(base, data_changed, "a changed key_data must yield a different fingerprint");
        assert_ne!(path_changed, data_changed, "key_path vs key_data must not collide");
    }

    #[test]
    fn fingerprint_is_stable_for_identical_auth() {
        let a = auth_fingerprint(&params("same", Some("key"), Some("/k"), Some("data")));
        let b = auth_fingerprint(&params("same", Some("key"), Some("/k"), Some("data")));
        assert_eq!(a, b, "identical auth material must be deterministic");
    }

    #[test]
    fn cache_key_differs_for_same_host_port_user_but_different_password() {
        // WR-02 core invariant: same server identity, changed credential ⇒ no stale reuse.
        let a = cache_key(&params("old-pass", Some("password"), None, None));
        let b = cache_key(&params("new-pass", Some("password"), None, None));
        assert_ne!(a, b, "changed password on same host:port:user must produce a different cache key");
    }

    #[test]
    fn d29_fingerprint_does_not_contain_cleartext_secret() {
        // The fingerprint is a hex digest, so it can never embed the cleartext.
        let secret = "S3cr3t-P@ssw0rd-Recognizable";
        let pem = "-----BEGIN OPENSSH PRIVATE KEY-----recognizable-body";
        let fp = auth_fingerprint(&params(secret, Some("key"), Some("/keys/id"), Some(pem)));
        assert!(!fp.contains(secret), "fingerprint must not leak the cleartext password");
        assert!(!fp.contains(pem), "fingerprint must not leak the cleartext key material");
        // It is purely lowercase hex of fixed width.
        assert_eq!(fp.len(), 16, "DefaultHasher digest is rendered as 16 hex chars");
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()), "fingerprint must be hex only");
    }

    #[test]
    fn d29_no_log_sink_references_key_or_fingerprint() {
        // Static-grep over the module BODY (comments + tests stripped): no log sink
        // (`emit_log` / `eprintln!` / `println!` / `tracing`) may reference the
        // `key` cache identifier or the `auth_fingerprint` output. Modeled on the
        // server_update.rs `d29_invariant_*` static-grep tests.
        let source = include_str!("./pool.rs");
        let body = strip_comments_and_tests(source);

        let log_sinks = ["emit_log", "eprintln!", "println!", "tracing::", "log::", "dbg!"];
        for line in body.lines() {
            let has_sink = log_sinks.iter().any(|s| line.contains(s));
            if !has_sink {
                continue;
            }
            assert!(
                !line.contains("key") && !line.contains("auth_fingerprint") && !line.contains("fingerprint"),
                "D-29 violation: a log sink references the cache key or fingerprint. Line: {}",
                line.trim()
            );
        }
    }

    /// Strip line/block comments and the `#[cfg(test)]` module so the static-grep
    /// scans only operational code (mirrors server_update.rs helper).
    fn strip_comments_and_tests(src: &str) -> String {
        let bytes = src.as_bytes();
        let mut out = String::with_capacity(bytes.len());
        let mut i = 0;
        let cutoff = src.find("#[cfg(test)]").unwrap_or(src.len());

        while i < cutoff {
            let c = bytes[i] as char;
            // Line comment `// ...` (includes `///` and `//!`)
            if c == '/' && i + 1 < cutoff && bytes[i + 1] as char == '/' {
                while i < cutoff && bytes[i] as char != '\n' {
                    i += 1;
                }
                continue;
            }
            // Block comment `/* ... */`
            if c == '/' && i + 1 < cutoff && bytes[i + 1] as char == '*' {
                i += 2;
                while i + 1 < cutoff && !(bytes[i] as char == '*' && bytes[i + 1] as char == '/') {
                    i += 1;
                }
                i = (i + 2).min(cutoff);
                continue;
            }
            out.push(c);
            i += 1;
        }
        out
    }
}
