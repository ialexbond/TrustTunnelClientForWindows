import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import {
  canObservePointer,
  isFocusBeingPlaced,
  placeFocus,
  usePointerContextLoss,
  usePointerPresence,
} from "./usePointerPresence";

/**
 * G-32-16 — the primitive behind the fix.
 *
 * `Tooltip` and `WindowControls` have their own end-to-end cases; these pin the rule itself, and
 * they are the only proof covering the two surfaces that cannot be rendered in isolation:
 * `PresetGrid`'s tile tint inherits it directly, and `tray-menu.tsx` is an entry file that mounts
 * its own React root at import time and so has no unit-testable component surface at all.
 *
 * The `describe`s below the DOM-signal ones cover the SECOND attempt at this defect. The first
 * shipped as build `t3ykm8` and failed on a real Windows install, which proved that none of those DOM
 * signals reaches the document on his close-to-tray path. See 32-G-32-16-TOOLTIP.md.
 */

/**
 * A frame clock we drive by hand.
 *
 * The production code looks `requestAnimationFrame` up on `window` at call time, so replacing it
 * here exercises the real loop with timestamps of our choosing. It has to be replaced: the jsdom
 * shim in `src/test/setup.ts` is `(cb) => { cb(0); return 0; }`, which invokes its callback
 * SYNCHRONOUSLY and always stamps it 0 — no interval between frames can be staged with it at all.
 */
function manualFrames() {
  const queue: FrameRequestCallback[] = [];
  let scheduled = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    scheduled += 1;
    queue.push(cb);
    return scheduled;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return {
    get scheduled() {
      return scheduled;
    },
    /** Deliver every frame the code has asked for, stamped `ts`. */
    paint(ts: number) {
      const due = queue.splice(0, queue.length);
      act(() => {
        for (const cb of due) cb(ts);
      });
    },
  };
}

/** Every `write_activity_log` message this test has produced, in order. */
function loggedSignals(): string[] {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "write_activity_log")
    .map(([, args]) => String((args as { message?: string } | undefined)?.message ?? ""));
}

function loggedDetails(): (string | undefined)[] {
  return vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "write_activity_log")
    .map(([, args]) => (args as { details?: string } | undefined)?.details);
}

/** Run `fn` with the document reporting itself hidden, then restore. */
function withHiddenDocument(fn: () => void) {
  const original = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  try {
    fn();
  } finally {
    delete (document as unknown as Record<string, unknown>).visibilityState;
    if (original) Object.defineProperty(Document.prototype, "visibilityState", original);
  }
}

describe("canObservePointer", () => {
  it("is true while the document is visible", () => {
    expect(canObservePointer()).toBe(true);
  });

  it("is false while the document is hidden", () => {
    withHiddenDocument(() => {
      expect(canObservePointer()).toBe(false);
    });
  });
});

describe("usePointerPresence", () => {
  it("starts absent and follows real pointer events", () => {
    const { result } = renderHook(() => usePointerPresence());

    expect(result.current.present).toBe(false);
    act(() => result.current.enter());
    expect(result.current.present).toBe(true);
    act(() => result.current.leave());
    expect(result.current.present).toBe(false);
  });

  it("mirrors presence into a ref readable from inside a timer callback", () => {
    const { result } = renderHook(() => usePointerPresence());

    act(() => result.current.enter());
    expect(result.current.presentRef.current).toBe(true);

    // The ref must be current the instant the event is handled, without waiting for a render —
    // a delayed reveal consults it from a setTimeout that closed over an older render.
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(result.current.presentRef.current).toBe(false);
  });

  // The four document-level boundary conditions. Each is a separate case so a regression names
  // which one was dropped rather than reporting a single vague failure.
  it.each([
    ["window blur — the webview stops receiving pointer input", () => window.dispatchEvent(new Event("blur"))],
    ["window focus — the return path, which the old fix had no member of", () => window.dispatchEvent(new Event("focus"))],
    ["pagehide — the document is going away", () => window.dispatchEvent(new Event("pagehide"))],
    ["visibilitychange — the webview is not being painted", () => document.dispatchEvent(new Event("visibilitychange"))],
  ])("expires presence on %s", (_label, emit) => {
    const { result } = renderHook(() => usePointerPresence());

    act(() => result.current.enter());
    expect(result.current.present).toBe(true);

    act(() => {
      emit();
    });
    expect(result.current.present).toBe(false);
  });

  it("can only be re-established by a fresh pointer enter, never by the window coming back", () => {
    const { result } = renderHook(() => usePointerPresence());

    act(() => result.current.enter());
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    // The window is shown again. Nothing may re-derive presence from the state it had before.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current.present).toBe(false);

    act(() => result.current.enter());
    expect(result.current.present).toBe(true);
  });

  it("runs the caller's teardown on every expiry", () => {
    const onLoss = vi.fn();
    const { result } = renderHook(() => usePointerPresence(onLoss));

    act(() => result.current.enter());
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(onLoss).toHaveBeenCalledTimes(1);

    // Also when presence was already absent: a pending reveal timer still needs cancelling.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(onLoss).toHaveBeenCalledTimes(2);
  });

  it("calls the latest teardown, not the one captured on mount", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }: { cb: () => void }) => usePointerPresence(cb), {
      initialProps: { cb: first },
    });

    rerender({ cb: second });
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

