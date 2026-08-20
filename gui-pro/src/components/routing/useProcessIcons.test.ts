import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  ICON_BATCH_SIZE,
  ICON_REQUEST_DEBOUNCE_MS,
  readProcessIcon,
  requestProcessIcons,
  resetProcessIconCache,
  resolveProcessIconForPath,
} from "./useProcessIcons";

/**
 * Scheduling tests for the shared icon cache.
 *
 * WHY THESE ASSERT ON ARGUMENTS, NOT ON RENDERED OUTPUT. Every rule this hook exists to enforce —
 * batching, coalescing, de-duplication, negative caching — is invisible in the DOM: a picker whose
 * icons all eventually appear looks identical whether it asked once or two hundred times. The only
 * honest evidence is WHAT was asked and HOW OFTEN, so every test below records the `names` array of
 * each `invoke` call and asserts on that recording.
 *
 * The Tauri bridge is mocked globally in `src/test/tauri-mock.ts` (pulled in by `src/test/setup.ts`);
 * that mock is NOT re-declared here. Each test only routes the command through
 * `vi.mocked(invoke).mockImplementation`, which is this project's existing two-layer idiom.
 */

const invokeMock = vi.mocked(invoke);

/** Every `names` array handed to `get_process_icons`, in call order. */
let calls: string[][];

/** Route the icon command and record its batch. `answer` decides what each name resolves to. */
function routeIconCommand(answer: (name: string) => string | null = (n) => `data:image/png;base64,${n}`) {
  invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "get_process_icons") {
      const names = (args?.names ?? []) as string[];
      calls.push(names);
      return names.map((name) => ({ name, icon: answer(name) }));
    }
    return null;
    // The global mock is typed as the real generic `invoke`; a per-test implementation cannot
    // satisfy that generic, which is why the project's other suites cast here too.
  }) as unknown as typeof invoke);
}

/** Let the debounce fire and the resulting promises settle. */
async function settle() {
  await vi.advanceTimersByTimeAsync(ICON_REQUEST_DEBOUNCE_MS + 10);
}

