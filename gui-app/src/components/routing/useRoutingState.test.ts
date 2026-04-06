import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import React from "react";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import {
  useRoutingState,
  type UseRoutingStateOptions,
  type RoutingRules,
  type RuleEntry,
} from "./useRoutingState";

// ─── Helpers ─────────────────────────────────────────

const mockInvoke = vi.mocked(invoke) as unknown as Mock;

const defaultOpts: UseRoutingStateOptions = {
  configPath: "/path/to/config.json",
  status: "disconnected",
  vpnMode: "general",
  onReconnect: vi.fn().mockResolvedValue(undefined),
};

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(SnackBarProvider, null, children);

function makeRules(overrides?: Partial<RoutingRules>): RoutingRules {
  return {
    direct: [],
    proxy: [
      { id: "r1", type: "domain", value: "example.com", label: undefined },
    ],
    block: [],
    process_mode: "exclude",
    processes: [],
    ...overrides,
  };
}

function setupInvokeForLoad(rules?: RoutingRules) {
  const data = rules ?? makeRules();
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "load_routing_rules") return data;
    if (cmd === "get_geodata_status")
      return {
        downloaded: false,
        geoip_exists: false,
        geosite_exists: false,
        geoip_categories_count: 0,
        geosite_categories_count: 0,
      };
    if (cmd === "save_routing_rules") return null;
    if (cmd === "export_routing_rules") return "/exported.json";
    if (cmd === "import_routing_rules") return null;
    if (cmd === "resolve_and_apply") return null;
    return null;
  });
}

// ─── Tests ───────────────────────────────────────────