describe("usePointerContextLoss", () => {
  it("notifies every mounted subscriber from the one shared set of listeners", () => {
    const a = vi.fn();
    const b = vi.fn();
    renderHook(() => usePointerContextLoss(a));
    renderHook(() => usePointerContextLoss(b));

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  // Its own case, not folded into the usePointerPresence one above: that hook hands down a STABLE
  // callback of its own, so a test routed through it exercises `usePointerPresence`'s freshness ref
  // and leaves this one's untouched. Mutating the ref away left the suite green until this existed.
  it("calls the latest callback, not the one captured on mount", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ cb }: { cb: () => void }) => usePointerContextLoss(cb), {
      initialProps: { cb: first },
    });

    rerender({ cb: second });
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("stops notifying after unmount", () => {
    const onLoss = vi.fn();
    const { unmount } = renderHook(() => usePointerContextLoss(onLoss));

    unmount();
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(onLoss).not.toHaveBeenCalled();
  });

  it("re-attaches after the last subscriber has gone and a new one arrives", () => {
    const first = vi.fn();
    const { unmount } = renderHook(() => usePointerContextLoss(first));
    unmount();

    // Detaching on the last unmount must not leave the module unable to bind again — otherwise the
    // rule would silently die the first time a screen with no hoverables was shown.
    const second = vi.fn();
    renderHook(() => usePointerContextLoss(second));
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(second).toHaveBeenCalledTimes(1);
  });
});

/**
 * The frame clock — the primary mechanism after the first fix shipped and failed.
 *
 * While something is on screen the page is painting frames. Hide the window and the frames stop.
 * The INTERVAL between two consecutive frames is therefore evidence in itself that the window was
 * not being presented, and so that the document cannot have been watching the pointer across it.
 * It needs no cooperation from WebView2, from Tauri, or from the window manager — which is the
 * whole point, because a real Windows install demonstrably delivers none of their events.
 */
describe("the frame clock", () => {
  let frames: ReturnType<typeof manualFrames>;

  beforeEach(() => {
    frames = manualFrames();
    // jsdom reports `document.hasFocus() === false`, which disarms the focus poll. Pin it true so
    // these cases isolate the gap rule; the poll has its own cases below.
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  it("expires presence when the gap between two frames says the window was not being painted", () => {
    const { result } = renderHook(() => usePointerPresence());
    act(() => result.current.enter());

    frames.paint(1_000); // the frame that seeds the clock
    expect(result.current.present).toBe(true);

    // Three seconds in which nothing was painted. No blur, no focus, no visibilitychange, no
    // pointer event — this is the signal that arrives when every event has failed to.
    frames.paint(4_000);
    expect(result.current.present).toBe(false);
  });

  it("tolerates a 900 ms stall: a blocked main thread is not a hidden window", () => {
    // The threshold has to sit above anything a visible window can do to itself — a long React
    // commit, a GC pause, a synchronous IPC — or a busy moment would blank a legitimate tooltip.
    const { result } = renderHook(() => usePointerPresence());
    act(() => result.current.enter());

    frames.paint(1_000);
    frames.paint(1_900);
    expect(result.current.present).toBe(true);
  });

  it("does not run the clock while nothing is on screen", () => {
    renderHook(() => usePointerPresence());
    expect(frames.scheduled).toBe(0);
  });

  it("catches the second hide as well as the first", () => {
    // The owner meets this gesture every session, so the clock has to be restartable. A clock left
    // MARKED running after an expiry would early-return out of every later arming and the rule would
    // be dead for the rest of the session — working exactly once, which is the worst of all outcomes
    // because it looks fixed.
    const { result } = renderHook(() => usePointerPresence());

    act(() => result.current.enter());
    frames.paint(1_000);
    frames.paint(4_000);
    expect(result.current.present).toBe(false);

    act(() => result.current.enter());
    frames.paint(5_000);
    expect(result.current.present).toBe(true);
    frames.paint(9_000);
    expect(result.current.present).toBe(false);
  });

  it("stops asking for frames once what was on screen has come down", () => {
    const { result } = renderHook(() => usePointerPresence());
    act(() => result.current.enter());
    const whileShowing = frames.scheduled;
    expect(whileShowing).toBeGreaterThan(0);

    act(() => result.current.leave());
    frames.paint(1_000); // the frame already in flight when the pointer left
    frames.paint(1_016);
    expect(frames.scheduled).toBe(whileShowing);
  });

  it("stops the clock when the subscriber that was holding something unmounts", () => {
    // A trigger can unmount while it is still hovered — WR-07 in Tooltip is exactly that, a titlebar
    // button swapped out mid-delay by a VPN event. The module stays attached because another
    // subscriber is still mounted, so nothing else would notice, and the loop would spin at 60 fps
    // for the rest of the session with nothing on screen to justify it.
    renderHook(() => usePointerPresence()); // an idle bystander, keeping the module attached
    const { result, unmount } = renderHook(() => usePointerPresence());
    act(() => result.current.enter());
    const whileShowing = frames.scheduled;

    unmount();
    frames.paint(1_000); // the frame that was already in flight
    frames.paint(1_016);
    expect(frames.scheduled).toBe(whileShowing);
  });

  it("does not chain on a requestAnimationFrame that runs its callback synchronously", () => {
    // The jsdom shim in src/test/setup.ts is exactly this. A self-rescheduling loop on top of it
    // recurses until the stack blows, which would take out every existing Tooltip, WindowControls
    // and PresetGrid test. One observation, then stop.
    let calls = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      calls += 1;
      cb(0);
      return calls;
    });

    const { result } = renderHook(() => usePointerPresence());
    expect(() => act(() => result.current.enter())).not.toThrow();
    expect(calls).toBe(1);
  });
});

