import type { ConfigBundle } from "../../components/server/config/types";

/**
 * Shared `makeBundle()` config-bundle factory (Phase 3 safety-net, Wave 0).
 *
 * Dedupes the three `MOCK_BUNDLE` literals previously inlined in
 * ConfigurationTab.test.tsx and useTomlConfigState.test.ts (RESEARCH §3
 * stream 3 fixtures note / §4.1). Values are copied verbatim from those
 * literals so consumers that switch to this factory get byte-identical data —
 * including the placeholder secret `TOPSECRET123` in credentialsToml, which the
 * D-29 tests assert is NEVER leaked into the activity log.
 *
 * The bundle is typed via the real `ConfigBundle` interface (not `any`) so a
 * backend contract change (camelCase key rename) breaks this factory at compile
 * time rather than silently at runtime.
 *
 * Defaults reproduce the richer ConfigurationTab.test.tsx literal (fully-typed
 * `typed` field + 4-file raw TOML). The useTomlConfigState.test.ts literal used
 * `typed: {}` and a 2-entry rules.toml; those streams pass overrides
 * (`makeBundle({ typed: {...}, rulesToml: "..." })`) to recover their exact
 * shape.
 */
export function makeBundle(overrides: Partial<ConfigBundle> = {}): ConfigBundle {
  return {
    vpnToml: `listen_address = "0.0.0.0:443"
ipv6_available = true
`,
    hostsToml: `[[main_hosts]]
hostname = "a.com"
`,
    credentialsToml: `[[client]]
username = "user1"
password = "TOPSECRET123"
`,
    rulesToml: `[[rule]]
cidr = "10.0.0.0/8"
action = "allow"
`,
    typed: {
      listen_address: "0.0.0.0:443",
      ipv6_available: true,
      allow_private_network_connections: false,
      log_level: null,
      auth_failure_status_code: 407,
      ping_enable: false,
      speedtest_enable: false,
      ping_path: "/ping",
      speedtest_path: "/speedtest",
      credentials_file: "credentials.toml",
    },
    allowedSni: [],
    serviceStatus: "active",
    ...overrides,
  };
}
