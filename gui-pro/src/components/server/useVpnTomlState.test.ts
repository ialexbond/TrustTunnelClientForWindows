import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useVpnTomlState, type SshParamsLite } from "./useVpnTomlState";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// Stable `log` reference — `useActivityLog` is invoked on every render and a
// fresh object literal would force `loadBundle` (useCallback) to re-create,
// which would re-trigger the bundle-load useEffect and produce an infinite
// render loop in tests. Module-level `vi.fn()` keeps the reference stable.
const stableLog = vi.fn();
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: stableLog }),
}));

const mockSshParams: SshParamsLite = {
  host: "192.168.1.100",
  port: 22,
  user: "root",
  password: "secret",
};

const SAMPLE_BUNDLE = {
  vpnToml: 'listen_address = "0.0.0.0:443"\n',
  hostsToml: '[[main_hosts]]\nhostname = "example.com"\n',
  typed: {
    listen_address: "0.0.0.0:443",
    ipv6_available: true,
    allow_private_network_connections: false,
    log_level: "info",
    auth_failure_status_code: 407,
    ping_enable: false,
    speedtest_enable: false,
    ping_path: "/ping",
    speedtest_path: "/speedtest",
    credentials_file: "credentials.toml",
    extra: {},
  },
  allowedSni: [{ hostname: "example.com", allowedSni: ["cdn.example.com"] }],
  serviceStatus: "active",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useVpnTomlState", () => {
  it("invokes server_get_config_bundle once on mount", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    const { result } = renderHook(() => useVpnTomlState(mockSshParams));
    await waitFor(() => expect(result.current.loading).toBe(false));
    const bundleCalls = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "server_get_config_bundle");
    expect(bundleCalls).toHaveLength(1);
    expect(result.current.fields.listen_address).toBe("0.0.0.0:443");
    expect(result.current.serviceStatus).toBe("active");
    expect(result.current.allowedSni).toHaveLength(1);
  });

  it("starts with loading=true, transitions to false after resolve", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    const { result } = renderHook(() => useVpnTomlState(mockSshParams));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
  });

  it("sets error string on bundle load failure", async () => {
    vi.mocked(invoke).mockRejectedValue("SSH_TIMEOUT");
    const { result } = renderHook(() => useVpnTomlState(mockSshParams));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("SSH_TIMEOUT");
  });

  it("isDirty=false initially after successful load", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    const { result } = renderHook(() => useVpnTomlState(mockSshParams));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isDirty).toBe(false);
    expect(result.current.dirtyFields).toEqual([]);
    expect(result.current.highRiskCount).toBe(0);
  });

  it("setField marks dirty correctly", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    const { result } = renderHook(() => useVpnTomlState(mockSshParams));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setField("listen_address", "0.0.0.0:8443"));
    expect(result.current.isDirty).toBe(true);
    expect(result.current.dirtyFields).toContain("listen_address");
    expect(result.current.fields.listen_address).toBe("0.0.0.0:8443");
  });

  it("highRiskCount counts disrupt-high fields only", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    const { result } = renderHook(() => useVpnTomlState(mockSshParams));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      result.current.setField("listen_address", "0.0.0.0:8443");
      result.current.setField("log_level", "debug");
    });
    expect(result.current.dirtyFields).toHaveLength(2);
    // listen_address is disrupt-high; log_level is disrupt-low
    expect(result.current.highRiskCount).toBe(1);
  });

  it("saveBatch invokes per-field mutations sequentially then refetches", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    const { result } = renderHook(() => useVpnTomlState(mockSshParams));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      result.current.setField("listen_address", "0.0.0.0:8443");
      result.current.setField("log_level", "debug");
    });
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValueOnce(null); // first mutation
    vi.mocked(invoke).mockResolvedValueOnce(null); // second mutation
    vi.mocked(invoke).mockResolvedValueOnce({
      ...SAMPLE_BUNDLE,
      typed: {
        ...SAMPLE_BUNDLE.typed,
        listen_address: "0.0.0.0:8443",
        log_level: "debug",
      },
    });
    await act(async () => {
      await result.current.saveBatch();
    });
    const cmdSequence = vi.mocked(invoke).mock.calls.map((c) => c[0]);
    expect(cmdSequence).toEqual([
      "server_update_listen_address",
      "server_update_log_level",
      "server_get_config_bundle",
    ]);
  });

  it("re-baselines snapshot on full save success (isDirty=false after)", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    const { result } = renderHook(() => useVpnTomlState(mockSshParams));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setField("log_level", "debug"));
    expect(result.current.isDirty).toBe(true);
    vi.mocked(invoke).mockResolvedValueOnce(null);
    vi.mocked(invoke).mockResolvedValueOnce({
      ...SAMPLE_BUNDLE,
      typed: { ...SAMPLE_BUNDLE.typed, log_level: "debug" },
    });
    await act(async () => {
      await result.current.saveBatch();
    });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.dirtyFields).toEqual([]);
  });

  it("partial save failure leaves dirty banner (re-throws + sets error)", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    const { result } = renderHook(() => useVpnTomlState(mockSshParams));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => result.current.setField("log_level", "debug"));
    vi.mocked(invoke).mockRejectedValueOnce(
      "VPN_TOML_WRITE_FAILED|log_level|code=1",
    );
    await act(async () => {
      await expect(result.current.saveBatch()).rejects.toBeTruthy();
    });
    expect(result.current.isDirty).toBe(true); // not re-baselined
    expect(result.current.error).toContain("VPN_TOML_WRITE_FAILED");
  });

  it("discard restores initial values and clears dirty", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    const { result } = renderHook(() => useVpnTomlState(mockSshParams));
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => {
      result.current.setField("listen_address", "0.0.0.0:8443");
      result.current.setField("log_level", "debug");
    });
    expect(result.current.isDirty).toBe(true);
    act(() => result.current.discard());
    expect(result.current.isDirty).toBe(false);
    expect(result.current.fields.listen_address).toBe("0.0.0.0:443");
    expect(result.current.fields.log_level).toBe("info");
  });

  it("exposes vpnTomlRaw and hostsTomlRaw from bundle", async () => {
    vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
    const { result } = renderHook(() => useVpnTomlState(mockSshParams));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.vpnTomlRaw).toContain("listen_address");
    expect(result.current.hostsTomlRaw).toContain("main_hosts");
  });
});