/**
 * The focus poll — the other half of the unknown.
 *
 * If WebView2 stops painting a hidden window, the frame gap catches it. If WebView2 keeps painting
 * one, frames keep arriving and the gap never opens — so the loop asks the window directly whether
 * it still has focus, rather than waiting for a `blur` event that may never be delivered. Between
 * them the two rules cover both branches, which is what the shipped design could not claim.
 */
describe("the focus poll", () => {
  let frames: ReturnType<typeof manualFrames>;

  beforeEach(() => {
    frames = manualFrames();
  });

  it("expires presence when a window that had focus is seen to have lost it", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { result } = renderHook(() => usePointerPresence());
    act(() => result.current.enter());

    frames.paint(1_000);
    expect(result.current.present).toBe(true);

    hasFocus.mockReturnValue(false);
    frames.paint(1_016);
    expect(result.current.present).toBe(false);
  });

  it("re-reads the focus state on each fresh arrival rather than reusing the last one", () => {
    // The clock has to be genuinely stopped when the screen goes quiet, not merely left with nothing
    // pending: a clock still MARKED running makes the next arming early-return, and the new episode
    // then inherits the previous one's focus reading and last frame timestamp. Here the first hover
    // happens on a focused window and the second on a background one, which must not be policed.
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { result } = renderHook(() => usePointerPresence());

    act(() => result.current.enter());
    frames.paint(1_000);
    act(() => result.current.leave());

    hasFocus.mockReturnValue(false);
    act(() => result.current.enter());
    frames.paint(1_016);
    frames.paint(1_032);
    expect(result.current.present).toBe(true);
  });

  it("does not police focus for a window that did not have it when the pointer arrived", () => {
    // Hovering a control on an unfocused window is legitimate — Windows lights its close button
    // too. Policing focus unconditionally would mean no tooltip ever appeared on a background
    // window, and would make the rule fire throughout jsdom, where hasFocus() is false (measured) —
    // which is exactly what removing this condition does: 15 checks across two files go red.
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const { result } = renderHook(() => usePointerPresence());
    act(() => result.current.enter());

    frames.paint(1_000);
    frames.paint(1_016);
    expect(result.current.present).toBe(true);
  });
});

/**
 * The `:hover` cross-check — belt as well as braces, and never sufficient alone.
 *
 * Where the DOM can answer «is the pointer on this element», asking it is the most direct evidence
 * there is. It cannot be trusted blind, because whether it answers at all depends on how the hover
 * got there: jsdom does match `:hover` for an element that received a dispatched `mouseenter`
 * (measured — so the check is live in the Tooltip suite) but not for one that never saw a mouse
 * event. The check therefore calibrates itself on the first frame after the pointer arrives, and
 * only polices what it has already been seen to get right. The elements below stub `matches` so the
 * answer, and the calibration that depends on it, can be driven both ways.
 */
