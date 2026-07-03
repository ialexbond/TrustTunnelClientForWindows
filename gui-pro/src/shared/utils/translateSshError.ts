import type { TFunction } from "i18next";

/**
 * Translates SSH error codes from Rust backend to localized messages.
 * Rust returns errors in format: "ERROR_CODE|param1|param2"
 * Frontend maps them to i18n keys with interpolation.
 */
export function translateSshError(error: string, t: TFunction): string {
  const raw = String(error);
  const parts = raw.split("|");
  const code = parts[0];

  switch (code) {
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

    // ─── Export ───
    case "SSH_EXPORT_FAILED":
      return parts[2]
        ? t("sshErrors.exportFailedUsers", { code: parts[1], users: parts[2] })
        : t("sshErrors.exportFailed", { code: parts[1] || "" });
    case "SSH_DEEPLINK_EXPORT_FAILED":
      return t("sshErrors.deeplinkExportFailed", { code: parts[1] || "", user: parts[2] || "" });

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
