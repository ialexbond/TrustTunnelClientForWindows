import { describe, it, expect } from "vitest";
import type { TFunction } from "i18next";
import { translateSshError } from "./translateSshError";
import { formatError, UNKNOWN_ERROR_FALLBACK } from "./formatError";
import i18n from "../i18n";

const mockT = ((key: string, params?: Record<string, string>) => {
  if (params) return `${key}:${JSON.stringify(params)}`;
  return key;
}) as TFunction;

describe("translateSshError", () => {
  // ─── Connection ───
  it("translates SSH_TIMEOUT with target param", () => {
    expect(translateSshError("SSH_TIMEOUT|192.168.1.1", mockT)).toBe(
      'sshErrors.timeout:{"target":"192.168.1.1"}',
    );
  });

  it("translates SSH_CONNECT_FAILED with detail", () => {
    expect(translateSshError("SSH_CONNECT_FAILED|refused", mockT)).toBe(
      'sshErrors.connectFailed:{"detail":"refused"}',
    );
  });

  it("translates SSH_CHANNEL_FAILED with detail", () => {
    expect(translateSshError("SSH_CHANNEL_FAILED|no channel", mockT)).toBe(
      'sshErrors.channelFailed:{"detail":"no channel"}',
    );
  });

  it("translates SSH_EXEC_FAILED with detail", () => {
    expect(translateSshError("SSH_EXEC_FAILED|command error", mockT)).toBe(
      'sshErrors.execFailed:{"detail":"command error"}',
    );
  });

  // ─── Authentication ───
  it("translates SSH_AUTH_FAILED without params", () => {
    expect(translateSshError("SSH_AUTH_FAILED", mockT)).toBe("sshErrors.authFailed");
  });

  it("translates SSH_AUTH_ERROR with detail", () => {
    expect(translateSshError("SSH_AUTH_ERROR|bad password", mockT)).toBe(
      'sshErrors.authError:{"detail":"bad password"}',
    );
  });

  it("translates SSH_KEY_LOAD_FAILED with path and detail", () => {
    expect(translateSshError("SSH_KEY_LOAD_FAILED|/root/.ssh/id_rsa|permission denied", mockT)).toBe(
      'sshErrors.keyLoadFailed:{"path":"/root/.ssh/id_rsa","detail":"permission denied"}',
    );
  });

  it("translates SSH_KEY_AUTH_ERROR with detail", () => {
    expect(translateSshError("SSH_KEY_AUTH_ERROR|invalid key", mockT)).toBe(
      'sshErrors.keyAuthError:{"detail":"invalid key"}',
    );
  });

  it("translates SSH_KEY_REJECTED without params", () => {
    expect(translateSshError("SSH_KEY_REJECTED", mockT)).toBe("sshErrors.keyRejected");
  });

  // ─── T-40: codes the Rust side emits that had no case at all ───
  // Before these, the switch fell through to `default` and the user read the literal
  // machine code in a red snackbar (`SSH_KEY_REENTER_REQUIRED|file` was the reachable one:
  // useServerState sends keyPath without authMethod → LegacySequence → load_secret_key(kp,
  // None), which fails for every passphrase-protected key).
  it("translates SSH_KEY_REENTER_REQUIRED|file to the moved-or-passphrase message", () => {
    expect(translateSshError("SSH_KEY_REENTER_REQUIRED|file", mockT)).toBe(
      "sshErrors.keyReenterRequiredFile",
    );
  });

  it("translates SSH_KEY_REENTER_REQUIRED|pasted to the re-paste message", () => {
    expect(translateSshError("SSH_KEY_REENTER_REQUIRED|pasted", mockT)).toBe(
      "sshErrors.keyReenterRequiredPasted",
    );
  });

  it("translates SSH_KEY_REENTER_REQUIRED|missing to the no-key-provided message", () => {
    expect(translateSshError("SSH_KEY_REENTER_REQUIRED|missing", mockT)).toBe(
      "sshErrors.keyReenterRequiredMissing",
    );
  });

  it("falls back to the generic key message for an unknown/absent re-enter tag", () => {
    // A tag the backend adds later must still read as prose, never as the raw code.
    expect(translateSshError("SSH_KEY_REENTER_REQUIRED|agent", mockT)).toBe(
      "sshErrors.keyReenterRequired",
    );
    expect(translateSshError("SSH_KEY_REENTER_REQUIRED", mockT)).toBe(
      "sshErrors.keyReenterRequired",
    );
  });

  it("translates SSH_PASSWORD_REJECTED distinctly from SSH_AUTH_FAILED", () => {
    expect(translateSshError("SSH_PASSWORD_REJECTED", mockT)).toBe(
      "sshErrors.passwordRejected",
    );
    // D-07 keeps the two codes apart so the UI can steer toward the key; the
    // translator must not collapse them back into one message.
    expect(translateSshError("SSH_PASSWORD_REJECTED", mockT)).not.toBe(
      translateSshError("SSH_AUTH_FAILED", mockT),
    );
  });

  // ─── T-40: connect-time validators — English prose must NOT reach the snackbar ───
  it("translates SSH_INVALID_HOST and drops the English validator prose", () => {
    const msg = translateSshError(
      "SSH_INVALID_HOST|SSH host contains invalid characters",
      mockT,
    );
    expect(msg).toBe("sshErrors.invalidHost");
    expect(msg).not.toContain("invalid characters");
  });

  it("translates SSH_INVALID_USER and drops the English validator prose", () => {
    const msg = translateSshError(
      "SSH_INVALID_USER|SSH user must be 1-64 characters",
      mockT,
    );
    expect(msg).toBe("sshErrors.invalidUser");
    expect(msg).not.toContain("1-64");
  });

  it("translates SSH_INVALID_AUTH_METHOD without echoing the rejected value back", () => {
    const msg = translateSshError(
      "SSH_INVALID_AUTH_METHOD|Invalid auth_method 'both' (allowed: password, key)",
      mockT,
    );
    expect(msg).toBe("sshErrors.invalidAuthMethod");
    expect(msg).not.toContain("both");
  });

  it("translates SSH_EXPORT_INVALID_HOST and drops the English validator prose", () => {
    const msg = translateSshError(
      "SSH_EXPORT_INVALID_HOST|SSH host has mismatched IPv6 brackets",
      mockT,
    );
    expect(msg).toBe("sshErrors.exportInvalidHost");
    expect(msg).not.toContain("IPv6 brackets");
  });

  // ─── T-40: remote-write failures — the exit code IS actionable, so it stays ───
  it("translates SSH_ROTATE_USER_NOT_FOUND without params", () => {
    expect(translateSshError("SSH_ROTATE_USER_NOT_FOUND", mockT)).toBe(
      "sshErrors.rotateUserNotFound",
    );
  });

  it("translates SSH_RULES_WRITE_FAILED with the exit code", () => {
    expect(translateSshError("SSH_RULES_WRITE_FAILED|1", mockT)).toBe(
      'sshErrors.rulesWriteFailed:{"code":"1"}',
    );
  });

  it("translates SSH_UPDATE_CONFIG_FAILED with the exit code", () => {
    expect(translateSshError("SSH_UPDATE_CONFIG_FAILED|13", mockT)).toBe(
      'sshErrors.updateConfigFailed:{"code":"13"}',
    );
  });

  it("translates SSH_USERS_ADVANCED_WRITE_FAILED with the exit code", () => {
    expect(translateSshError("SSH_USERS_ADVANCED_WRITE_FAILED|1", mockT)).toBe(
      'sshErrors.usersAdvancedWriteFailed:{"code":"1"}',
    );
  });

  // ─── Service operations ───
  it("translates SSH_SERVICE_RESTART_FAILED without params", () => {
    expect(translateSshError("SSH_SERVICE_RESTART_FAILED", mockT)).toBe("sshErrors.serviceRestartFailed");
  });

  it("translates SSH_SERVICE_STOP_FAILED without params", () => {
    expect(translateSshError("SSH_SERVICE_STOP_FAILED", mockT)).toBe("sshErrors.serviceStopFailed");
  });

  it("translates SSH_SERVICE_START_FAILED without params", () => {
    expect(translateSshError("SSH_SERVICE_START_FAILED", mockT)).toBe("sshErrors.serviceStartFailed");
  });

  // 06-14 C-07: deploy_check_env emits this instead of raw English.
  it("translates SSH_ROOT_REQUIRED without params (C-07)", () => {
    expect(translateSshError("SSH_ROOT_REQUIRED", mockT)).toBe("sshErrors.rootRequired");
  });

  // ─── User operations ───
  it("translates SSH_ADD_USER_FAILED without params", () => {
    expect(translateSshError("SSH_ADD_USER_FAILED", mockT)).toBe("sshErrors.addUserFailed");
  });

  it("translates SSH_DELETE_USER_FAILED without params", () => {
    expect(translateSshError("SSH_DELETE_USER_FAILED", mockT)).toBe("sshErrors.deleteUserFailed");
  });

  // 06-14 C-07: server_install emits SSH_USER_ALREADY_EXISTS|{username}.
  it("translates SSH_USER_ALREADY_EXISTS with the username (C-07)", () => {
    expect(translateSshError("SSH_USER_ALREADY_EXISTS|alice", mockT)).toBe(
      'sshErrors.userAlreadyExists:{"user":"alice"}',
    );
  });

  // 06-14 C-07: add-user emits this when credentials.toml is missing.
  it("translates SSH_CREDENTIALS_NOT_FOUND without params (C-07)", () => {
    expect(translateSshError("SSH_CREDENTIALS_NOT_FOUND", mockT)).toBe("sshErrors.credentialsNotFound");
  });

  // ─── Config operations ───
  it("translates SSH_CONFIG_CREATE_FAILED without params", () => {
    expect(translateSshError("SSH_CONFIG_CREATE_FAILED", mockT)).toBe("sshErrors.configCreateFailed");
  });

  it("translates SSH_CONFIG_DIVERGES (marker carries fname) to a friendly RU string (C-05)", () => {
    // The marker shape is `SSH_CONFIG_DIVERGES|{fname}|{reason}`; the friendly string
    // ignores parts[1] (fname) so the user never sees the raw English.
    expect(
      translateSshError("SSH_CONFIG_DIVERGES|vpn.toml|existing server config differs", mockT)
    ).toBe("sshErrors.configDiverges");
  });

  // 06-14 C-06: deploy_configure preserves the port-80-busy marker as this code.
  it("translates SSH_CERTBOT_PORT80_BUSY without params (C-06)", () => {
    expect(translateSshError("SSH_CERTBOT_PORT80_BUSY", mockT)).toBe("sshErrors.certbotPort80Busy");
  });

  // 06-14 C-07: cert-verification failure no longer leaks raw English.
  it("translates SSH_CERT_NOT_CREATED without params (C-07)", () => {
    expect(translateSshError("SSH_CERT_NOT_CREATED", mockT)).toBe("sshErrors.certNotCreated");
  });

  it("translates SSH_READ_CONFIG_FAILED without params", () => {
    expect(translateSshError("SSH_READ_CONFIG_FAILED", mockT)).toBe("sshErrors.readConfigFailed");
  });

  it("translates SSH_WRITE_CONFIG_FAILED with detail", () => {
    expect(translateSshError("SSH_WRITE_CONFIG_FAILED|disk full", mockT)).toBe(
      'sshErrors.writeConfigFailed:{"detail":"disk full"}',
    );
  });

  it("translates SSH_ENDPOINT_CONFIG_ERROR with detail", () => {
    expect(translateSshError("SSH_ENDPOINT_CONFIG_ERROR|invalid port", mockT)).toBe(
      'sshErrors.endpointConfigError:{"detail":"invalid port"}',
    );
  });

  // ─── Phase 25 / WR-01: the four `fetch_server_config` exits that had NO code ───
  //
  // Each of these used to return a bare English sentence, so neither translator could
  // recognise it and the Users-tab download snackbar showed English prose. These pin the
  // code → key mapping; UserConfigModal.test.tsx proves the real Russian copy reaches the
  // snackbar through the actual download door.
  it("translates SSH_ENDPOINT_NOT_INSTALLED and drops the server path detail", () => {
    // The binary path rides along on the wire (the activity log keeps it) but is NOT
    // interpolated — an absolute server path is noise to a non-technical reader.
    expect(
      translateSshError(
        "SSH_ENDPOINT_NOT_INSTALLED|/opt/trusttunnel/trusttunnel_endpoint",
        mockT,
      ),
    ).toBe("sshErrors.endpointNotInstalled");
  });

  it("translates SSH_ENDPOINT_CONFIG_MISSING (no detail on the wire)", () => {
    expect(translateSshError("SSH_ENDPOINT_CONFIG_MISSING", mockT)).toBe(
      "sshErrors.endpointConfigMissing",
    );
  });

  it("translates SSH_USER_NOT_IN_CREDENTIALS carrying BOTH details", () => {
    expect(
      translateSshError("SSH_USER_NOT_IN_CREDENTIALS|carol|alice, bob", mockT),
    ).toBe('sshErrors.userNotInCredentials:{"user":"carol","users":"alice, bob"}');
  });

  it("SSH_USER_NOT_IN_CREDENTIALS keeps the whole available list past an embedded separator", () => {
    // The list comes from the server's credentials.toml, which this app does not control.
    // A `split("|")[2]` would hand the user a TRUNCATED list of names to choose from —
    // exactly the field they need complete. Rejoining past the second separator keeps it.
    expect(
      translateSshError("SSH_USER_NOT_IN_CREDENTIALS|carol|alice, od|d, bob", mockT),
    ).toBe('sshErrors.userNotInCredentials:{"user":"carol","users":"alice, od|d, bob"}');
  });

  it("translates SSH_CLIENT_NAME_INVALID with the refused name", () => {
    expect(translateSshError("SSH_CLIENT_NAME_INVALID|bad?name", mockT)).toBe(
      'sshErrors.clientNameInvalid:{"user":"bad?name"}',
    );
  });

  // ─── Export ───
  it("translates SSH_EXPORT_FAILED with 1 param to exportFailed", () => {
    expect(translateSshError("SSH_EXPORT_FAILED|42", mockT)).toBe(
      'sshErrors.exportFailed:{"code":"42"}',
    );
  });

  it("translates SSH_EXPORT_FAILED with 2 params to exportFailedUsers", () => {
    expect(translateSshError("SSH_EXPORT_FAILED|42|alice,bob", mockT)).toBe(
      'sshErrors.exportFailedUsers:{"code":"42","users":"alice,bob"}',
    );
  });

  it("translates SSH_DEEPLINK_EXPORT_FAILED with code and user", () => {
    expect(translateSshError("SSH_DEEPLINK_EXPORT_FAILED|99|alice", mockT)).toBe(
      'sshErrors.deeplinkExportFailed:{"code":"99","user":"alice"}',
    );
  });

  // ─── Install / Uninstall ───
  // 06-14 C-14: a held dpkg lock during update is surfaced as a recoverable code.
  it("translates SSH_DPKG_LOCKED without params (C-14)", () => {
    expect(translateSshError("SSH_DPKG_LOCKED", mockT)).toBe("sshErrors.dpkgLocked");
  });

  it("translates SSH_UNINSTALL_FAILED with code", () => {
    expect(translateSshError("SSH_UNINSTALL_FAILED|127", mockT)).toBe(
      'sshErrors.uninstallFailed:{"code":"127"}',
    );
  });

  it("translates SSH_PACKAGE_DOWNLOAD_FAILED (server DNS/network)", () => {
    expect(translateSshError("SSH_PACKAGE_DOWNLOAD_FAILED", mockT)).toBe(
      "sshErrors.packageDownloadFailed",
    );
  });

  it("translates SSH_INSTALL_FAILED with code (was raw «Installation failed (code N)»)", () => {
    expect(translateSshError("SSH_INSTALL_FAILED|1", mockT)).toBe(
      'sshErrors.installFailed:{"code":"1"}',
    );
  });

  it("translates SSH_DEPLOY_IN_PROGRESS (previously shown as raw English)", () => {
    expect(
      translateSshError("SSH_DEPLOY_IN_PROGRESS|another install is already running", mockT),
    ).toBe("sshErrors.deployInProgress");
  });

  it("translates SSH_DEPLOY_CANCELLED", () => {
    expect(translateSshError("SSH_DEPLOY_CANCELLED|superseded", mockT)).toBe(
      "sshErrors.deployCancelled",
    );
  });

  it("translates SSH_CERT_RENEW_FAILED with code", () => {
    expect(translateSshError("SSH_CERT_RENEW_FAILED|1", mockT)).toBe(
      'sshErrors.certRenewFailed:{"code":"1"}',
    );
  });

  // ─── Other ───
  it("translates SSH_MKDIR_FAILED with detail", () => {
    expect(translateSshError("SSH_MKDIR_FAILED|permission denied", mockT)).toBe(
      'sshErrors.mkdirFailed:{"detail":"permission denied"}',
    );
  });

  it("translates SSH_KILL_PROCESS_FAILED with detail", () => {
    expect(translateSshError("SSH_KILL_PROCESS_FAILED|no such process", mockT)).toBe(
      'sshErrors.killProcessFailed:{"detail":"no such process"}',
    );
  });

  // ─── Fallback / edge cases ───
  it("returns raw string for unknown code", () => {
    expect(translateSshError("UNKNOWN_ERROR|something", mockT)).toBe("UNKNOWN_ERROR|something");
  });

  it("returns empty string for empty input", () => {
    expect(translateSshError("", mockT)).toBe("");
  });

  it("returns string as-is when no pipe separator", () => {
    expect(translateSshError("some plain error text", mockT)).toBe("some plain error text");
  });

  // ─── Network (Phase 12.5) ───
  it("translates SSH_DNS_FAILED with host", () => {
    expect(translateSshError("SSH_DNS_FAILED|example.com", mockT)).toBe(
      'sshErrors.dnsFailed:{"host":"example.com"}',
    );
  });

  it("translates SSH_NETWORK_UNREACHABLE with host", () => {
    expect(translateSshError("SSH_NETWORK_UNREACHABLE|10.0.0.1", mockT)).toBe(
      'sshErrors.networkUnreachable:{"host":"10.0.0.1"}',
    );
  });

  it("translates SSH_CONNECTION_REFUSED with host+port", () => {
    expect(translateSshError("SSH_CONNECTION_REFUSED|localhost|22", mockT)).toBe(
      'sshErrors.connectionRefused:{"host":"localhost","port":"22"}',
    );
  });

  it("translates SSH_TLS_HANDSHAKE_FAILED with host", () => {
    expect(translateSshError("SSH_TLS_HANDSHAKE_FAILED|example.com", mockT)).toBe(
      'sshErrors.tlsHandshakeFailed:{"host":"example.com"}',
    );
  });

  // ─── GeoIP (Phase 13) ───
  it("translates GEOIP_TIMEOUT without params", () => {
    expect(translateSshError("GEOIP_TIMEOUT", mockT)).toBe("geoipErrors.timeout");
  });

  it("translates GEOIP_NO_NETWORK without params", () => {
    expect(translateSshError("GEOIP_NO_NETWORK", mockT)).toBe(
      "geoipErrors.noNetwork",
    );
  });

  it("translates GEOIP_RATE_LIMITED without params", () => {
    expect(translateSshError("GEOIP_RATE_LIMITED", mockT)).toBe(
      "geoipErrors.rateLimited",
    );
  });

  it("translates GEOIP_INVALID_RESPONSE with detail", () => {
    expect(
      translateSshError("GEOIP_INVALID_RESPONSE|Reserved range", mockT),
    ).toBe('geoipErrors.invalidResponse:{"detail":"Reserved range"}');
  });

  // ─── K-3 / EW-02: raw russh detail must not lead the user-facing message ───
  // Rendered against the REAL i18n (RU) so we exercise the actual template, not
  // the mockT pass-through. The raw russh blob is kept (for diagnosis) but
  // demoted below a plain-RU headline, behind a «Подробности:» label — so it is
  // never the headline a non-technical user reads first.
  describe("K-3: raw SSH/russh detail is demoted, not the headline (RU)", () => {
    const RUSSH_BLOB =
      "Error in the protocol: KexInit { algorithms: Disconnect }";

    it.each([
      ["SSH_CONNECT_FAILED", "не удалось подключиться к серверу по ssh"],
      ["SSH_CHANNEL_FAILED", "не удалось открыть рабочий канал"],
      ["SSH_EXEC_FAILED", "команда на сервере завершилась с ошибкой"],
      ["SSH_AUTH_ERROR", "не удалось войти на сервер по ssh"],
      ["SSH_KEY_AUTH_ERROR", "сервер не принял ssh-ключ"],
    ])(
      "%s leads with a plain-RU headline and keeps the russh blob behind «Подробности»",
      (code, expectedHeadlineFragment) => {
        i18n.changeLanguage("ru");
        const msg = translateSshError(`${code}|${RUSSH_BLOB}`, i18n.t);

        const [headline, ...rest] = msg.split("\n\n");
        // The headline is plain RU, not the raw russh text.
        expect(headline.toLowerCase()).toContain(expectedHeadlineFragment);
        expect(headline).not.toContain(RUSSH_BLOB);
        // The raw blob is still available, but only under the «Подробности» label.
        const tail = rest.join("\n\n");
        expect(tail).toContain("Подробности");
        expect(tail).toContain(RUSSH_BLOB);
      },
    );
  });

  // ─── T-40: the codes closed by the sweep render as Russian, never as the code ───
  // Rendered against the REAL i18n so a missing/misspelled ru.json key fails here instead
  // of silently falling back to the key name. The symptom this guards is literal: the user
  // saw «SSH_KEY_REENTER_REQUIRED|file» in a red plate.
  describe("T-40: newly covered codes never surface as a bare machine string (RU)", () => {
    it.each([
      "SSH_KEY_REENTER_REQUIRED|file",
      "SSH_KEY_REENTER_REQUIRED|pasted",
      "SSH_KEY_REENTER_REQUIRED|missing",
      "SSH_KEY_REENTER_REQUIRED|unknown-future-tag",
      "SSH_PASSWORD_REJECTED",
      "SSH_INVALID_HOST|SSH host contains invalid characters",
      "SSH_INVALID_USER|SSH user contains invalid characters",
      "SSH_INVALID_AUTH_METHOD|Invalid auth_method 'both' (allowed: password, key)",
      "SSH_EXPORT_INVALID_HOST|SSH host contains invalid characters",
      "SSH_ROTATE_USER_NOT_FOUND",
      "SSH_RULES_WRITE_FAILED|1",
      "SSH_UPDATE_CONFIG_FAILED|1",
      "SSH_USERS_ADVANCED_WRITE_FAILED|1",
    ])("%s renders as Russian prose", (raw) => {
      i18n.changeLanguage("ru");
      const msg = translateSshError(raw, i18n.t);

      expect(msg).not.toBe(raw);
      // Neither the code itself nor an untranslated i18n key path.
      expect(msg).not.toMatch(/SSH_[A-Z_]+/);
      expect(msg).not.toMatch(/^sshErrors\./);
      // Cyrillic present ⇒ the RU template really resolved.
      expect(msg).toMatch(/[А-Яа-я]/);
    });

    it("keeps the English validator prose out of the four validator messages", () => {
      i18n.changeLanguage("ru");
      const cases: [string, string][] = [
        ["SSH_INVALID_HOST|SSH host contains invalid characters", "invalid characters"],
        ["SSH_INVALID_USER|SSH user must be 1-64 characters", "1-64"],
        ["SSH_INVALID_AUTH_METHOD|Invalid auth_method 'both' (allowed: password, key)", "both"],
        ["SSH_EXPORT_INVALID_HOST|SSH host has mismatched IPv6 brackets", "mismatched"],
      ];
      for (const [raw, leak] of cases) {
        expect(translateSshError(raw, i18n.t)).not.toContain(leak);
      }
    });

    // T-41(b): every caller normalizes through `formatError` first, so its English
    // fallback for a non-Error/non-string throw arrives here verbatim and used to be
    // shown to the user as-is. It is now claimed as a case.
    it("localizes formatError's English fallback instead of passing it through", () => {
      i18n.changeLanguage("ru");
      const msg = translateSshError(formatError({ unexpected: true }), i18n.t);

      expect(msg).toBe(i18n.t("commonErrors.unknown"));
      expect(msg).toMatch(/[А-Яа-я]/);
      expect(msg).not.toContain(UNKNOWN_ERROR_FALLBACK);
      expect(msg).not.toMatch(/^commonErrors\./);
    });
  });
});