describe("the :hover cross-check", () => {
  let frames: ReturnType<typeof manualFrames>;

  beforeEach(() => {
    frames = manualFrames();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  /** An element whose `:hover` answer we control. */
  function hoverable(answer: () => boolean) {
    const el = document.createElement("div");
    el.matches = ((selector: string) =>
      selector === ":hover" ? answer() : false) as typeof el.matches;
    return el;
  }

  it("expires presence when the DOM says the pointer is no longer on the trigger", () => {
    let onIt = true;
    const el = hoverable(() => onIt);

    const { result } = renderHook(() => usePointerPresence(undefined, { current: el }));
    act(() => result.current.enter());

    frames.paint(1_000); // calibration frame: `:hover` agrees, so it is worth listening to here
    frames.paint(1_016);
    expect(result.current.present).toBe(true);

    onIt = false;
    frames.paint(1_032);
    expect(result.current.present).toBe(false);
  });

  it("does not trust `:hover` in an environment that cannot answer it", () => {
    const el = hoverable(() => false);

    const { result } = renderHook(() => usePointerPresence(undefined, { current: el }));
    act(() => result.current.enter());

    frames.paint(1_000);
    frames.paint(1_016);
    frames.paint(1_032);
    expect(result.current.present).toBe(true);
  });

  it("re-learns whether `:hover` can be trusted on every fresh arrival", () => {
    // One `:hover` that could not be trusted must not condemn the element for the session. The first
    // arrival here is synthetic — nothing is really hovered — and the second is real.
    let onIt = false;
    const el = hoverable(() => onIt);

    const { result } = renderHook(() => usePointerPresence(undefined, { current: el }));
    act(() => result.current.enter());
    frames.paint(1_000); // calibration says «no» to a pointer that just arrived: not trustworthy
    expect(result.current.present).toBe(true);
    act(() => result.current.leave());

    onIt = true;
    act(() => result.current.enter());
    frames.paint(2_000); // fresh calibration, and this time `:hover` agrees
    expect(result.current.present).toBe(true);

    onIt = false;
    frames.paint(2_016);
    expect(result.current.present).toBe(false);
  });
});

/**
 * Instrumentation.
 *
 * This project has paid twice for a hook that failed silently: G-32-8 cost three wrong diagnoses of
 * auto-connect, and this very defect cost a shipped build. Every expiry now names the signal that
 * fired, so a third failure is read out of the log rather than guessed at. D-29: the signal name
 * and the timing, nothing else.
 */
describe("expiry instrumentation", () => {
  let frames: ReturnType<typeof manualFrames>;

  beforeEach(() => {
    frames = manualFrames();
    vi.mocked(invoke).mockResolvedValue(null);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });

  it.each([
    ["blur", () => window.dispatchEvent(new Event("blur"))],
    ["focus", () => window.dispatchEvent(new Event("focus"))],
    ["pagehide", () => window.dispatchEvent(new Event("pagehide"))],
    ["visibilitychange", () => document.dispatchEvent(new Event("visibilitychange"))],
  ])("names the %s signal in the activity log", (signal, emit) => {
    const { result } = renderHook(() => usePointerPresence());
    act(() => result.current.enter());

    act(() => {
      emit();
    });

    expect(loggedSignals()).toEqual([`pointer presence expired: ${signal}`]);
  });

  it("names the frame-gap signal and reports the interval it measured", () => {
    const { result } = renderHook(() => usePointerPresence());
    act(() => result.current.enter());

    frames.paint(1_000);
    frames.paint(4_200);

    expect(loggedSignals()).toEqual(["pointer presence expired: frame-gap"]);
    expect(loggedDetails()).toEqual(["gap=3200ms"]);
  });

  it("names the focus-poll signal", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { result } = renderHook(() => usePointerPresence());
    act(() => result.current.enter());
    frames.paint(1_000);

    hasFocus.mockReturnValue(false);
    frames.paint(1_016);

    expect(loggedSignals()).toEqual(["pointer presence expired: focus-poll"]);
  });

  it("names the hover-recheck signal", () => {
    let onIt = true;
    const el = document.createElement("div");
    el.matches = ((selector: string) =>
      selector === ":hover" ? onIt : false) as typeof el.matches;

    const { result } = renderHook(() => usePointerPresence(undefined, { current: el }));
    act(() => result.current.enter());
    frames.paint(1_000);

    onIt = false;
    frames.paint(1_016);

    expect(loggedSignals()).toEqual(["pointer presence expired: hover-recheck"]);
  });

  it("names the Tauri signals, which are subscribed once for the whole app", async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow() as unknown as {
      listen: (event: string, handler: () => void) => Promise<() => void>;
    };
    const listen = vi.mocked(win.listen);
    listen.mockResolvedValue(() => {});

    const { result } = renderHook(() => usePointerPresence());
    // The subscription is behind a dynamic import of @tauri-apps/api/window; let it settle.
    await act(async () => {});
    act(() => result.current.enter());

    const handlerFor = (event: string) => listen.mock.calls.find(([name]) => name === event)?.[1];
    const onTauriBlur = handlerFor("tauri://blur");
    expect(onTauriBlur).toBeTypeOf("function");

    act(() => onTauriBlur!());
    expect(loggedSignals()).toEqual(["pointer presence expired: tauri-blur"]);

    act(() => result.current.enter());
    const onTauriFocus = handlerFor("tauri://focus");
    act(() => onTauriFocus!());
    expect(loggedSignals()).toEqual([
      "pointer presence expired: tauri-blur",
      "pointer presence expired: tauri-focus",
    ]);
  });

  it("says nothing when the expiry took nothing down", () => {
    // Volume guard: the app-wide broadcast fires on every alt-tab whether or not anything was
    // showing. Only an expiry that actually removed something from the screen is worth a line.
    renderHook(() => usePointerPresence());

    act(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });

    expect(loggedSignals()).toEqual([]);
  });

  it("writes one line per expiry however many subscribers were holding something", () => {
    const { result: a } = renderHook(() => usePointerPresence());
    const { result: b } = renderHook(() => usePointerPresence());
    act(() => {
      a.current.enter();
      b.current.enter();
    });

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(loggedSignals()).toEqual(["pointer presence expired: blur"]);
  });
});

