import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsState } from "./useSettingsState";
import type { SettingsProps, ClientConfig } from "./useSettingsState";
import { hookWrapper as wrapper } from "../../test/test-utils";

const mockedInvoke = vi.mocked(invoke);
const mockedOpen = vi.mocked(open);

const fakeConfig: ClientConfig = {
  loglevel: "info",
  vpn_mode: "tun",
  killswitch_enabled: false,
  post_quantum_group_enabled: false,
  endpoint: {
    hostname: "vpn.example.com:443",
    addresses: ["1.2.3.4"],
    upstream_protocol: "tcp",
    anti_dpi: false,
    skip_verification: false,
    custom_sni: "",
    has_ipv6: false,
    username: "user",
    password: "pass",
  },
  listener: {
    tun: {
      mtu_size: 1400,
      change_system_dns: true,
      included_routes: [],
      excluded_routes: [],
    },
  },
};

function makeProps(overrides: Partial<SettingsProps> = {}): SettingsProps {
  return {
    configPath: "/path/to/config.toml",
    onConfigChange: vi.fn(),
    status: "disconnected",
    onReconnect: vi.fn().mockResolvedValue(undefined),
    onSwitchToSetup: vi.fn(),
    onClearConfig: vi.fn(),
    ...overrides,
  };
}

