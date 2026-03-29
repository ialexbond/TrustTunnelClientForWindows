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
    case "SSH_CONNECT_FAILED":
      return t("sshErrors.connectFailed", { detail: parts[1] || "" });
    case "SSH_HOST_KEY_CHANGED":
      return t("sshErrors.hostKeyChanged");
    case "SSH_CHANNEL_FAILED":
      return t("sshErrors.channelFailed", { detail: parts[1] || "" });
    case "SSH_EXEC_FAILED":
      return t("sshErrors.execFailed", { detail: parts[1] || "" });

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

    // ─── User operations ───
    case "SSH_ADD_USER_FAILED":
      return t("sshErrors.addUserFailed");
    case "SSH_DELETE_USER_FAILED":
      return t("sshErrors.deleteUserFailed");

    // ─── Config operations ───
    case "SSH_CONFIG_CREATE_FAILED":
      return t("sshErrors.configCreateFailed");
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
    case "SSH_UNINSTALL_FAILED":
      return t("sshErrors.uninstallFailed", { code: parts[1] || "" });
    case "SSH_CERT_RENEW_FAILED":
      return t("sshErrors.certRenewFailed", { code: parts[1] || "" });

    // ─── Other ───
    case "SSH_MKDIR_FAILED":
      return t("sshErrors.mkdirFailed", { detail: parts[1] || "" });
    case "SSH_KILL_PROCESS_FAILED":
      return t("sshErrors.killProcessFailed", { detail: parts[1] || "" });

    default:
      // Fallback: return raw error (already in English or unknown format)
      return raw;
  }
}