/**
 * G-32-20 — the marker a component holds up while it is placing focus itself.
 *
 * `Tooltip`'s end-to-end cases live in `TooltipFocusRestore.test.tsx` and are written as the
 * owner's sequence. These pin the primitive, including the two properties that no end-to-end case
 * can reach: that the marker is down again after a focus handler throws, and that it survives
 * nesting.
 */
describe("placeFocus", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it("is up while the focus event is being delivered and down again after", () => {
    const el = document.createElement("button");
    document.body.appendChild(el);
    const seen: boolean[] = [];
    el.addEventListener("focus", () => seen.push(isFocusBeingPlaced(el)));

    placeFocus(el);

    expect(seen).toEqual([true]);
    expect(isFocusBeingPlaced(el)).toBe(false);
    el.remove();
  });

  it("is down again even when a focus handler throws", () => {
    // Without the `finally`, the marker would stay up for the rest of the session and every later
    // keyboard focus would be silently refused — a failure that looks exactly like the defect this
    // was written to close.
    const exploding = {
      focus: () => {
        throw new Error("a focus handler threw");
      },
    };

    expect(() => placeFocus(exploding)).toThrow("a focus handler threw");
    expect(isFocusBeingPlaced(null)).toBe(false);
  });

  it("stays up for the outer placement when one is nested inside another", () => {
    // A dialog closing from inside another dialog's cleanup. A boolean flag would be cleared by the
    // inner placement while the outer one is still delivering its own event.
    const inner = { focus: () => {} };
    let outerStillMarked: boolean | null = null;
    const outer = {
      focus: () => {
        placeFocus(inner);
        outerStillMarked = isFocusBeingPlaced(null);
      },
    };

    placeFocus(outer);

    expect(outerStillMarked).toBe(true);
    expect(isFocusBeingPlaced(null)).toBe(false);
  });

  it("does nothing when handed nothing, so an absent ref is not a crash", () => {
    expect(() => placeFocus(null)).not.toThrow();
    expect(() => placeFocus(undefined)).not.toThrow();
    expect(isFocusBeingPlaced(null)).toBe(false);
  });

  it("names the refusal in the log with the element's tag and nothing else (D-29)", () => {
    const el = document.createElement("button");
    document.body.appendChild(el);
    el.addEventListener("focus", () => isFocusBeingPlaced(el));

    placeFocus(el);

    const lines = vi
      .mocked(invoke)
      .mock.calls.filter(([command]) => command === "write_activity_log")
      .map(([, args]) => args as { message?: string; details?: string });
    expect(lines).toEqual([
      { tag: "STATE", message: "pointer focus refused: app-placed", details: "target=BUTTON" },
    ]);
    el.remove();
  });

  it("says nothing at all when no placement is in flight", () => {
    expect(isFocusBeingPlaced(document.body)).toBe(false);
    expect(
      vi.mocked(invoke).mock.calls.filter(([command]) => command === "write_activity_log"),
    ).toEqual([]);
  });
});