describe("useSettingsState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockedInvoke.mockResolvedValue(null as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Initial state ───
  it("has initial state with null config and loading (config is null before load completes)", () => {
    mockedInvoke.mockImplementation(() => new Promise(() => {})); // never resolves

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    expect(result.current.config).toBeNull();
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBe("");
    expect(result.current.dirty).toBe(false);
    // successQueue removed; messages now go via useSnackBar
  });

  // ─── Load config ───
  it("loads config via invoke read_client_config, populates config", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(mockedInvoke).toHaveBeenCalledWith("read_client_config", {
      configPath: "/path/to/config.toml",
    });
    expect(result.current.config).toEqual(fakeConfig);
    expect(result.current.dirty).toBe(false);
  });

  // ─── updateField ───
  it("updateField updates nested config and sets dirty=true", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.dirty).toBe(false);

    act(() => {
      result.current.updateField("endpoint.hostname", "new.host:8443");
    });

    expect(result.current.config!.endpoint.hostname).toBe("new.host:8443");
    expect(result.current.dirty).toBe(true);
  });

  // ─── handleSave ───
  it("handleSave calls invoke save_client_config and resets dirty", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      if (cmd === "save_client_config") return null as never;
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Make dirty
    act(() => {
      result.current.updateField("loglevel", "debug");
    });
    expect(result.current.dirty).toBe(true);

    // Save
    await act(async () => {
      await result.current.handleSave();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(mockedInvoke).toHaveBeenCalledWith(
      "save_client_config",
      expect.objectContaining({
        configPath: "/path/to/config.toml",
      }),
    );
    // dirty resets because savedConfig.current is updated to match config
    expect(result.current.saving).toBe(false);
    // Success message now goes via useSnackBar
  });

  // ─── Save error ───
  it("save error populates error state", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      if (cmd === "save_client_config") throw new Error("write failed");
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.updateField("loglevel", "trace");
    });

    await act(async () => {
      await result.current.handleSave();
    });

    // Error is now pushed via useSnackBar
    expect(result.current.saving).toBe(false);
  });

  // ─── Auto-save when VPN not active ───
  it("auto-saves after 1200ms when dirty and VPN not active", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      if (cmd === "save_client_config") return null as never;
      return null as never;
    });

    const props = makeProps({ status: "disconnected" });
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Make dirty
    act(() => {
      result.current.updateField("loglevel", "debug");
    });
    expect(result.current.dirty).toBe(true);

    // Advance past auto-save delay
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1300);
      await vi.runAllTimersAsync();
    });

    // save_client_config should have been called by the silent auto-save
    const saveCalls = mockedInvoke.mock.calls.filter(
      (call) => call[0] === "save_client_config",
    );
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Auto-save blocked when VPN active ───
  it("does not auto-save when VPN is connected", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      if (cmd === "save_client_config") return null as never;
      return null as never;
    });

    const props = makeProps({ status: "connected" });
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.updateField("loglevel", "debug");
    });
    expect(result.current.dirty).toBe(true);

    // Advance past auto-save delay
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // save_client_config should NOT have been called
    const saveCalls = mockedInvoke.mock.calls.filter(
      (call) => call[0] === "save_client_config",
    );
    expect(saveCalls.length).toBe(0);
    // Still dirty
    expect(result.current.dirty).toBe(true);
  });

  // ─── browseConfig ───
  it("browseConfig calls dialog open and updates localPath", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      if (cmd === "copy_config_to_app_dir") return "/new/copied/path.toml" as never;
      return null as never;
    });
    mockedOpen.mockResolvedValue("/selected/file.toml" as never);

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    await act(async () => {
      await result.current.browseConfig();
    });

    expect(mockedOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: false,
        filters: [{ name: "TOML Config", extensions: ["toml"] }],
      }),
    );
    expect(result.current.localPath).toBe("/new/copied/path.toml");
  });

  // ─── clearConfig ───
  // 06-uat: clearing the config must NOT auto-switch to the Control Panel — clearConfig
  // only calls onClearConfig, never onSwitchToSetup. Deleting the config no longer
  // navigates or opens the wizard.
  it("clearConfig calls onClearConfig only (does NOT call onSwitchToSetup)", async () => {
    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.clearConfig();
    });

    expect(props.onClearConfig).toHaveBeenCalledTimes(1);
    expect(props.onSwitchToSetup).not.toHaveBeenCalled();
  });

  // ─── pushSuccess delegates to SnackBar ───
  it("pushSuccess is a function (delegates to useSnackBar)", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(typeof result.current.pushSuccess).toBe("function");
  });

  // ─── DNS upstreams under endpoint (UAT-F05/F06/F07) ───

  // F05/F07: adding an empty DNS row must NOT mark the form dirty (Save stays inactive)
  // until a non-empty value is typed. The deepEqual diff filters empty strings from arrays,
  // so [..., ""] equals the baseline.
  it("adding an empty endpoint.dns_upstreams row does not make dirty (F05/F07)", async () => {
    const cfgWithDns: ClientConfig = {
      ...fakeConfig,
      endpoint: { ...fakeConfig.endpoint, dns_upstreams: ["1.1.1.1"] },
    };
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return cfgWithDns as never;
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.dirty).toBe(false);

    // Add an empty row — like clicking "Add DNS"
    act(() => {
      result.current.updateField("endpoint.dns_upstreams", ["1.1.1.1", ""]);
    });

    expect(result.current.dirty).toBe(false);
  });

  // WR-01 (regression): a config with NO prior endpoint.dns_upstreams key.
  // Clicking "Add DNS" adds an empty row, which ADDS the key to the endpoint
  // object (N → N+1 keys). The deepEqual object-branch key-count guard
  // (aKeys.length !== bKeys.length) previously flipped dirty=true even though
  // the only change is an empty, never-filled row — re-triggering the exact
  // UAT-F05/F07 symptom the migration removed. Empty array-keys must be pruned
  // before the key-count comparison so [""] is treated as absent.
  it("adding an empty DNS row on a config with NO prior dns_upstreams key does not make dirty (WR-01)", async () => {
    // fakeConfig.endpoint has NO dns_upstreams key — this is the common case.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.config!.endpoint.dns_upstreams).toBeUndefined();
    expect(result.current.dirty).toBe(false);

    // Click "Add DNS" — adds the key with a single empty row.
    act(() => {
      result.current.updateField("endpoint.dns_upstreams", [""]);
    });

    // Empty row only — must NOT light Save.
    expect(result.current.dirty).toBe(false);
  });

  // WR-01 (regression, positive path): on a no-prior-DNS config, typing a REAL
  // address must dirty, and reverting back to the baseline (removing the row /
  // clearing to empty) must clear dirty.
  it("on a no-prior-DNS config: a real DNS address dirties; reverting to baseline clears it (WR-01)", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.dirty).toBe(false);

    // Type a real value — must dirty.
    act(() => {
      result.current.updateField("endpoint.dns_upstreams", ["8.8.8.8"]);
    });
    expect(result.current.dirty).toBe(true);

    // Clear the row back to empty — equivalent to the (absent) baseline.
    act(() => {
      result.current.updateField("endpoint.dns_upstreams", [""]);
    });
    expect(result.current.dirty).toBe(false);
  });

  // F07: typing a value into the new row makes dirty true; clearing it back to the
  // original deactivates Save (true revert-to-clean dirty tracking).
  it("typing into a new DNS row dirties, reverting clears it (F07)", async () => {
    const cfgWithDns: ClientConfig = {
      ...fakeConfig,
      endpoint: { ...fakeConfig.endpoint, dns_upstreams: ["1.1.1.1"] },
    };
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return cfgWithDns as never;
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Type a real value into the second row
    act(() => {
      result.current.updateField("endpoint.dns_upstreams", ["1.1.1.1", "8.8.8.8"]);
    });
    expect(result.current.dirty).toBe(true);

    // Revert back to the original (remove the added row)
    act(() => {
      result.current.updateField("endpoint.dns_upstreams", ["1.1.1.1"]);
    });
    expect(result.current.dirty).toBe(false);
  });

  // F05/F07: saving writes the upstreams under endpoint.dns_upstreams and does NOT
  // emit a stray top-level dns_upstreams key (the saved file must match the sidecar contract).
  it("save writes dns_upstreams under endpoint, not as a top-level key (F05/F07)", async () => {
    const cfgWithDns: ClientConfig = {
      ...fakeConfig,
      endpoint: { ...fakeConfig.endpoint, dns_upstreams: ["1.1.1.1"] },
    };
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return cfgWithDns as never;
      if (cmd === "save_client_config") return null as never;
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.updateField("endpoint.dns_upstreams", ["1.1.1.1", "8.8.8.8"]);
    });

    await act(async () => {
      await result.current.handleSave();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const saveCall = mockedInvoke.mock.calls.find((c) => c[0] === "save_client_config");
    expect(saveCall).toBeDefined();
    const savedConfig = (saveCall![1] as { config: ClientConfig }).config;
    expect(savedConfig.endpoint.dns_upstreams).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect("dns_upstreams" in savedConfig).toBe(false);
  });

  // F06: a legacy config with a top-level dns_upstreams but none under endpoint gets
  // migrated into endpoint on load, and is NOT re-emitted as a top-level key on save.
  it("migrates a legacy top-level dns_upstreams into endpoint on load, drops it on save (F06)", async () => {
    const legacyCfg = {
      ...fakeConfig,
      dns_upstreams: ["9.9.9.9"],
    } as ClientConfig;
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return legacyCfg as never;
      if (cmd === "save_client_config") return null as never;
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Migrated into endpoint on load
    expect(result.current.config!.endpoint.dns_upstreams).toEqual(["9.9.9.9"]);
    // No stray top-level key after migration
    expect("dns_upstreams" in result.current.config!).toBe(false);
    // Migration alone must not dirty the form
    expect(result.current.dirty).toBe(false);

    // Make a change and save — saved shape must not carry a top-level key
    act(() => {
      result.current.updateField("endpoint.dns_upstreams", ["9.9.9.9", "1.1.1.1"]);
    });
    await act(async () => {
      await result.current.handleSave();
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const saveCall = mockedInvoke.mock.calls.find((c) => c[0] === "save_client_config");
    const savedConfig = (saveCall![1] as { config: ClientConfig }).config;
    expect("dns_upstreams" in savedConfig).toBe(false);
    expect(savedConfig.endpoint.dns_upstreams).toEqual(["9.9.9.9", "1.1.1.1"]);
  });

  // ─── Load error ───
  it("sets error when config load fails", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") throw new Error("file not found");
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props), { wrapper });

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Error is now pushed via useSnackBar
    expect(result.current.config).toBeNull();
  });
});