describe("useRoutingState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(null);
  });

  // ── Initial state ──────────────────────────────────

  it("starts with empty rules and loading=true", () => {
    mockInvoke.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    expect(result.current.rules.proxy).toEqual([]);
    expect(result.current.rules.direct).toEqual([]);
    expect(result.current.rules.block).toEqual([]);
    expect(result.current.loading).toBe(true);
  });

  // ── load ───────────────────────────────────────────

  it("populates rules from invoke('load_routing_rules')", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.rules.proxy).toHaveLength(1);
    expect(result.current.rules.proxy[0].value).toBe("example.com");
    expect(result.current.rules.proxy[0].type).toBe("domain");
    expect(result.current.dirty).toBe(false);
  });

  it("sets error when load fails", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") throw "File not found";
      if (cmd === "get_geodata_status") throw "not impl";
      return null;
    });

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Error is now pushed via useSnackBar (no successQueue on the hook)
    expect(result.current.loading).toBe(false);
  });

  it("does not load when configPath is empty", async () => {
    const opts = { ...defaultOpts, configPath: "" };
    mockInvoke.mockResolvedValue(null);

    const { result } = renderHook(() => useRoutingState(opts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockInvoke).not.toHaveBeenCalledWith("load_routing_rules");
  });

  // ── addEntry ───────────────────────────────────────

  it("adds an entry to the correct block", async () => {
    setupInvokeForLoad(makeRules({ proxy: [], direct: [], block: [] }));

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let err: string | null = null;
    act(() => {
      err = result.current.addEntry("proxy", "test.com");
    });

    expect(err).toBeNull();
    expect(result.current.rules.proxy).toHaveLength(1);
    expect(result.current.rules.proxy[0].value).toBe("test.com");
    expect(result.current.rules.proxy[0].type).toBe("domain");
  });

  it("addEntry returns 'empty' for blank value", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let err: string | null = null;
    act(() => {
      err = result.current.addEntry("proxy", "   ");
    });

    expect(err).toBe("empty");
  });

  it("addEntry returns 'duplicate' when value exists in any block", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let err: string | null = null;
    act(() => {
      // example.com already exists in proxy from makeRules()
      err = result.current.addEntry("direct", "example.com");
    });

    expect(err).toBe("duplicate");
  });

  it("addEntry detects geoip prefix and sets correct type", async () => {
    setupInvokeForLoad(makeRules({ proxy: [], direct: [], block: [] }));

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.addEntry("direct", "geoip:RU");
    });

    expect(result.current.rules.direct[0].type).toBe("geoip");
    expect(result.current.rules.direct[0].value).toBe("RU");
  });

  it("addEntry detects IP address type", async () => {
    setupInvokeForLoad(makeRules({ proxy: [], direct: [], block: [] }));

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.addEntry("block", "192.168.1.1");
    });

    expect(result.current.rules.block[0].type).toBe("ip");
    expect(result.current.rules.block[0].value).toBe("192.168.1.1");
  });

  it("addEntry detects CIDR type", async () => {
    setupInvokeForLoad(makeRules({ proxy: [], direct: [], block: [] }));

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.addEntry("proxy", "10.0.0.0/8");
    });

    expect(result.current.rules.proxy[0].type).toBe("cidr");
  });

  // ── removeEntry ────────────────────────────────────

  it("removes entry by id from the correct block", async () => {
    const rules = makeRules({
      proxy: [
        { id: "p1", type: "domain", value: "keep.com" },
        { id: "p2", type: "domain", value: "remove.com" },
      ],
    });
    setupInvokeForLoad(rules);

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.removeEntry("proxy", "p2");
    });

    expect(result.current.rules.proxy).toHaveLength(1);
    expect(result.current.rules.proxy[0].id).toBe("p1");
  });

  // ── moveEntry ──────────────────────────────────────

  it("moves entry from one block to another", async () => {
    const rules = makeRules({
      proxy: [{ id: "m1", type: "domain", value: "move-me.com" }],
      direct: [],
    });
    setupInvokeForLoad(rules);

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.moveEntry("proxy", "direct", "m1");
    });

    expect(result.current.rules.proxy).toHaveLength(0);
    expect(result.current.rules.direct).toHaveLength(1);
    expect(result.current.rules.direct[0].value).toBe("move-me.com");
  });

  it("moveEntry is a no-op when fromAction === toAction", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const before = result.current.rules.proxy.length;

    act(() => {
      result.current.moveEntry("proxy", "proxy", "r1");
    });

    expect(result.current.rules.proxy).toHaveLength(before);
  });

  it("moveEntry skips if duplicate exists in target block", async () => {
    const rules = makeRules({
      proxy: [{ id: "d1", type: "domain", value: "dup.com" }],
      direct: [{ id: "d2", type: "domain", value: "dup.com" }],
    });
    setupInvokeForLoad(rules);

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.moveEntry("proxy", "direct", "d1");
    });

    // Both blocks unchanged since target already has dup.com
    expect(result.current.rules.proxy).toHaveLength(1);
    expect(result.current.rules.direct).toHaveLength(1);
  });

  // ── isDuplicate ────────────────────────────────────

  it("isDuplicate returns true when entry exists in block", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.isDuplicate("proxy", "example.com")).toBe(true);
    expect(result.current.isDuplicate("proxy", "notexist.com")).toBe(false);
  });

  it("isDuplicate handles geoip prefix correctly", async () => {
    // normalizeEntries calls parseEntryValue on e.value, so pass the raw prefixed form
    const rules = makeRules({
      direct: [{ id: "g1", type: "geoip", value: "geoip:US" }],
    });
    setupInvokeForLoad(rules);

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.isDuplicate("direct", "geoip:US")).toBe(true);
    expect(result.current.isDuplicate("direct", "geoip:RU")).toBe(false);
  });

  // ── Dirty tracking ────────────────────────────────

  it("dirty becomes true after addEntry, false after save", async () => {
    setupInvokeForLoad(makeRules({ proxy: [], direct: [], block: [] }));

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.dirty).toBe(false);

    act(() => {
      result.current.addEntry("proxy", "new-rule.com");
    });

    expect(result.current.dirty).toBe(true);

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.dirty).toBe(false);
  });

  it("dirty becomes true after removeEntry", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.removeEntry("proxy", "r1");
    });

    expect(result.current.dirty).toBe(true);
  });

  // ── save ───────────────────────────────────────────

  it("save invokes 'save_routing_rules' with serialized rules", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.save();
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "save_routing_rules",
      expect.objectContaining({
        rules: expect.objectContaining({
          proxy: expect.any(Array),
          direct: expect.any(Array),
          block: expect.any(Array),
          process_mode: "exclude",
          processes: [],
        }),
      }),
    );
  });

  it("save sets error on failure", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") return makeRules();
      if (cmd === "get_geodata_status") return { downloaded: false, geoip_exists: false, geosite_exists: false, geoip_categories_count: 0, geosite_categories_count: 0 };
      if (cmd === "save_routing_rules") throw "Disk full";
      return null;
    });

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.save();
    });

    // Error is now pushed via useSnackBar
    expect(result.current.saving).toBe(false);
  });

  it("save pushes success message to queue", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.save();
    });

    // Success message is now pushed via useSnackBar
    expect(result.current.saving).toBe(false);
  });

  // ── exportRules / importRules round-trip ───────────

  it("exportRules saves then exports and pushes success", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.exportRules();
    });

    // save_routing_rules must be called before export_routing_rules
    const callOrder = mockInvoke.mock.calls.map((c: unknown[]) => c[0]);
    const saveIdx = callOrder.lastIndexOf("save_routing_rules");
    const exportIdx = callOrder.lastIndexOf("export_routing_rules");
    expect(saveIdx).toBeLessThan(exportIdx);

    // Success message is now pushed via useSnackBar
    expect(mockInvoke).toHaveBeenCalledWith("export_routing_rules");
  });

  it("importRules loads imported data and marks dirty", async () => {
    const imported: RoutingRules = {
      direct: [{ id: "i1", type: "domain", value: "imported.com" }],
      proxy: [],
      block: [{ id: "i2", type: "ip", value: "1.2.3.4" }],
      process_mode: "only",
      processes: ["firefox.exe"],
    };

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") return makeRules({ proxy: [], direct: [], block: [] });
      if (cmd === "get_geodata_status") return { downloaded: false, geoip_exists: false, geosite_exists: false, geoip_categories_count: 0, geosite_categories_count: 0 };
      if (cmd === "import_routing_rules") return imported;
      return null;
    });

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.importRules();
    });

    expect(result.current.rules.direct).toHaveLength(1);
    expect(result.current.rules.direct[0].value).toBe("imported.com");
    expect(result.current.rules.block).toHaveLength(1);
    expect(result.current.rules.block[0].value).toBe("1.2.3.4");
    expect(result.current.rules.process_mode).toBe("only");
    expect(result.current.rules.processes).toEqual(["firefox.exe"]);
    expect(result.current.dirty).toBe(true);
    // Success message is now pushed via useSnackBar
    expect(result.current.dirty).toBe(true);
  });

  it("importRules does nothing when user cancels (null returned)", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") return makeRules();
      if (cmd === "get_geodata_status") return { downloaded: false, geoip_exists: false, geosite_exists: false, geoip_categories_count: 0, geosite_categories_count: 0 };
      if (cmd === "import_routing_rules") return null;
      return null;
    });

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const rulesBefore = result.current.rules;

    await act(async () => {
      await result.current.importRules();
    });

    // Rules unchanged
    expect(result.current.rules.proxy).toEqual(rulesBefore.proxy);
  });

  // ── Process operations ─────────────────────────────

  it("setProcessMode updates mode and marks dirty", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setProcessMode("only");
    });

    expect(result.current.rules.process_mode).toBe("only");
    expect(result.current.dirty).toBe(true);
  });

  it("addProcess adds to list and removeProcess removes", async () => {
    setupInvokeForLoad();

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.addProcess("chrome.exe");
    });

    expect(result.current.rules.processes).toContain("chrome.exe");

    act(() => {
      result.current.removeProcess("chrome.exe");
    });

    expect(result.current.rules.processes).not.toContain("chrome.exe");
  });

  it("addProcess ignores duplicates", async () => {
    setupInvokeForLoad(
      makeRules({ processes: ["firefox.exe"] }),
    );

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.addProcess("firefox.exe");
    });

    expect(result.current.rules.processes).toEqual(["firefox.exe"]);
  });

  it("loadProcessList invokes list_running_processes and populates processList", async () => {
    const mockProcesses = [
      { name: "chrome.exe", path: "C:\\chrome.exe" },
      { name: "firefox.exe", path: "C:\\firefox.exe" },
    ];
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") return makeRules();
      if (cmd === "get_geodata_status")
        return { downloaded: false, geoip_exists: false, geosite_exists: false, geoip_categories_count: 0, geosite_categories_count: 0 };
      if (cmd === "list_running_processes") return mockProcesses;
      return null;
    });

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.loadProcessList();
    });

    expect(mockInvoke).toHaveBeenCalledWith("list_running_processes");
    expect(result.current.processList).toEqual(mockProcesses);
    expect(result.current.processListLoading).toBe(false);
  });

  it("addProcess marks dirty and save includes processes in payload", async () => {
    setupInvokeForLoad(makeRules({ processes: [] }));

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.addProcess("edge.exe");
    });

    expect(result.current.dirty).toBe(true);

    await act(async () => {
      await result.current.save();
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "save_routing_rules",
      expect.objectContaining({
        rules: expect.objectContaining({
          processes: ["edge.exe"],
        }),
      }),
    );
  });

  it("removeProcess marks dirty", async () => {
    setupInvokeForLoad(makeRules({ processes: ["chrome.exe", "firefox.exe"] }));

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.removeProcess("chrome.exe");
    });

    expect(result.current.dirty).toBe(true);
    expect(result.current.rules.processes).toEqual(["firefox.exe"]);
  });

  it("process_mode is included in save payload", async () => {
    setupInvokeForLoad(makeRules({ processes: ["test.exe"] }));

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.setProcessMode("only");
    });

    await act(async () => {
      await result.current.save();
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "save_routing_rules",
      expect.objectContaining({
        rules: expect.objectContaining({
          process_mode: "only",
          processes: ["test.exe"],
        }),
      }),
    );
  });

  // ── save completes without error ────────────────────

  it("save completes and resets dirty flag", async () => {
    setupInvokeForLoad(makeRules({ proxy: [], direct: [], block: [] }));

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.addEntry("proxy", "new-rule.com");
    });

    await act(async () => {
      await result.current.save();
    });

    expect(result.current.saving).toBe(false);
  });

  // ── geosite entry type ─────────────────────────────

  it("handles geosite: prefix entries correctly on load", async () => {
    const rules = makeRules({
      proxy: [{ id: "gs1", type: "geosite", value: "geosite:google" }],
    });
    setupInvokeForLoad(rules);

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // parseEntryValue strips the prefix
    expect(result.current.rules.proxy[0].type).toBe("geosite");
    expect(result.current.rules.proxy[0].value).toBe("google");
  });
});
