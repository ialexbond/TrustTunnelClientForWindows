import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useConfigList, type ConfigSummary } from "../useConfigList";

// `@tauri-apps/api/core` invoke is globally mocked in src/test/tauri-mock.ts. We set the
// resolved value per-test to drive the manifest `list_configs` command.

const cfgDe: ConfigSummary = {
  id: "cfg-de-abc12345",
  name: "Германия — Frankfurt",
  host: "de1.example.com",
  user: "swift-fox",
  path: "C:/app/TrustTunnel_swift-fox.toml",
  order: 0,
  last_used: true,
};
const cfgNl: ConfigSummary = {
  id: "cfg-nl-def67890",
  name: "Нидерланды",
  host: "nl.example.com",
  user: "bold-eagle",
  path: "C:/app/TrustTunnel_bold-eagle.toml",
  order: 1,
  last_used: false,
};

describe("useConfigList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockResolvedValue([]);
  });

  // Truth: on mount the hook invokes list_configs and exposes the manifest entries.
  it("loads the manifest list on mount", async () => {
    vi.mocked(invoke).mockResolvedValue([cfgDe, cfgNl]);

    const { result } = renderHook(() => useConfigList());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(invoke).toHaveBeenCalledWith("list_configs");
    expect(result.current.configs).toEqual([cfgDe, cfgNl]);
  });

  // Truth: the mount load is once-guarded against StrictMode's double-invoke.
  it("loads exactly once on mount (StrictMode once-guard)", async () => {
    vi.mocked(invoke).mockResolvedValue([cfgDe]);

    const { result } = renderHook(() => useConfigList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    const listCalls = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "list_configs");
    expect(listCalls.length).toBe(1);
  });

  // Truth: reload() re-fetches the list via invoke (used after a mutation refreshes it).
  it("reload re-fetches the list via invoke", async () => {
    vi.mocked(invoke).mockResolvedValue([cfgDe]);
    const { result } = renderHook(() => useConfigList());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.configs).toEqual([cfgDe]);

    // Now the manifest gains a second config; reload picks it up.
    vi.mocked(invoke).mockResolvedValue([cfgDe, cfgNl]);
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.configs).toEqual([cfgDe, cfgNl]);
  });

  // Truth (IN-47): the loading SKELETON is FIRST-LOAD-ONLY. After the first successful load,
  // reload() re-fetches in place and never flips loading=true again — so a mutation never swaps the
  // populated list for the skeleton (which collapsed the scroll container and reset scrollTop).
  it("does NOT flip loading on a reload after the first load", async () => {
    vi.mocked(invoke).mockResolvedValue([cfgDe]);
    const { result } = renderHook(() => useConfigList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A controllable second fetch so we can observe `loading` WHILE the reload is in flight.
    let resolveList: (v: ConfigSummary[]) => void = () => {};
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise<ConfigSummary[]>((r) => {
        resolveList = r;
      }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.reload();
    });
    // Mid-reload of a POPULATED list → loading must stay false (no skeleton flash).
    expect(result.current.loading).toBe(false);
    await act(async () => {
      resolveList([cfgDe, cfgNl]);
      await pending;
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.configs).toEqual([cfgDe, cfgNl]);
  });

  // Truth (resilience): a failed list read degrades to an empty list, never throws.
  it("degrades to an empty list when list_configs rejects", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("read failed"));
    const { result } = renderHook(() => useConfigList());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.configs).toEqual([]);
  });
});
