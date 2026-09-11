import type { TFunction } from "i18next";
import { UNKNOWN_ERROR_FALLBACK } from "./formatError";

/**
 * Translates SSH error codes from Rust backend to localized messages.
 * Rust returns errors in format: "ERROR_CODE|param1|param2"
 * Frontend maps them to i18n keys with interpolation.
 *
 * Every caller runs `formatError` first and every caller is user-facing (the raw
 * string is logged separately, before translating). That makes this a presentation
 * boundary, which is why it also claims `formatError`'s English fallback — see the
 * UNKNOWN_ERROR_FALLBACK case below.
 */
export function translateSshError(error: string, t: TFunction): string {
  const raw = String(error);
  const parts = raw.split("|");
  const code = parts[0];

  switch (code) {
    // ─── Connect-time input validation (ssh/mod.rs:581-583) ───
    // These three fire at the very first line of `ssh_connect`, before any socket is
    // opened, so they can front ANY control-panel action. The detail on the wire is raw
    // English validator prose from sanitize.rs («SSH host contains invalid characters»)
    // and, for auth_method, it echoes the rejected value back. Neither is actionable for a
    // non-technical reader, so the detail is deliberately DROPPED from the snackbar and
    // only the plain-RU rule is shown — the same precedent SSH_ENDPOINT_NOT_INSTALLED and
    // COPY_SOURCE_UNRESOLVABLE already set. Callers log the RAW string before translating
    // (see useServerState G-07), so nothing is lost for diagnosis.
    case "SSH_INVALID_HOST":
      return t("sshErrors.invalidHost");
    case "SSH_INVALID_USER":
      return t("sshErrors.invalidUser");
    case "SSH_INVALID_AUTH_METHOD":
      return t("sshErrors.invalidAuthMethod");

    // ─── Connection ───
    case "SSH_TIMEOUT":
      return t("sshErrors.timeout", { target: parts[1] || "" });
    case "SSH_CONNECT_FAILED": {
      // WR-04 fix (a): case-insensitive host-key detection — russh occasionally
      // lowercases the key variant in error messages.
      const rawDetail = parts[1] || "";
      if (rawDetail.toLowerCase().includes("unknown server key")) {
        return t("sshErrors.hostKeyChanged");
      }
      // WR-04 fix (b): strip misleading "authentication disabled" noise from
      // network-level/handshake errors. russh's kex failures sometimes include
      // phrases like "Authentication disabled" referring to the auth METHOD
      // the server advertises, not an auth failure. Surfacing that raw text
      // in the connectFailed i18n string reads like "wrong password" to users
      // (reported false positive from Phase 13 UAT).
      const cleanDetail = rawDetail.replace(
        /authentication[\s\w]*disabled/gi,
        "handshake failed",
      );
      return t("sshErrors.connectFailed", { detail: cleanDetail });
    }
    case "SSH_HOST_KEY_CHANGED":
      return t("sshErrors.hostKeyChanged");
    case "SSH_CHANNEL_FAILED":
      return t("sshErrors.channelFailed", { detail: parts[1] || "" });
    case "SSH_EXEC_FAILED":
      return t("sshErrors.execFailed", { detail: parts[1] || "" });

    // ─── Network (Phase 12.5) ───
    case "SSH_DNS_FAILED":
      return t("sshErrors.dnsFailed", { host: parts[1] || "" });
    case "SSH_NETWORK_UNREACHABLE":
      return t("sshErrors.networkUnreachable", { host: parts[1] || "" });
    case "SSH_CONNECTION_REFUSED":
      return t("sshErrors.connectionRefused", {
        host: parts[1] || "",
        port: parts[2] || "",
      });
    case "SSH_TLS_HANDSHAKE_FAILED":
      return t("sshErrors.tlsHandshakeFailed", { host: parts[1] || "" });

    // ─── Authentication ───
    case "SSH_AUTH_FAILED":
      return t("sshErrors.authFailed");
    case "SSH_AUTH_ERROR":
      return t("sshErrors.authError", { detail: parts[1] || "" });
    case "SSH_KEY_LOAD_FAILED":
      return t("sshErrors.keyLoadFailed", { path: parts[1] || "", detail: parts[2] || "" });
    case "SSH_KEY_AUTH_ERROR":
      return t("sshErrors.keyAuthError", { detail: parts[1] || "" });
    case "SSH_KEY_REJECTED":
      return t("sshErrors.keyRejected");
    // D-08 asks the user to re-select the key instead of dying on the opaque
    // SSH_KEY_LOAD_FAILED. `parts[1]` is a FIXED backend enum (file|pasted|missing) — never
    // a path and never key material (D-29/D-10) — so branching on it is safe, and it has to
    // branch: the three exits need three different instructions.
    //
    // Why `file` is the high-traffic one, not an edge case: useServerState sends `keyPath`
    // WITHOUT an `authMethod`, so auth_plan(None, …) picks LegacySequence → try_key_auth →
    // `load_secret_key(kp, None)`. That call fails both for a moved/deleted file AND for
    // every passphrase-protected key — i.e. for every user who put a passphrase on their
    // key. Until this case existed they read the literal «SSH_KEY_REENTER_REQUIRED|file».
    case "SSH_KEY_REENTER_REQUIRED":
      switch (parts[1]) {
        case "file":
          return t("sshErrors.keyReenterRequiredFile");
        case "pasted":
          return t("sshErrors.keyReenterRequiredPasted");
        case "missing":
          return t("sshErrors.keyReenterRequiredMissing");
        default:
          // A tag the backend adds later must still read as Russian, not as a code.
          return t("sshErrors.keyReenterRequired");
      }
    // Deliberately NOT folded into authFailed: this arm is only reachable on the explicit
    // "password" plan (the wizard's choice), so the actionable next step is the key —
    // that steering is the whole reason D-07 kept the two codes distinct.
    case "SSH_PASSWORD_REJECTED":
      return t("sshErrors.passwordRejected");

    // ─── Service operations ───
    case "SSH_SERVICE_RESTART_FAILED":
      return t("sshErrors.serviceRestartFailed");
    case "SSH_SERVICE_STOP_FAILED":
      return t("sshErrors.serviceStopFailed");
    case "SSH_SERVICE_START_FAILED":
      return t("sshErrors.serviceStartFailed");
    // 06-14 C-07: deploy_check_env now emits this instead of raw English so the
    // non-technical user sees a friendly RU lead, not «Root privileges required…».
    case "SSH_ROOT_REQUIRED":
      return t("sshErrors.rootRequired");

    // ─── User operations ───
    case "SSH_ADD_USER_FAILED":
      return t("sshErrors.addUserFailed");
    case "SSH_DELETE_USER_FAILED":
      return t("sshErrors.deleteUserFailed");
    // 06-14 C-07: server_install emits SSH_USER_ALREADY_EXISTS|{username}; interpolate
    // the (already-validated, non-secret) username into the friendly RU sentence.
    case "SSH_USER_ALREADY_EXISTS":
      return t("sshErrors.userAlreadyExists", { user: parts[1] || "" });
    // 06-14 C-07: add-user now emits this when the server has no credentials.toml yet.
    case "SSH_CREDENTIALS_NOT_FOUND":
      return t("sshErrors.credentialsNotFound");
    // Password rotation found no matching [[client]] block in credentials.toml (exit 9) —
    // the user list in the app has drifted from the server, so «refresh and retry» is the
    // action, not «try a different password».
    case "SSH_ROTATE_USER_NOT_FOUND":
      return t("sshErrors.rotateUserNotFound");

    // ─── Config operations ───
    case "SSH_CONFIG_CREATE_FAILED":
      return t("sshErrors.configCreateFailed");
    // C-05 (06-08): marker shape is `SSH_CONFIG_DIVERGES|{fname}|{reason}` from
    // deploy.rs — the friendly string does not need parts[1] (fname). Surfaces a
    // RU lead instead of the raw English so the user is never stranded.
    case "SSH_CONFIG_DIVERGES":
      return t("sshErrors.configDiverges");
    // 06-14 C-06: deploy_configure now preserves the install script's port-80-busy
    // marker as this code, so the user gets the plain-RU «порт 80 занят» lead plus a
    // one-click switch-to-self-signed action in ErrorStep (the fastest fix).
    case "SSH_CERTBOT_PORT80_BUSY":
      return t("sshErrors.certbotPort80Busy");
    // 06-14 C-07: the cert-verification failure now translates instead of leaking
    // «Certificates were not created…» raw English.
    case "SSH_CERT_NOT_CREATED":
      return t("sshErrors.certNotCreated");
    case "SSH_READ_CONFIG_FAILED":
      return t("sshErrors.readConfigFailed");
    case "SSH_WRITE_CONFIG_FAILED":
      return t("sshErrors.writeConfigFailed", { detail: parts[1] || "" });
    case "SSH_ENDPOINT_CONFIG_ERROR":
      return t("sshErrors.endpointConfigError", { detail: parts[1] || "" });
    // The three remote-write failures below all carry only a shell EXIT CODE as detail —
    // safe and worth showing (same convention as installFailed/exportFailed), unlike the
    // validator-prose details above. They differ in WHICH file failed, which is what tells
    // the user whether their access rules or their user settings did not land.
    case "SSH_RULES_WRITE_FAILED":
      return t("sshErrors.rulesWriteFailed", { code: parts[1] || "" });
    case "SSH_UPDATE_CONFIG_FAILED":
      return t("sshErrors.updateConfigFailed", { code: parts[1] || "" });
    case "SSH_USERS_ADVANCED_WRITE_FAILED":
      return t("sshErrors.usersAdvancedWriteFailed", { code: parts[1] || "" });

    // ─── Server-side preconditions of the config export (Phase 25 / WR-01) ───
    // These four exits of `fetch_server_config` used to return bare English prose with no
    // machine code at all, so NEITHER translator could touch them and the Users-tab
    // «Скачать конфиг» snackbar showed English. They are ordinary failures — a partially
    // uninstalled endpoint, or a user list that drifted from credentials.toml — not exotic
    // ones. The Rust side keeps emitting the human sentence to the `deploy-step` channel
    // (DeployingStep renders that verbatim); only the RETURNED error carries the code.
    case "SSH_ENDPOINT_NOT_INSTALLED":
      // Detail on the wire is ENDPOINT_BINARY, deliberately not rendered: an absolute
      // server path is not something a non-technical reader can act on. It stays in the
      // activity log, which keeps the raw string.
      return t("sshErrors.endpointNotInstalled");
    case "SSH_ENDPOINT_CONFIG_MISSING":
      return t("sshErrors.endpointConfigMissing");
    case "SSH_USER_NOT_IN_CREDENTIALS":
      // Both details are the actionable content — which login was asked for, and which
      // ones the server actually has. `parts[1]` is whitelist-validated backend-side; the
      // available list is server-controlled, so rejoin EVERYTHING past the second
      // separator (same reasoning as translatePathError's IN-03 fix) — a username holding
      // a `|` must not silently truncate the list the user is being told to choose from.
      return t("sshErrors.userNotInCredentials", {
        user: parts[1] || "",
        users: parts.slice(2).join("|"),
      });
    case "SSH_CLIENT_NAME_INVALID":
      // The refused name, echoed through the backend's `echo_safe_client_name` (whitelist
      // + 64-char cap), so it cannot carry a separator or an unbounded payload.
      return t("sshErrors.clientNameInvalid", { user: parts[1] || "" });

    // ─── Export ───
    case "SSH_EXPORT_FAILED":
      return parts[2]
        ? t("sshErrors.exportFailedUsers", { code: parts[1], users: parts[2] })
        : t("sshErrors.exportFailed", { code: parts[1] || "" });
    case "SSH_DEEPLINK_EXPORT_FAILED":
      return t("sshErrors.deeplinkExportFailed", { code: parts[1] || "", user: parts[2] || "" });
    // deploy_export_config refuses to bake an unvalidated SSH host into the client config.
    // Detail is the same English validator prose as SSH_INVALID_HOST — dropped for the same
    // reason. The fix is on the user's side (set a domain, or type a real IP), so say that.
    case "SSH_EXPORT_INVALID_HOST":
      return t("sshErrors.exportInvalidHost");

    // ─── Install / Uninstall ───
    // 06-14 C-14: a held dpkg/apt lock during package update is recoverable — the
    // friendly RU lead tells the user to retry in a couple of minutes.
    case "SSH_DPKG_LOCKED":
      return t("sshErrors.dpkgLocked");
    case "SSH_UNINSTALL_FAILED":
      return t("sshErrors.uninstallFailed", { code: parts[1] || "" });
    // Install couldn't download the TrustTunnel package from github.com (server DNS/network).
    case "SSH_PACKAGE_DOWNLOAD_FAILED":
      return t("sshErrors.packageDownloadFailed");
    // Generic install failure (translatable) — replaces the raw «Installation failed (code N)».
    case "SSH_INSTALL_FAILED":
      return t("sshErrors.installFailed", { code: parts[1] || "" });
    // Single-flight guard: a second install/uninstall was triggered while one was still
    // running (e.g. the ~15s connect of the first). Shown RAW English before this case.
    case "SSH_DEPLOY_IN_PROGRESS":
      return t("sshErrors.deployInProgress");
    case "SSH_DEPLOY_CANCELLED":
      return t("sshErrors.deployCancelled");
    case "SSH_CERT_RENEW_FAILED":
      return t("sshErrors.certRenewFailed", { code: parts[1] || "" });

    // ─── Other ───
    case "SSH_MKDIR_FAILED":
      return t("sshErrors.mkdirFailed", { detail: parts[1] || "" });
    case "SSH_KILL_PROCESS_FAILED":
      return t("sshErrors.killProcessFailed", { detail: parts[1] || "" });

    // ─── GeoIP (Phase 13) ───
    case "GEOIP_TIMEOUT":
      return t("geoipErrors.timeout");
    case "GEOIP_NO_NETWORK":
      return t("geoipErrors.noNetwork");
    case "GEOIP_RATE_LIMITED":
      return t("geoipErrors.rateLimited");
    case "GEOIP_INVALID_RESPONSE":
      return t("geoipErrors.invalidResponse", { detail: parts[1] || "" });

    // ─── No message existed in the first place (T-41b) ───
    // Not a backend code: it is what `formatError` produces when the thrown value is
    // neither an Error nor a string, and it used to reach snackbars as bare English.
    // Matched by identity against the exported constant, so rewording that fallback
    // cannot silently un-localize this. The translation lives here and not inside
    // `formatError` because `formatError` also feeds the activity log, which must
    // stay English and greppable. `translatePathError` carries the same case.
    case UNKNOWN_ERROR_FALLBACK:
      return t("commonErrors.unknown");

    default:
      // Dev-warn: surface unknown SSH_*/GEOIP_* codes for early detection in dev sessions
      if (
        import.meta.env.DEV &&
        (code.startsWith("SSH_") || code.startsWith("GEOIP_"))
      ) {
        console.warn(
          `[translateSshError] Unknown SSH error code: ${code}, raw: ${raw}`,
        );
      }
      // Fallback: return raw error (already in English or unknown format)
      return raw;
  }
}
