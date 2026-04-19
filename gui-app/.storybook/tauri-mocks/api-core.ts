// Storybook mock for @tauri-apps/api/core
//
// Per-command returns for invoke() so integration stories (e.g. UsersSection ->
// UserConfigModal) render with non-null backend data. A catch-all `null` is
// safe for the rest — components that need real data use _override escape
// hatches in their own stories.

// Example base64url TLV payload (matches DEEP_LINK spec, fake values).
// Same string used by UserConfigModal.stories.tsx for consistency.
const FAKE_DEEPLINK =
  "tt://?AQtleGFtcGxlLmNvbQIJMTkyLjE2OC4xLjE6NDQzBQlzd2lmdC1mb3gGCHBhc3N3b3Jk";

export const invoke = async (
  command: string,
  _args?: unknown,
): Promise<unknown> => {
  console.warn(`[Storybook] Tauri invoke: ${command}`);

  switch (command) {
    // UserConfigModal — QR/deeplink display (opened from FileText icon +
    // auto-open after successful Add).
    case "server_export_config_deeplink":
    case "server_export_config_deeplink_advanced":
      return FAKE_DEEPLINK;

    // Download flow — returns a server-side temp path; the save()/copy_file
    // chain is short-circuited by plugin-dialog mock.
    case "fetch_server_config":
      return "/tmp/storybook-fake-config.toml";
    case "copy_file":
      return null;

    // Phase 14.1 advanced commands — per-user rules.toml + cert probe.
    case "server_add_user_advanced":
    case "server_update_user_config":
    case "server_rotate_user_password":
    case "server_regenerate_client_prefix":
      return null;
    case "server_get_user_config":
      return { username: "swift-fox", cidr: null, clientRandomPrefix: null };

    // M-01 — Custom SNI autocomplete. Two hosts so the chip rail renders
    // something interesting in isolation (single-host deploys work too, but
    // the story is more illustrative with a non-trivial list).
    case "server_get_allowed_sni_list":
      return [
        {
          hostname: "vpn.example.com",
          allowedSni: ["cdn.example.com", "static.example.com"],
        },
        {
          hostname: "vpn2.example.com",
          allowedSni: [],
        },
      ];

    // FIX-NN — users-advanced.toml sidecar. `null` means no persisted
    // entry → UserModal/UserConfigModal fall back to defaults / basic
    // deeplink. Stories that want populated fields pass `_deeplinkOverride`
    // or similar story-level escape hatches.
    case "server_get_user_advanced":
      return null;
    // A — batch. Empty array fits "no per-user advanced data" fallback.
    case "server_list_user_advanced":
      return [];
    // M-11 — reconcile returns count of orphans removed. 0 = clean, no-op.
    case "server_reconcile_users_advanced":
      return 0;
    case "server_set_user_advanced":
    case "server_delete_user_advanced":
      return null;
    case "server_fetch_endpoint_cert":
      return {
        leafDerB64: "MIIB...FAKE...DER",
        fingerprintSha256:
          "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99",
        commonName: "example.com",
        notAfter: "2027-04-18T00:00:00Z",
      };

    default:
      return null;
  }
};
