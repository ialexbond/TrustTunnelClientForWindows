use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex as TokioMutex;
use russh::client;
use super::{SshHandler, SshParams, ssh_connect, open_session_with_retry};

struct CachedSsh {
    key: String,
    handle: Arc<client::Handle<SshHandler>>,
}

/// Single-slot SSH connection pool for server management commands.
///
/// Reuses one persistent SSH connection per server, eliminating 200-500ms
/// TCP+auth overhead per request. Keepalive packets prevent SSH timeout.
pub struct SshPool {
    inner: Arc<TokioMutex<Option<CachedSsh>>>,
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
        let key = format!("{}:{}:{}", params.host, params.port, params.ssh_user);
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
