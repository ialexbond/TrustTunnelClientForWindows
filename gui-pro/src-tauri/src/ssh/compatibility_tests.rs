//! Exercise the panel's SSH boundary without contacting servers or reading user data.
use super::{bare_host_key_fingerprint, exec_command_quiet, signing_key};
use super::server::server_ssh_key::generate_ssh_keypair;
use russh::keys::ssh_key::{Algorithm, PrivateKey, PublicKey};
use russh::keys::PublicKeyOrCertificate;
use russh::{client, server, Channel, ChannelId};
use russh::server::Server;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio::time::timeout;

fn generated_key() -> PrivateKey {
    let generated = generate_ssh_keypair("compatibility-test").expect("generate panel key");
    russh::keys::decode_secret_key(&generated.private_pem, None).expect("decode existing key format")
}

struct FixtureClient {
    expected_fingerprint: String,
}

impl client::Handler for FixtureClient {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        Ok(bare_host_key_fingerprint(key).as_deref() == Some(&self.expected_fingerprint))
    }
}

#[derive(Clone)]
struct FixtureServer {
    password: Arc<String>,
    authorized_key: Arc<PublicKey>,
    auth_attempts: Arc<AtomicUsize>,
}

impl server::Server for FixtureServer {
    type Handler = Self;

    fn new_client(&mut self, _: Option<SocketAddr>) -> Self::Handler {
        self.clone()
    }
}