describe("useProcessIcons — request scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    invokeMock.mockReset();
    // The cache is module-level on purpose (one session, shared by the saved list and the picker),
    // so it also outlives a single test. Without this reset, a name resolved by one test would
    // silently answer the next test's request and the assertion would prove nothing.
    resetProcessIconCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("carries several requested names in ONE command call", async () => {
    routeIconCommand();

    requestProcessIcons(["chrome.exe", "firefox.exe", "code.exe"]);
    await settle();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["chrome.exe", "firefox.exe", "code.exe"]);
  });

  it("splits a request larger than the batch size into calls of at most that size", async () => {
    routeIconCommand();
    const many = Array.from({ length: ICON_BATCH_SIZE * 2 + 5 }, (_, i) => `p${i}.exe`);

    requestProcessIcons(many);
    await settle();

    expect(calls).toHaveLength(3);
    for (const batch of calls) {
      expect(batch.length).toBeLessThanOrEqual(ICON_BATCH_SIZE);
    }
    // Nothing may be dropped by the splitting: every name is asked for exactly once.
    expect(calls.flat().sort()).toEqual([...many].sort());
  });

  it("sends the chunks ONE AT A TIME, never all at once", async () => {
    // The cap's documented reason is that a bounded call leaves room for other work on the
    // backend's blocking pool. Firing every chunk together defeated exactly that: a single fling
    // down a long list produced seven simultaneous calls, each taking its own full process
    // snapshot, on the pool the VPN connectivity monitor shares.
    let concurrent = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== "get_process_icons") return null;
      const names = (args?.names ?? []) as string[];
      calls.push(names);
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      // Hold the call open so an overlapping one would be visible in `peak`.
      await new Promise<void>((resolve) => releases.push(resolve));
      concurrent -= 1;
      return names.map((name) => ({ name, icon: null }));
    }) as unknown as typeof invoke);

    requestProcessIcons(Array.from({ length: ICON_BATCH_SIZE * 3 }, (_, i) => `p${i}.exe`));
    await vi.advanceTimersByTimeAsync(ICON_REQUEST_DEBOUNCE_MS + 10);

    // Only the first chunk may be airborne while it is unanswered.
    expect(calls).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      releases.shift()?.();
      await vi.advanceTimersByTimeAsync(1);
    }

    expect(calls).toHaveLength(3);
    expect(peak).toBe(1);
  });

  it("holds the in-flight claim for the whole flush, so a later chunk is never asked twice", async () => {
    // A name waiting in chunk 3 is not yet sent, but it IS already spoken for. Without the up-front
    // claim it would read as neither cached nor airborne, and a row re-declaring it mid-drain would
    // enqueue a second command for a question already being asked.
    const releases: (() => void)[] = [];
    invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== "get_process_icons") return null;
      const names = (args?.names ?? []) as string[];
      calls.push(names);
      await new Promise<void>((resolve) => releases.push(resolve));
      return names.map((name) => ({ name, icon: null }));
    }) as unknown as typeof invoke);

    const many = Array.from({ length: ICON_BATCH_SIZE * 3 }, (_, i) => `p${i}.exe`);
    requestProcessIcons(many);
    await vi.advanceTimersByTimeAsync(ICON_REQUEST_DEBOUNCE_MS + 10);

    // Re-declare a name that lives in the LAST, not-yet-sent chunk.
    requestProcessIcons([many[many.length - 1]]);
    for (let i = 0; i < 3; i++) {
      releases.shift()?.();
      await vi.advanceTimersByTimeAsync(ICON_REQUEST_DEBOUNCE_MS + 10);
    }

    // Three chunks, and each name asked exactly once.
    expect(calls).toHaveLength(3);
    expect(calls.flat().sort()).toEqual([...many].sort());
  });

  it("coalesces requests arriving inside the debounce window into a single call", async () => {
    routeIconCommand();

    // Three separate declarations, as three rows scrolling into view would produce.
    requestProcessIcons(["a.exe"]);
    await vi.advanceTimersByTimeAsync(10);
    requestProcessIcons(["b.exe"]);
    await vi.advanceTimersByTimeAsync(10);
    requestProcessIcons(["c.exe"]);
    await settle();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual(["a.exe", "b.exe", "c.exe"]);
  });

  it("never re-requests a name whose icon is already cached", async () => {
    routeIconCommand();

    requestProcessIcons(["chrome.exe"]);
    await settle();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(readProcessIcon("chrome.exe")).toMatch(/^data:image\/png;base64,/);

    requestProcessIcons(["chrome.exe"]);
    await settle();
    // Still one — the second declaration found a settled answer and asked nothing.
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("caches the NEGATIVE answer too — a null icon is never re-requested", async () => {
    // A protected or elevated process: the backend answers, and the answer is "no icon".
    routeIconCommand(() => null);

    requestProcessIcons(["msmpeng.exe"]);
    await settle();
    expect(calls).toHaveLength(1);
    expect(readProcessIcon("msmpeng.exe")).toBeNull();

    // Scrolling past that row again must not re-pay a lookup that is guaranteed to fail.
    requestProcessIcons(["msmpeng.exe"]);
    await settle();
    expect(calls).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("does not issue a second concurrent call for a name already in flight", async () => {
    // A call that never settles is the honest model of "the shell is still being asked".
    invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_process_icons") {
        calls.push((args?.names ?? []) as string[]);
        return new Promise(() => {});
      }
      return null;
    }) as unknown as typeof invoke);

    requestProcessIcons(["steam.exe"]);
    await settle();
    expect(calls).toHaveLength(1);

    // A fast scroll declares the same row again before the first answer lands.
    requestProcessIcons(["steam.exe"]);
    await settle();
    expect(calls).toHaveLength(1);
    // While in flight the name is not yet settled either way, so it must still read as "unknown".
    expect(readProcessIcon("steam.exe")).toBeUndefined();
  });

  it("does not throw when the command rejects, and leaves the names uncached so a retry is possible", async () => {
    invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_process_icons") {
        calls.push((args?.names ?? []) as string[]);
        throw new Error("snapshot failed");
      }
      return null;
    }) as unknown as typeof invoke);

    expect(() => requestProcessIcons(["typed-by-hand.exe"])).not.toThrow();
    await settle();
    expect(calls).toHaveLength(1);
    // The row shows the give-up glyph rather than a skeleton that never resolves…
    expect(readProcessIcon("typed-by-hand.exe")).toBeNull();

    // …but the failure is NOT cached: a later declaration asks again, because a transient backend
    // failure must not blank that program for the rest of the session.
    routeIconCommand();
    requestProcessIcons(["typed-by-hand.exe"]);
    await settle();
    expect(calls).toHaveLength(2);
    expect(readProcessIcon("typed-by-hand.exe")).toMatch(/^data:image\/png;base64,/);
  });

  it("keys the cache case-insensitively but sends the name exactly as it was given", async () => {
    routeIconCommand();

    requestProcessIcons(["Discord.exe"]);
    await settle();

    // Sent verbatim: process-name semantics belong to the core, so the frontend never normalizes
    // what it hands over — only its own private lookup key is lowercased.
    expect(calls[0]).toEqual(["Discord.exe"]);
    // Read back under any casing, and asked for only once.
    expect(readProcessIcon("discord.exe")).toMatch(/^data:image\/png;base64,/);
    requestProcessIcons(["DISCORD.EXE"]);
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("settles a name the answer omitted entirely, so an omission is not re-requested forever", async () => {
    // The backend never aborts a batch on one failure; a missing row means "not resolvable".
    invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_process_icons") {
        const names = (args?.names ?? []) as string[];
        calls.push(names);
        return names
          .filter((n) => n !== "ghost.exe")
          .map((name) => ({ name, icon: "data:image/png;base64,x" }));
      }
      return null;
    }) as unknown as typeof invoke);

    requestProcessIcons(["ghost.exe", "code.exe"]);
    await settle();
    expect(readProcessIcon("ghost.exe")).toBeNull();

    requestProcessIcons(["ghost.exe"]);
    await settle();
    expect(calls).toHaveLength(1);
  });

  it("persists nothing — a fresh read after the answer comes from memory only", async () => {
    routeIconCommand();
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    requestProcessIcons(["chrome.exe"]);
    await settle();

    expect(readProcessIcon("chrome.exe")).toMatch(/^data:image\/png;base64,/);
    // D-02 draws the boundary explicitly: the cache is memory-only and app-session-scoped. A
    // localStorage write is the shape that boundary forbids, so assert it never happens.
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  // ── The path-resolved entry point ────────────────────────────────────────────────────────────
  //
  // A file the user chose through the OS dialog is usually NOT running, so the name-based command
  // can never resolve it — there is no process to open. The path the dialog handed back is the one
  // and only way to get that file's real icon, and it lands in this same cache under the file's
  // base name so a later running instance of the same program shares the answer.

  it("caches a path-resolved icon under the file's base name", async () => {
    invokeMock.mockImplementation((async (cmd: string) => {
      if (cmd === "get_process_icon_for_path") return "data:image/png;base64,picked";
      return null;
    }) as unknown as typeof invoke);

    await resolveProcessIconForPath("C:\\Tools\\My App\\mytool.exe", "mytool.exe");

    expect(readProcessIcon("mytool.exe")).toBe("data:image/png;base64,picked");
    // Same cache, same case-insensitive key as every other consumer.
    expect(readProcessIcon("MyTool.exe")).toBe("data:image/png;base64,picked");
  });

  it("stops the name-based batch from re-asking for a name the path already answered", async () => {
    invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_process_icon_for_path") return "data:image/png;base64,picked";
      if (cmd === "get_process_icons") {
        calls.push((args?.names ?? []) as string[]);
        return [];
      }
      return null;
    }) as unknown as typeof invoke);

    await resolveProcessIconForPath("C:\\Tools\\mytool.exe", "mytool.exe");
    requestProcessIcons(["mytool.exe", "chrome.exe"]);
    await settle();

    expect(calls.flat()).toEqual(["chrome.exe"]);
  });

  it("cancels a name ALREADY waiting in the debounce window when the path answers it", async () => {
    // Claiming `inFlight` stops a future declaration; it says nothing about one already queued.
    // Without also removing the key from `queued`, the pending flush still sends it — two commands
    // for one question, which is exactly what the doc says this claim prevents.
    invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_process_icon_for_path") return "data:image/png;base64,picked";
      if (cmd === "get_process_icons") {
        calls.push((args?.names ?? []) as string[]);
        return [];
      }
      return null;
    }) as unknown as typeof invoke);

    // Declared FIRST, so it is sitting in the debounce window when the path call claims it.
    requestProcessIcons(["mytool.exe", "chrome.exe"]);
    await resolveProcessIconForPath("C:\\Tools\\mytool.exe", "mytool.exe");
    await settle();

    expect(calls.flat()).toEqual(["chrome.exe"]);
    expect(readProcessIcon("mytool.exe")).toBe("data:image/png;base64,picked");
  });

  it("retires a previous failure once the name is finally answered", async () => {
    // A transient command failure parks the name in `failed` so a later declaration retries it.
    // Once that retry succeeds the entry has no business staying there for the rest of the session.
    let shouldFail = true;
    invokeMock.mockImplementation((async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd !== "get_process_icons") return null;
      if (shouldFail) throw new Error("command blew up");
      const names = (args?.names ?? []) as string[];
      return names.map((name) => ({ name, icon: `data:image/png;base64,${name}` }));
    }) as unknown as typeof invoke);

    requestProcessIcons(["chrome.exe"]);
    await settle();
    expect(readProcessIcon("chrome.exe")).toBeNull();

    shouldFail = false;
    requestProcessIcons(["chrome.exe"]);
    await settle();

    expect(readProcessIcon("chrome.exe")).toBe("data:image/png;base64,chrome.exe");
    // And the answer survives a re-read: nothing left in `failed` can shadow it later.
    expect(readProcessIcon("chrome.exe")).toBe("data:image/png;base64,chrome.exe");
  });

  it("does not throw when the path command rejects, and leaves the name unresolved", async () => {
    invokeMock.mockImplementation((async (cmd: string) => {
      if (cmd === "get_process_icon_for_path") throw new Error("guard rejected the path");
      return null;
    }) as unknown as typeof invoke);

    await expect(
      resolveProcessIconForPath("C:\\Tools\\notes.txt", "notes.txt")
    ).resolves.toBeUndefined();

    // Reads as "no icon", which renders the neutral glyph — an icon is decoration, and no failure
    // to decorate a row may reach the user as an error.
    expect(readProcessIcon("notes.txt")).toBeNull();
  });
});
