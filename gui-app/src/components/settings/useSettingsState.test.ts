import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useSettingsState } from "./useSettingsState";
import type { SettingsProps, ClientConfig } from "./useSettingsState";

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
    const { result } = renderHook(() => useSettingsState(props));

    expect(result.current.config).toBeNull();
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBe("");
    expect(result.current.dirty).toBe(false);
    expect(result.current.successQueue).toEqual([]);
  });

  // ─── Load config ───
  it("loads config via invoke read_client_config, populates config", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props));

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
    const { result } = renderHook(() => useSettingsState(props));

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
    const { result } = renderHook(() => useSettingsState(props));

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

    expect(mockedInvoke).toHaveBeenCalledWith(
      "save_client_config",
      expect.objectContaining({
        configPath: "/path/to/config.toml",
      }),
    );
    expect(result.current.dirty).toBe(false);
    expect(result.current.saving).toBe(false);
    expect(result.current.successQueue.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Save error ───
  it("save error populates error state", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      if (cmd === "save_client_config") throw new Error("write failed");
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.updateField("loglevel", "trace");
    });

    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.successQueue).toContainEqual(
      expect.objectContaining({ text: "write failed", type: "error" }),
    );
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
    const { result } = renderHook(() => useSettingsState(props));

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
    });

    // save_client_config should have been called by the silent auto-save
    const saveCalls = mockedInvoke.mock.calls.filter(
      (call) => call[0] === "save_client_config",
    );
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.current.dirty).toBe(false);
  });

  // ─── Auto-save blocked when VPN active ───
  it("does not auto-save when VPN is connected", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      if (cmd === "save_client_config") return null as never;
      return null as never;
    });

    const props = makeProps({ status: "connected" });
    const { result } = renderHook(() => useSettingsState(props));

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
    const { result } = renderHook(() => useSettingsState(props));

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
  it("clearConfig calls onClearConfig and onSwitchToSetup", async () => {
    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.clearConfig();
    });

    expect(props.onClearConfig).toHaveBeenCalledTimes(1);
    expect(props.onSwitchToSetup).toHaveBeenCalledTimes(1);
  });

  // ─── successQueue ───
  it("pushSuccess adds to queue and shiftSuccess removes from front", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return fakeConfig as never;
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    act(() => {
      result.current.pushSuccess("msg1");
    });
    act(() => {
      result.current.pushSuccess("msg2");
    });

    // successQueue may already have status-change messages, so check our messages are present
    const queue = result.current.successQueue;
    expect(queue).toContainEqual(expect.objectContaining({ text: "msg1" }));
    expect(queue).toContainEqual(expect.objectContaining({ text: "msg2" }));

    act(() => {
      result.current.shiftSuccess();
    });

    // First element removed
    expect(result.current.successQueue[0]).not.toBe(queue[0]);
    expect(result.current.successQueue.length).toBe(queue.length - 1);
  });

  // ─── Load error ───
  it("sets error when config load fails", async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") throw new Error("file not found");
      return null as never;
    });

    const props = makeProps();
    const { result } = renderHook(() => useSettingsState(props));

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.successQueue).toContainEqual(
      expect.objectContaining({ text: "file not found", type: "error" }),
    );
    expect(result.current.config).toBeNull();
  });
});
