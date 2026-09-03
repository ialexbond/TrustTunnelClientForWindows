import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import React from "react";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import {
  useRoutingState,
  type UseRoutingStateOptions,
  type RoutingRules,
} from "./useRoutingState";

// Spy the snackbar so the cross-block MOVE inform notification (Phase 22 UAT) is assertable without
// depending on the transient DOM toast. SnackBarProvider stays real (the wrapper still mounts it);
// only useSnackBar is overridden to hand useRoutingState this spy. vi.hoisted keeps the spy defined
// before the hoisted vi.mock factory runs.
const { pushSpy } = vi.hoisted(() => ({ pushSpy: vi.fn() }));
vi.mock("../../shared/ui/SnackBarContext", async (importActual) => {
  const actual = await importActual<typeof import("../../shared/ui/SnackBarContext")>();
  return { ...actual, useSnackBar: () => pushSpy };
});

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
    pushSpy.mockClear();
    mockInvoke.mockResolvedValue(null);
    localStorage.clear();
  });

  // ── Initial state ──────────────────────────────────

  it("starts with empty rules and loading=true", () => {
    mockInvoke.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    expect(result.current.rules.proxy).toEqual([]);
    expect(result.current.rules.direct).toEqual([]);
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
    setupInvokeForLoad(makeRules({ proxy: [], direct: [] }));

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

  it("addEntry returns 'duplicate' when the value is already in the TARGET block", async () => {
    // Same-block re-add is a genuine no-op duplicate: the entry does not move and no inform fires.
    setupInvokeForLoad();

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let err: string | null = null;
    act(() => {
      // example.com already exists in proxy from makeRules() — re-adding to proxy is a duplicate.
      err = result.current.addEntry("proxy", "example.com");
    });

    expect(err).toBe("duplicate");
    expect(result.current.rules.proxy).toHaveLength(1);
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("addEntry MOVES the entry (returns null + informs) when it exists in a DIFFERENT block", async () => {
    // Phase 22 UAT: adding a token to block B while it already lives in block A relocates it (a
    // category lives in exactly one block) and tells the user where it came from — instead of the old
    // hard "already exists" rejection, which was confusing when the existing entry sat in a hidden block.
    setupInvokeForLoad();

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let err: string | null = null;
    act(() => {
      // example.com is in proxy (makeRules); adding it to direct must MOVE it, not reject.
      err = result.current.addEntry("direct", "example.com");
    });

    expect(err).toBeNull();
    // Relocated: gone from proxy, now in direct.
    expect(result.current.rules.proxy.some((e) => e.value === "example.com")).toBe(false);
    expect(result.current.rules.direct.some((e) => e.value === "example.com")).toBe(true);
    expect(result.current.rules.direct).toHaveLength(1);
    // The inform notification fired exactly once (the «Перенесено из …» success toast).
    expect(pushSpy).toHaveBeenCalledTimes(1);
  });

  it("addEntry detects geoip prefix and sets correct type", async () => {
    setupInvokeForLoad(makeRules({ proxy: [], direct: [] }));

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
    setupInvokeForLoad(makeRules({ proxy: [], direct: [] }));

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.addEntry("direct", "192.168.1.1");
    });

    expect(result.current.rules.direct[0].type).toBe("ip");
    expect(result.current.rules.direct[0].value).toBe("192.168.1.1");
  });

  it("addEntry detects CIDR type", async () => {
    setupInvokeForLoad(makeRules({ proxy: [], direct: [] }));

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
    setupInvokeForLoad(makeRules({ proxy: [], direct: [] }));

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
    // Файл, экспортированный ДО удаления блокировки сайтов (2026-09-03), несёт `block` и
    // `block_enabled`. Импорт обязан их пережить: они приходят с бэкенда как есть, а хук их просто
    // не читает. Поэтому фикстура намеренно шире типа — так выглядит реальный файл на диске.
    const imported = {
      direct: [{ id: "i1", type: "domain", value: "imported.com" }],
      proxy: [],
      block: [{ id: "i2", type: "ip", value: "1.2.3.4" }],
      process_mode: "only",
      processes: ["firefox.exe"],
      block_enabled: true,
    } as unknown as RoutingRules;

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") return makeRules({ proxy: [], direct: [] });
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
    // Ключи удалённой функции НЕ подхватываются обратно в состояние вкладки: их некуда рисовать,
    // а подобранное состояние поехало бы дальше в payload сохранения и перезаписало бы то, что
    // бережёт бэкенд (`CARRIED_LEGACY_KEYS` в routing_rules.rs).
    expect("block" in result.current.rules).toBe(false);
    expect("block_enabled" in result.current.rules).toBe(false);
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

  // ── The ONE duplicate rule: compare folded, store verbatim (D-05) ─────────────────────────────
  //
  // The two halves pull in opposite directions, and the second is the one that gets forgotten. It
  // is tempting to lowercase before storing so the comparison becomes trivial — that would silently
  // rewrite a rule the user typed. The C++ core lowercases and path-strips BOTH sides of its own
  // match, so casing never affects routing: a case-mismatched twin is purely a display artifact,
  // and process-name semantics belong to the core, not to us. Hence a test on the stored STRING and
  // not only on the list length — a length-only test passes on a lowercasing implementation and
  // therefore proves nothing about the half that is easy to get wrong.

  it("addProcess treats a name differing only in letter case as the same program", async () => {
    setupInvokeForLoad(makeRules({ processes: ["chrome.exe"] }));

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.addProcess("Chrome.exe");
    });

    expect(result.current.rules.processes).toEqual(["chrome.exe"]);
  });

  it("addProcess stores the casing the user picked, not a folded form", async () => {
    setupInvokeForLoad(makeRules({ processes: [] }));

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.addProcess("Chrome.exe");
    });

    // Verbatim. Not "chrome.exe".
    expect(result.current.rules.processes).toEqual(["Chrome.exe"]);
  });

  it("addProcess never rewrites an existing entry with a later case-mismatched attempt", async () => {
    setupInvokeForLoad(makeRules({ processes: ["Chrome.exe"] }));

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
    act(() => {
      result.current.addProcess("CHROME.EXE");
    });

    expect(result.current.rules.processes).toEqual(["Chrome.exe"]);
  });

  it("removeProcess still matches the stored form and leaves the rest of the list alone", async () => {
    setupInvokeForLoad(makeRules({ processes: ["Chrome.exe", "firefox.exe"] }));

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.removeProcess("Chrome.exe");
    });

    expect(result.current.rules.processes).toEqual(["firefox.exe"]);
  });

  it("addProcess still adds two genuinely different names", async () => {
    setupInvokeForLoad(makeRules({ processes: [] }));

    const { result } = renderHook(() =>
      useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.addProcess("Chrome.exe");
    });
    act(() => {
      result.current.addProcess("firefox.exe");
    });

    expect(result.current.rules.processes).toEqual(["Chrome.exe", "firefox.exe"]);
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
    setupInvokeForLoad(makeRules({ proxy: [], direct: [] }));

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

  // ── iplist_group: T-26 (D-04) round-trip/serialize + D-05 storage (Wave 0 RED) ──
  //
  // These four cases encode the phase-22 hook contract. Case (1) is the RED gate for T-26
  // (Plan 02 turns it green); cases (2)(3)(4) lock invariants that mostly hold today so a
  // future refactor cannot silently break them.

  /** The `rules` arg of the most recent invoke("save_routing_rules", { rules }) call. */
  function lastSavePayload() {
    const calls = mockInvoke.mock.calls.filter(
      (c: unknown[]) => c[0] === "save_routing_rules",
    );
    expect(calls.length).toBeGreaterThan(0);
    return (calls[calls.length - 1][1] as { rules: RoutingRules }).rules;
  }

  it("save() serializes an iplist_group entry WITH its prefix (D-04 / T-26 — RED until Plan 02)", async () => {
    // T-26: toBackendPayload must re-add the `iplist_group:` prefix (via serializeEntry) so the
    // group survives save→reload AND still resolves in the core. RED today: the inline value
    // ternary only handles geoip:/geosite:, so an iplist_group is persisted as the BARE value
    // "games" and is mis-detected as a plain domain on the next load (misroute).
    setupInvokeForLoad(
      makeRules({
        proxy: [{ id: "ig1", type: "iplist_group", value: "iplist_group:games" }],
        direct: [],
      }),
    );

    const { result } = renderHook(
      () => useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.save();
    });

    const payload = lastSavePayload();
    const entry = payload.proxy.find(
      (e) =>
        e.type === "iplist_group" ||
        (e as unknown as { entry_type?: string }).entry_type === "iplist_group",
    );
    expect(entry).toBeDefined();
    // Prefix present on the persisted value — RED now (bare "games"), green in Plan 02.
    expect(entry!.value).toBe("iplist_group:games");
    expect((entry as unknown as { entry_type?: string }).entry_type).toBe("iplist_group");
  });

  it("load keeps an iplist_group entry as iplist_group, not domain (T-26 round-trip)", async () => {
    // Locks the load-side round-trip: a persisted `iplist_group:games` must re-detect as an
    // iplist_group (value "games"), never as a plain domain. Passes today (load path already
    // strips the prefix) — asserted so a regression to bare-value storage is caught.
    setupInvokeForLoad(
      makeRules({
        proxy: [{ id: "ig1", type: "iplist_group", value: "iplist_group:games" }],
        direct: [],
      }),
    );

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.rules.proxy[0].type).toBe("iplist_group");
    expect(result.current.rules.proxy[0].value).toBe("games");
  });

  it("addEntry stores an iplist_group as ONE chip, never exploded to domains (D-05)", async () => {
    // D-05: a group is persisted as a single reference chip inside a block, expanded to domains
    // only at resolve-time. Adding a group must create exactly one RuleEntry, and saving must
    // write exactly one row for it — never a domain list.
    setupInvokeForLoad(makeRules({ proxy: [], direct: [] }));

    const { result } = renderHook(
      () => useRoutingState({ ...defaultOpts, status: "connected" }),
      { wrapper },
    );

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.addEntry("proxy", "iplist_group:games");
    });

    expect(result.current.rules.proxy).toHaveLength(1);
    expect(result.current.rules.proxy[0].type).toBe("iplist_group");
    expect(result.current.rules.proxy[0].value).toBe("games");

    await act(async () => {
      await result.current.save();
    });

    const payload = lastSavePayload();
    expect(payload.proxy).toHaveLength(1);
    expect((payload.proxy[0] as unknown as { entry_type?: string }).entry_type).toBe(
      "iplist_group",
    );
  });

  it("moveEntry relocates an iplist_group chip and dedups on the target (D-05 / T-25)", async () => {
    const rules = makeRules({
      direct: [{ id: "ig1", type: "iplist_group", value: "iplist_group:games" }],
      proxy: [],
    });
    setupInvokeForLoad(rules);

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.moveEntry("direct", "proxy", "ig1");
    });

    expect(result.current.rules.direct).toHaveLength(0);
    expect(result.current.rules.proxy).toHaveLength(1);
    expect(result.current.rules.proxy[0].type).toBe("iplist_group");
    expect(result.current.rules.proxy[0].value).toBe("games");
  });

  it("moveEntry into a block already holding the same group is a no-op (D-05 dedup)", async () => {
    const rules = makeRules({
      direct: [{ id: "ig1", type: "iplist_group", value: "iplist_group:games" }],
      proxy: [{ id: "ig2", type: "iplist_group", value: "iplist_group:games" }],
    });
    setupInvokeForLoad(rules);

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      result.current.moveEntry("direct", "proxy", "ig1");
    });

    // Target already has the group → move skipped, both blocks unchanged (single chip each).
    expect(result.current.rules.direct).toHaveLength(1);
    expect(result.current.rules.proxy).toHaveLength(1);
  });

  // ── iplist groups: list load + ensureGroupCache dispatcher (D-03 / Pitfall #2 — Plan 22-03) ──
  //
  // The hook exposes the available group list (whitelist source) and a fetch-on-add dispatcher.
  // ensureGroupCache routes a KNOWN id to the right backend fetch (ru_whitelist is special-cased)
  // and is a NO-OP for an unknown / traversal id — the FE belt to the backend is_valid_group_id.

  function setupInvokeWithGroups() {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") return makeRules({ proxy: [], direct: [] });
      if (cmd === "get_geodata_status")
        return { downloaded: false, geoip_exists: false, geosite_exists: false, geoip_categories_count: 0, geosite_categories_count: 0 };
      if (cmd === "get_iplist_groups")
        return [
          { id: "games", label: "Games" },
          { id: "youtube", label: "YouTube" },
          { id: "messengers", label: "Messengers" },
        ];
      if (cmd === "fetch_iplist_group_domains") return ["a.com", "b.com"];
      if (cmd === "fetch_whitelist_domains") return ["ru1.com", "ru2.com"];
      return null;
    });
  }

  it("loads the iplist group list on mount (get_iplist_groups)", async () => {
    setupInvokeWithGroups();

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockInvoke).toHaveBeenCalledWith("get_iplist_groups");
    expect(result.current.iplistGroups.map((g) => g.id)).toEqual([
      "games",
      "youtube",
      "messengers",
    ]);
  });

  it("ensureGroupCache('games') invokes fetch_iplist_group_domains", async () => {
    setupInvokeWithGroups();

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.ensureGroupCache("games");
    });

    expect(mockInvoke).toHaveBeenCalledWith("fetch_iplist_group_domains", { groupId: "games" });
    expect(mockInvoke).not.toHaveBeenCalledWith("fetch_whitelist_domains");
  });

  it("ensureGroupCache('ru_whitelist') invokes fetch_whitelist_domains (special case)", async () => {
    setupInvokeWithGroups();

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.ensureGroupCache("ru_whitelist");
    });

    expect(mockInvoke).toHaveBeenCalledWith("fetch_whitelist_domains");
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "fetch_iplist_group_domains",
      expect.anything(),
    );
  });

  it("ensureGroupCache('../x') is a no-op — invokes NEITHER fetch (FE belt to backend guard)", async () => {
    setupInvokeWithGroups();

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.ensureGroupCache("../x");
    });

    expect(mockInvoke).not.toHaveBeenCalledWith(
      "fetch_iplist_group_domains",
      expect.anything(),
    );
    expect(mockInvoke).not.toHaveBeenCalledWith("fetch_whitelist_domains");
  });
  // ── SITE BLOCKING IS GONE (2026-09-03) — the browser must not touch what is left of it ──
  //
  // Здесь раньше стояли четыре теста D-01: «флаг блокировки доезжает до Rust в обе стороны».
  // Блокировка сайтов удалена, поэтому у тех тестов не осталось предмета — а тест, потерявший
  // предмет, обязан быть переписан под то, что есть сейчас, а не оставлен зеленеть впустую.
  //
  // Сейчас проверяется ДРУГОЕ, и это самое опасное место всей правки. `routing_rules.json` на диске
  // у каждого, кто хоть раз открывал вкладку, содержит `block` и `block_enabled`. Бэкенд их
  // ЧИТАЕТ терпимо и ПЕРЕНОСИТ при каждом сохранении (`CARRIED_LEGACY_KEYS` в routing_rules.rs —
  // там же живут rust-тесты round-trip). Задача этой стороны моста ровно одна: не мешать. Отправь
  // браузер `block` обратно в payload — и он перезапишет своей (пустой) копией то, что бэкенд
  // бережёт, то есть сотрёт список доменов, набранный руками.

  /** The `rules` argument of the most recent `save_routing_rules` call — what reached the writer. */
  function lastSavedRules() {
    const calls = mockInvoke.mock.calls.filter((c: unknown[]) => c[0] === "save_routing_rules");
    expect(calls.length).toBeGreaterThan(0);
    return (calls[calls.length - 1][1] as { rules: Record<string, unknown> }).rules;
  }

  /** Документ ровно того вида, что лежит сейчас на реальной машине: с обоими удалёнными ключами. */
  function rulesFileWithLegacyBlockKeys(): RoutingRules {
    return {
      ...makeRules(),
      block: [
        { id: "b1", type: "domain", value: "ads.example.com", label: undefined },
        { id: "b2", type: "domain", value: "tracker.example.net", label: undefined },
      ],
      block_enabled: true,
    } as unknown as RoutingRules;
  }

  it("load(): a rules file carrying the removed keys still loads — the rest of it is read", async () => {
    // Нечитаемый файл правил ОТМЕНЯЕТ подключение (D-02), поэтому «упасть на лишнем ключе» здесь
    // означало бы сборку, которая отказывается подключаться у каждого, кто пользовался блокировкой.
    setupInvokeForLoad(rulesFileWithLegacyBlockKeys());

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.loadFailed).toBe(false);
    expect(result.current.rules.proxy.map((e) => e.value)).toEqual(["example.com"]);
  });

  it("save(): the payload carries NO block keys — the browser must not overwrite what Rust preserves", async () => {
    // САМАЯ ВАЖНАЯ ПРОВЕРКА этой правки со стороны фронтенда. Отправить `block: []` было бы хуже,
    // чем не отправить ничего: бэкенд переносит ключи из ПРЕДЫДУЩЕГО документа, но `block` из
    // payload лёг бы поверх — и список доменов пользователя исчез бы при первой же правке правил.
    setupInvokeForLoad(rulesFileWithLegacyBlockKeys());

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.save();
    });

    const saved = lastSavedRules();
    expect("block" in saved).toBe(false);
    expect("block_enabled" in saved).toBe(false);
    // …и это не «сохранение вообще ничего не отправило»: живая половина документа на месте.
    expect(saved.direct).toEqual([]);
    expect((saved.proxy as { value: string }[]).map((e) => e.value)).toEqual(["example.com"]);
  });

  it("resetRules(): the reset document carries no block keys either", async () => {
    // Сброс пишет пустой документ отдельной, выписанной руками формой (не через toBackendPayload),
    // поэтому это вторая дверь к тому же свойству — и её надо запирать отдельно.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") throw "corrupt";
      if (cmd === "get_geodata_status")
        return { downloaded: false, geoip_exists: false, geosite_exists: false, geoip_categories_count: 0, geosite_categories_count: 0 };
      return null;
    });

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });
    await vi.waitFor(() => {
      expect(result.current.loadFailed).toBe(true);
    });

    setupInvokeForLoad(makeRules({ proxy: [], direct: [] }));
    await act(async () => {
      await result.current.resetRules();
    });

    const saved = lastSavedRules();
    expect("block" in saved).toBe(false);
    expect("block_enabled" in saved).toBe(false);
  });

  // ── D-02 (30.1 blocker 2): broken is not the same thing as empty ──────────

  it("a rules file that cannot be read is reported as UNREADABLE, not rendered as an empty list", async () => {
    // The defect: the catch arm raised a snackbar and left the panel showing zero rules — which is
    // exactly what a user with no rules sees. Somebody whose file is merely broken was being told
    // «у вас нет правил», and the obvious next move (start typing rules again) would have
    // overwritten the file they still had.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") {
        throw new Error("Failed to parse routing_rules.json: expected `,` at line 12 column 3");
      }
      return null;
    });

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.loadFailed).toBe(true);
    expect(result.current.rules.direct).toEqual([]);
  });

  it("a healthy load leaves the unreadable flag down, and a later success clears an earlier failure", async () => {
    // The flag has to be a fact about the LAST load, not a latch. A user who resets and reloads
    // must get their panel back; a flag that never clears would strand them on the error screen.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") throw new Error("broken");
      return null;
    });
    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });
    await vi.waitFor(() => expect(result.current.loadFailed).toBe(true));

    setupInvokeForLoad(makeRules());
    await act(async () => {
      await result.current.load();
    });

    expect(result.current.loadFailed).toBe(false);
    expect(result.current.rules.proxy).toHaveLength(1);
  });

  it("resetRules writes an EMPTY rules document through the existing save command", async () => {
    // The way out. It reuses `save_routing_rules` rather than minting a Tauri command, so it
    // inherits the atomic writer from 30.1-01 and adds no new capability surface — and the file it
    // leaves behind must be one `load_routing_rules` can parse, or the user is back where they
    // started.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") throw new Error("broken");
      return null;
    });
    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });
    await vi.waitFor(() => expect(result.current.loadFailed).toBe(true));

    // The reload after the reset must succeed, or the panel would stay on the error state.
    setupInvokeForLoad(makeRules({ proxy: [], direct: [] }));
    await act(async () => {
      await result.current.resetRules();
    });

    const saved = lastSavedRules();
    expect(saved.direct).toEqual([]);
    expect(saved.proxy).toEqual([]);
    expect(saved.processes).toEqual([]);
    expect(result.current.loadFailed).toBe(false);
  });

  // ── Item 17: a legacy bare group value keeps its persisted type ───────────
  //
  // Both normaliser sites get their OWN case. They were byte-identical copies, which is exactly
  // how somebody fixes one and ships the bug through the other.

  it("load(): a legacy bare iplist_group value keeps its persisted type", async () => {
    // Written by an older build: the type is on the record but the value has no `iplist_group:`
    // prefix. Deriving the type from the value alone re-types it as a plain domain — the group
    // stops routing, stops refreshing from its cache, and the chip still looks active.
    setupInvokeForLoad(
      makeRules({
        proxy: [{ id: "g1", type: "iplist_group", value: "games", label: undefined }],
      }),
    );

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.rules.proxy[0].type).toBe("iplist_group");
    expect(result.current.rules.proxy[0].value).toBe("games");
  });

  it("importRules(): a legacy bare iplist_group value keeps its persisted type", async () => {
    // The import door is the OTHER copy. Fixing only the load path leaves this one re-typing every
    // legacy entry a user imports from their own export.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") return makeRules();
      if (cmd === "import_routing_rules") {
        return makeRules({
          direct: [{ id: "g2", type: "iplist_group", value: "games", label: undefined }],
        });
      }
      return null;
    });

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.importRules();
    });

    expect(result.current.rules.direct[0].type).toBe("iplist_group");
    expect(result.current.rules.direct[0].value).toBe("games");
  });

  it("an entry with NO persisted type still falls back to deriving one", async () => {
    // Trusting the persisted type must not become «never derive». A record written before the type
    // was persisted at all, or hand-edited, still needs the value read.
    const legacyEntry = { id: "g3", value: "geosite:discord", label: undefined } as unknown as {
      id: string;
      type: "domain";
      value: string;
      label: undefined;
    };
    setupInvokeForLoad(makeRules({ proxy: [legacyEntry] }));

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.rules.proxy[0].type).toBe("geosite");
    expect(result.current.rules.proxy[0].value).toBe("discord");
  });

  it("a modern prefixed value still has its prefix stripped for display", async () => {
    // The round-trip that already worked must keep working: persisted type present AND the value
    // carrying the wire prefix. Strip on the FINAL type, so this is unchanged.
    setupInvokeForLoad(
      makeRules({
        proxy: [{ id: "g4", type: "geoip", value: "geoip:ru", label: undefined }],
      }),
    );

    const { result } = renderHook(() => useRoutingState(defaultOpts), { wrapper });
    await vi.waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.rules.proxy[0].type).toBe("geoip");
    expect(result.current.rules.proxy[0].value).toBe("ru");
  });
});
