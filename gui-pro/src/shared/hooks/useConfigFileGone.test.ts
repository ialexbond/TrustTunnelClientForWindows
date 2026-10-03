import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useConfigFileGone } from "./useConfigFileGone";
import { captureListeners } from "../../test/fixtures/events";

/**
 * G-30.1-01 — «the config this surface is bound to has left the disk».
 *
 * The suite drives the ONE decision the hook makes (flip / do not flip) through every input that
 * could produce a false «deleted», because a false positive here closes a pane over an edit the
 * user could still have saved.
 */

const PATH = "C:\\Users\\u\\AppData\\TrustTunnel\\TrustTunnel_alice.toml";

/** Answer `config_file_exists` with `exists`; every other command resolves benignly. */
function mockExists(exists: boolean | undefined) {
  vi.mocked(invoke).mockImplementation((async (cmd: string) => {
    if (cmd === "config_file_exists") return exists;
    return null;
  }) as never);
}

describe("useConfigFileGone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stays false while the file is on disk", async () => {
    captureListeners();
    mockExists(true);
    const { result } = renderHook(() => useConfigFileGone(PATH));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalledWith("config_file_exists", { configPath: PATH }));
    expect(result.current).toBe(false);
  });

  it("flips to true when the file is already gone at open time", async () => {
    captureListeners();
    mockExists(false);
    const { result } = renderHook(() => useConfigFileGone(PATH));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("flips to true when the file disappears while the surface is open (configs-changed)", async () => {
    const events = captureListeners();
    mockExists(true);
    const { result } = renderHook(() => useConfigFileGone(PATH));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());
    expect(result.current).toBe(false);

    // The file is deleted in the file manager; the data-dir watcher fires.
    mockExists(false);
    await act(async () => {
      events.emitEvent("configs-changed", undefined);
    });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("also re-checks on config-file-changed (the PP-5 window can swallow configs-changed)", async () => {
    const events = captureListeners();
    mockExists(true);
    const { result } = renderHook(() => useConfigFileGone(PATH));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());

    mockExists(false);
    await act(async () => {
      events.emitEvent("config-file-changed", { exists: false, path: PATH });
    });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("flips back to false when the file is restored", async () => {
    const events = captureListeners();
    mockExists(false);
    const { result } = renderHook(() => useConfigFileGone(PATH));
    await waitFor(() => expect(result.current).toBe(true));

    mockExists(true);
    await act(async () => {
      events.emitEvent("configs-changed", undefined);
    });
    await waitFor(() => expect(result.current).toBe(false));
  });

  // ── The three ways a naive implementation would claim a deletion that never happened ──

  it("does NOT claim a deletion when the existence check itself rejects", async () => {
    const events = captureListeners();
    vi.mocked(invoke).mockRejectedValue(new Error("IPC unavailable") as never);
    const { result } = renderHook(() => useConfigFileGone(PATH));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());
    await act(async () => {
      events.emitEvent("configs-changed", undefined);
    });
    expect(result.current).toBe(false);
  });

  it("does NOT claim a deletion when the command answers something that is not a boolean", async () => {
    captureListeners();
    mockExists(undefined);
    const { result } = renderHook(() => useConfigFileGone(PATH));
    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it("asks nothing and reports nothing when no surface is bound to a config", async () => {
    captureListeners();
    mockExists(false);
    const { result } = renderHook(() => useConfigFileGone(null));
    await act(async () => {});
    expect(result.current).toBe(false);
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("config_file_exists", expect.anything());
  });

  it("forgets the verdict when the surface closes, so the NEXT one does not open pre-condemned", async () => {
    captureListeners();
    mockExists(false);
    const { result, rerender } = renderHook(({ p }: { p: string | null }) => useConfigFileGone(p), {
      initialProps: { p: PATH as string | null },
    });
    await waitFor(() => expect(result.current).toBe(true));

    // The modal closes → nothing is bound. The verdict must go with it: it belonged to a path this
    // hook is no longer watching, and a stale `true` would paint the «файл удалён» state over the
    // next config the user opens, before any check has run for it.
    rerender({ p: null });
    expect(result.current).toBe(false);
  });

  it("re-asks for the NEW path when the bound config changes, and forgets the old verdict", async () => {
    captureListeners();
    mockExists(false);
    const { result, rerender } = renderHook(({ p }: { p: string | null }) => useConfigFileGone(p), {
      initialProps: { p: PATH as string | null },
    });
    await waitFor(() => expect(result.current).toBe(true));

    const OTHER = "C:\\Users\\u\\AppData\\TrustTunnel\\TrustTunnel_bob.toml";
    mockExists(true);
    rerender({ p: OTHER });
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("config_file_exists", { configPath: OTHER }),
    );
    await waitFor(() => expect(result.current).toBe(false));
  });
});
