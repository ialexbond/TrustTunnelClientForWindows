import type { DefaultsMap } from "../types";

/**
 * Phase 15.1 D-6.2 — vpn.toml static defaults map.
 *
 * Source: upstream CONFIGURATION.md (RESEARCH.md §Upstream TOML Schema Reference).
 * Manual sync при upgrade — Phase 15.1 не auto-generates.
 *
 * Map keys = path joined with dots (e.g. "listen_protocols.http2.max_concurrent_streams").
 * Values = upstream defaults. inferTomlFieldType uses this for kind dispatch
 * когда field не explicit в файле.
 *
 * Sync notice: derived from upstream CONFIGURATION.md as of 2026-04-28.
 * Manual review required at upgrade.
 */
export const VPN_DEFAULTS: DefaultsMap = {
  // ─── Root-level scalars ───────────────────────────────────────────────────
  "listen_address": "0.0.0.0:443",
  "ipv6_available": true,
  "allow_private_network_connections": false,
  "tls_handshake_timeout_secs": 5,
  "client_listener_timeout_secs": 5,
  "connection_establishment_timeout_secs": 5,
  "tcp_connections_timeout_secs": 60,
  "udp_connections_timeout_secs": 60,
  "credentials_file": "credentials.toml",
  "rules_file": "rules.toml",
  "speedtest_enable": false,
  "ping_enable": false,
  "ping_path": "/ping",
  "speedtest_path": "/speedtest",
  "auth_failure_status_code": 407,
  "log_level": "info",

  // ─── [listen_protocols.http1] — 1 field ───────────────────────────────────
  "listen_protocols.http1.max_header_list_size": 8192,

  // ─── [listen_protocols.http2] — 5 fields ──────────────────────────────────
  "listen_protocols.http2.max_header_list_size": 8192,
  "listen_protocols.http2.max_concurrent_streams": 100,
  "listen_protocols.http2.initial_connection_window_size": 65536,
  "listen_protocols.http2.initial_stream_window_size": 65536,
  "listen_protocols.http2.max_frame_size": 16384,

  // ─── [listen_protocols.quic] — 13 fields (bool + int) ─────────────────────
  "listen_protocols.quic.max_idle_timeout_ms": 30000,
  "listen_protocols.quic.max_concurrent_bidi_streams": 100,
  "listen_protocols.quic.max_concurrent_uni_streams": 100,
  "listen_protocols.quic.recv_udp_payload_size": 1500,
  "listen_protocols.quic.send_udp_payload_size": 1500,
  "listen_protocols.quic.initial_max_data": 10485760,
  "listen_protocols.quic.initial_max_stream_data_bidi_local": 1048576,
  "listen_protocols.quic.initial_max_stream_data_bidi_remote": 1048576,
  "listen_protocols.quic.initial_max_stream_data_uni": 1048576,
  "listen_protocols.quic.ack_delay_exponent": 3,
  "listen_protocols.quic.max_ack_delay_ms": 25,
  "listen_protocols.quic.disable_active_migration": false,
  "listen_protocols.quic.active_connection_id_limit": 7,

  // ─── [forward_protocol] — variant (direct={} OR socks5) ───────────────────
  "forward_protocol.direct": {},
  "forward_protocol.socks5.address": "127.0.0.1:1080",
  "forward_protocol.socks5.extended_auth": false,

  // ─── [reverse_proxy] — optional, 3 fields ─────────────────────────────────
  "reverse_proxy.bind_address": "127.0.0.1:8080",
  "reverse_proxy.target_address": "127.0.0.1:80",
  "reverse_proxy.tls_terminate": false,

  // ─── [icmp] — optional, 3 fields ──────────────────────────────────────────
  "icmp.enable": false,
  "icmp.bind_address": "0.0.0.0",
  "icmp.timeout_ms": 5000,

  // ─── [metrics] — optional, 2 fields ───────────────────────────────────────
  "metrics.enable": false,
  "metrics.bind_address": "127.0.0.1:9090",
};
