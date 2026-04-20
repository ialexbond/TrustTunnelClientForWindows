import { describe, it, expect } from "vitest";
import type { TFunction } from "i18next";
import { translateSshError } from "./translateSshError";

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

  // ─── User operations ───
  it("translates SSH_ADD_USER_FAILED without params", () => {
    expect(translateSshError("SSH_ADD_USER_FAILED", mockT)).toBe("sshErrors.addUserFailed");
  });

  it("translates SSH_DELETE_USER_FAILED without params", () => {
    expect(translateSshError("SSH_DELETE_USER_FAILED", mockT)).toBe("sshErrors.deleteUserFailed");
  });

  // ─── Config operations ───
  it("translates SSH_CONFIG_CREATE_FAILED without params", () => {
    expect(translateSshError("SSH_CONFIG_CREATE_FAILED", mockT)).toBe("sshErrors.configCreateFailed");
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
  it("translates SSH_UNINSTALL_FAILED with code", () => {
    expect(translateSshError("SSH_UNINSTALL_FAILED|127", mockT)).toBe(
      'sshErrors.uninstallFailed:{"code":"127"}',
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
});