impl server::Handler for FixtureServer {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<server::Auth, Self::Error> {
        self.auth_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(if user == "operator" && password == self.password.as_str() {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }

    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<server::Auth, Self::Error> {
        self.auth_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(if user == "operator" && key.key_data() == self.authorized_key.key_data() {
            server::Auth::Accept
        } else {
            server::Auth::reject()
        })
    }

    async fn channel_open_session(
        &mut self,
        _: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        command: &[u8],
        session: &mut server::Session,
    ) -> Result<(), Self::Error> {
        if command != b"read-panel-status" {
            session.channel_failure(channel)?;
            return Ok(());
        }
        session.channel_success(channel)?;
        session.data(channel, b"panel-output\n".as_slice())?;
        session.extended_data(channel, 1, b"panel-diagnostic\n".as_slice())?;
        session.exit_status_request(channel, 7)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
}

struct LoopbackServer {
    address: SocketAddr,
    fingerprint: String,
    password: Arc<String>,
    auth_attempts: Arc<AtomicUsize>,
    task: JoinHandle<()>,
}

impl LoopbackServer {
    async fn start(authorized_key: &PrivateKey) -> Self {
        let host_key = generated_key();
        let fingerprint = host_key.public_key().fingerprint(russh::keys::ssh_key::HashAlg::Sha256).to_string();
        let password = Arc::new(uuid::Uuid::new_v4().to_string());
        let auth_attempts = Arc::new(AtomicUsize::new(0));
        let mut handler = FixtureServer {
            password: password.clone(),
            authorized_key: Arc::new(authorized_key.public_key().clone()),
            auth_attempts: auth_attempts.clone(),
        };
        let mut config = server::Config {
            keys: vec![host_key],
            auth_rejection_time: Duration::ZERO,
            ..Default::default()
        };
        // Modern servers need RSA SHA-2. The panel must negotiate it for existing keys.
        config.preferred.key.to_mut().retain(|algorithm| !matches!(algorithm, Algorithm::Rsa { hash: None }));
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.expect("bind loopback fixture");
        let address = listener.local_addr().expect("read fixture port");
        let task = tokio::spawn(async move {
            let _ = handler.run_on_socket(Arc::new(config), &listener).await;
        });
        Self { address, fingerprint, password, auth_attempts, task }
    }

    async fn connect(&self) -> client::Handle<FixtureClient> {
        timeout(Duration::from_secs(10), client::connect(
            Arc::new(client::Config::default()),
            self.address,
            FixtureClient { expected_fingerprint: self.fingerprint.clone() },
        )).await.expect("SSH handshake timed out").expect("connect to recognized host")
    }
}

impl Drop for LoopbackServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn assert_panel_output(handle: &client::Handle<FixtureClient>) {
    let (output, status) = timeout(Duration::from_secs(10), exec_command_quiet(handle, "read-panel-status"))
        .await.expect("panel command timed out").expect("receive panel command result");
    assert_eq!(output, "panel-output\npanel-diagnostic\n");
    assert_eq!(status, 7);
}

#[test]
fn stored_host_fingerprints_survive_the_library_upgrade() {
    let generated = generate_ssh_keypair("previously-saved-host").expect("generate existing key format");
    let parsed = russh::keys::decode_secret_key(&generated.private_pem, None).expect("parse existing key");
    let offered = PublicKeyOrCertificate::from(parsed.public_key().clone());
    assert_eq!(bare_host_key_fingerprint(&offered), Some(generated.fingerprint));
}

#[test]
fn host_certificates_are_not_silently_trusted_as_saved_keys() {
    let signing = ssh_key::PrivateKey::random(&mut ssh_key::rand_core::OsRng, ssh_key::Algorithm::Ed25519)
        .expect("generate fixture certificate signer");
    let mut builder = ssh_key::certificate::Builder::new(
        vec![1; 32], signing.public_key().key_data().clone(), 0, 2_000_000_000,
    ).expect("build synthetic host certificate");
    builder.cert_type(ssh_key::certificate::CertType::Host).expect("host certificate type");
    builder.valid_principal("localhost").expect("fixture principal");
    let encoded = builder.sign(&signing).expect("sign fixture certificate").to_openssh().expect("encode certificate");
    let certificate = russh::keys::ssh_key::Certificate::from_openssh(&encoded).expect("parse certificate");
    assert!(bare_host_key_fingerprint(&PublicKeyOrCertificate::Certificate(certificate)).is_none());
}

#[tokio::test]
async fn password_login_preserves_panel_output_and_exit_status() {
    let fixture = LoopbackServer::start(&generated_key()).await;
    let mut handle = fixture.connect().await;
    let result = handle.authenticate_password("operator", fixture.password.as_str()).await.expect("password exchange");
    assert!(matches!(result, client::AuthResult::Success));
    assert_panel_output(&handle).await;
}

#[tokio::test]
async fn incorrect_password_is_rejected() {
    let fixture = LoopbackServer::start(&generated_key()).await;
    let mut handle = fixture.connect().await;
    let result = handle.authenticate_password("operator", uuid::Uuid::new_v4().to_string()).await.expect("password exchange");
    assert!(!matches!(result, client::AuthResult::Success));
}

#[tokio::test]
async fn existing_generated_key_can_authenticate_and_read_the_panel() {
    let key = generated_key();
    let fixture = LoopbackServer::start(&key).await;
    let mut handle = fixture.connect().await;
    let key = signing_key(&handle, key).await.expect("prepare existing key");
    let result = handle.authenticate_publickey("operator", key).await.expect("public-key exchange");
    assert!(matches!(result, client::AuthResult::Success));
    assert_panel_output(&handle).await;
}

#[tokio::test]
async fn existing_rsa_key_negotiates_sha2_authentication() {
    let key = PrivateKey::random(&mut rand_0_10::rng(), Algorithm::Rsa { hash: None }).expect("generate RSA fixture");
    let fixture = LoopbackServer::start(&key).await;
    let mut handle = fixture.connect().await;
    let key = signing_key(&handle, key).await.expect("negotiate RSA signature");
    assert!(key.hash_alg().is_some(), "RSA must use a negotiated SHA-2 signature");
    let result = handle.authenticate_publickey("operator", key).await.expect("RSA exchange");
    assert!(matches!(result, client::AuthResult::Success));
    assert_panel_output(&handle).await;
}

#[tokio::test]
async fn unrecognized_client_key_is_rejected() {
    let fixture = LoopbackServer::start(&generated_key()).await;
    let mut handle = fixture.connect().await;
    let key = signing_key(&handle, generated_key()).await.expect("prepare unrecognized key");
    let result = handle.authenticate_publickey("operator", key).await.expect("public-key exchange");
    assert!(!matches!(result, client::AuthResult::Success));
}

#[tokio::test]
async fn changed_host_key_is_rejected_before_sending_credentials() {
    let fixture = LoopbackServer::start(&generated_key()).await;
    let other_host = generate_ssh_keypair("different-host").expect("generate replacement host");
    let result = timeout(Duration::from_secs(10), client::connect(
        Arc::new(client::Config::default()), fixture.address,
        FixtureClient { expected_fingerprint: other_host.fingerprint },
    )).await.expect("host-key rejection timed out");
    assert!(result.is_err());
    assert_eq!(fixture.auth_attempts.load(Ordering::SeqCst), 0);
}
