import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useConfigList, type ConfigSummary } from "./useConfigList";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

// Tauri event-listener mock (codebase TESTING.md pattern): capture callbacks by event name, track
// the live listener count so unmount cleanup is provable, and let tests emit synthetic events.
type ListenCallback = (event: { payload: unknown }) => void;
let listenCallbacks: Record<string, ListenCallback[]> = {};
let liveListenerCount: Record<string, number> = {};

function setupListenMock() {
  listenCallbacks = {};
  liveListenerCount = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(listen).mockImplementation(async (eventName: string, callback: any) => {
    if (!listenCallbacks[eventName]) listenCallbacks[eventName] = [];
    listenCallbacks[eventName].push(callback);
    liveListenerCount[eventName] = (liveListenerCount[eventName] ?? 0) + 1;
    return () => {
      liveListenerCount[eventName] = (liveListenerCount[eventName] ?? 1) - 1;
    };
  });
}

function emitEvent(eventName: string) {
  (listenCallbacks[eventName] || []).forEach((cb) => cb({ payload: undefined }));
}

function config(id: string): ConfigSummary {
  return {
    id,
    name: id,
    host: `${id}.example`,
    display_host: `${id}.example`,
    user: "u",
    path: `C:/cfg/${id}.toml`,
    order: 0,
    last_used: false,
  };
}

describe("useConfigList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupListenMock();
  });

  /**
   * The 28-UAT bug, at the level it was actually caused.
   *
   * He deleted a config on «Подключение» and the «Порядок переключения» list in «Настройки» kept
   * showing it. The Settings panel holds its OWN useConfigList instance, the tabs stay mounted
   * (IN-11) so it never re-mounts, and the `configs-changed` listener used to live in
   * `useConfigMutations` — which only the Connection tab uses. Nothing in the app could reach that
   * second instance.
   *
   * So the assertion is deliberately about a bare hook with no mutation helper anywhere near it:
   * that is the shape the Settings panel has.
   */
  it("re-reads the list when the configs folder changes, with no mutation helper involved", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([config("a"), config("b")]);

    const { result } = renderHook(() => useConfigList());
    await waitFor(() => expect(result.current.configs).toHaveLength(2));

    // The folder loses one config — the shape of a delete on another tab.
    vi.mocked(invoke).mockResolvedValueOnce([config("a")]);
    await act(async () => {
      emitEvent("configs-changed");
    });

    await waitFor(() => expect(result.current.configs).toEqual([config("a")]));
  });

  it("refreshes SILENTLY — a background event must never raise the loading skeleton", async () => {
    // The skeleton unmounts the scrolled list and resets its scroll position (IN-29 / IN-47), so a
    // folder event has to use the in-place leg. Easy to regress by reaching for `reload`, and
    // invisible in the delete flow that prompted the fix.
    vi.mocked(invoke).mockResolvedValueOnce([config("a")]);
    const { result } = renderHook(() => useConfigList());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let resolveSecond: (v: ConfigSummary[]) => void = () => {};
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise<ConfigSummary[]>((res) => {
        resolveSecond = res;
      }),
    );

    await act(async () => {
      emitEvent("configs-changed");
    });
    // Mid-flight: the re-read is running and the skeleton is still down.
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveSecond([config("a"), config("c")]);
    });
    await waitFor(() => expect(result.current.configs).toHaveLength(2));
  });

  it("keeps the current list when the refresh read fails", async () => {
    // A blipped background read must not blank a list the user is looking at and can still use.
    vi.mocked(invoke).mockResolvedValueOnce([config("a")]);
    const { result } = renderHook(() => useConfigList());
    await waitFor(() => expect(result.current.configs).toHaveLength(1));

    vi.mocked(invoke).mockRejectedValueOnce(new Error("manifest unreadable"));
    await act(async () => {
      emitEvent("configs-changed");
    });

    expect(result.current.configs).toEqual([config("a")]);
    expect(result.current.error).toBe(false);
  });

  it("drops its listener on unmount", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    const { unmount } = renderHook(() => useConfigList());
    await waitFor(() => expect(liveListenerCount["configs-changed"]).toBe(1));

    unmount();
    await waitFor(() => expect(liveListenerCount["configs-changed"]).toBe(0));
  });
});
