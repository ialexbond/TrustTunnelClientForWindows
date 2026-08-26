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
  display_host: "de1.example.com",
  user: "swift-fox",
  path: "C:/app/TrustTunnel_swift-fox.toml",
  order: 0,
  last_used: true,
};
const cfgNl: ConfigSummary = {
  id: "cfg-nl-def67890",
  name: "Нидерланды",
  host: "nl.example.com",
  display_host: "nl.example.com",
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

  /**
   * 27 D-15 — THE ERROR CHANNEL.
   *
   * Until now a failed read and an empty manifest were the SAME value to the app: the catch cleared
   * the list and said nothing, so the tab drew «серверов пока нет» over a failure. That is a lie —
   * the servers exist, they just could not be read — and it is why the `load-failed` state the
   * Phase-27 design draws was unreachable in the app.
   *
   * The channel is deliberately asymmetric between the two legs, and that asymmetry is the point:
   * `reload()` is the leg that already clears the list, so it may report the failure; `refresh()`
   * keeps the previous list on a transient failure (IN-29 / N2), and an error set there would paint
   * «не удалось прочитать» over a list that is on screen and perfectly good.
   */
  describe("error channel (27 D-15)", () => {
    it("starts clean", async () => {
      vi.mocked(invoke).mockResolvedValue([cfgDe]);
      const { result } = renderHook(() => useConfigList());
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.error).toBe(false);
    });

    it("reload: a rejected read sets the error AND clears the list", async () => {
      vi.mocked(invoke).mockRejectedValue(new Error("read failed"));
      const { result } = renderHook(() => useConfigList());

      await waitFor(() => expect(result.current.error).toBe(true));
      expect(result.current.configs).toEqual([]);
    });

    it("reload: a later success clears the error", async () => {
      vi.mocked(invoke).mockRejectedValue(new Error("read failed"));
      const { result } = renderHook(() => useConfigList());
      await waitFor(() => expect(result.current.error).toBe(true));

      vi.mocked(invoke).mockResolvedValue([cfgDe, cfgNl]);
      await act(async () => {
        await result.current.reload();
      });

      expect(result.current.error).toBe(false);
      expect(result.current.configs).toEqual([cfgDe, cfgNl]);
    });

    it("refresh: a rejected read sets NO error and keeps the list", async () => {
      vi.mocked(invoke).mockResolvedValue([cfgDe, cfgNl]);
      const { result } = renderHook(() => useConfigList());
      await waitFor(() => expect(result.current.loading).toBe(false));

      vi.mocked(invoke).mockRejectedValue(new Error("transient"));
      await act(async () => {
        await result.current.refresh();
      });

      // A good rendered list must never be painted over by a background re-read that blipped.
      expect(result.current.error).toBe(false);
      expect(result.current.configs).toEqual([cfgDe, cfgNl]);
    });

    it("refresh: a success clears an error left by a failed reload", async () => {
      vi.mocked(invoke).mockRejectedValue(new Error("read failed"));
      const { result } = renderHook(() => useConfigList());
      await waitFor(() => expect(result.current.error).toBe(true));

      vi.mocked(invoke).mockResolvedValue([cfgDe]);
      await act(async () => {
        await result.current.refresh();
      });

      // The list HAS just been read successfully, so there is nothing left to report.
      expect(result.current.error).toBe(false);
      expect(result.current.configs).toEqual([cfgDe]);
    });

    // D-05 / EW-02: the field says THAT the read failed, never WHY. A raw backend string rendered
    // verbatim is the information-disclosure path `ServerUnavailablePlate` already refuses; a
    // boolean makes it structurally impossible rather than a rule someone has to remember.
    it("carries no backend message — the channel is a flag, not a string", async () => {
      vi.mocked(invoke).mockRejectedValue(new Error("EACCES C:/Users/secret/configs.json"));
      const { result } = renderHook(() => useConfigList());
      await waitFor(() => expect(result.current.error).toBe(true));

      expect(typeof result.current.error).toBe("boolean");
      expect(JSON.stringify(result.current.error)).not.toMatch(/EACCES|secret/);
    });

    it("does not re-enter the skeleton on a failed reload after the first load", async () => {
      vi.mocked(invoke).mockResolvedValue([cfgDe]);
      const { result } = renderHook(() => useConfigList());
      await waitFor(() => expect(result.current.loading).toBe(false));

      vi.mocked(invoke).mockRejectedValue(new Error("read failed"));
      await act(async () => {
        await result.current.reload();
      });

      // hasLoadedRef (IN-47) is untouched: the error state must not resurrect the scroll-reset
      // vector the first-load-only skeleton rule was built to close.
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBe(true);
    });

    it("keeps the rest of the returned shape under its existing names", async () => {
      vi.mocked(invoke).mockResolvedValue([cfgDe]);
      const { result } = renderHook(() => useConfigList());
      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(Object.keys(result.current).sort()).toEqual([
        "configs",
        "error",
        "loading",
        "refresh",
        "reload",
      ]);
    });
  });
});
