import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { FOCUS_INTENT_WINDOW_MS } from "../hooks/usePointerPresence";
import { Tooltip } from "./Tooltip";

/**
 * A genuine keyboard Tab: the keydown that carries the user's intent, and then the focus it
 * produces.
 *
 * Both halves matter. A bare `focus` event is exactly what a returning window fires at the element
 * it had focused before it went away, so a test that dispatches only `focus` is not testing a
 * keyboard user at all — it is testing the defect. See the «a focus the user did not ask for» block.
 */
const tabTo = (el: HTMLElement) => {
  fireEvent.keyDown(document.body, { key: "Tab" });
  fireEvent.focus(el);
};

/** Every `write_activity_log` line this test produced, as `[message, details]` pairs. */
const loggedLines = (): (readonly [string, string | undefined])[] =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "write_activity_log")
    .map(([, args]) => {
      const a = args as { message?: string; details?: string } | undefined;
      return [a?.message ?? "", a?.details] as const;
    });

describe("Tooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Whether a focus can be attributed to the user is answered from module state in
    // usePointerPresence, which outlives a single test, while the fake clock is reinstalled at the
    // real current time for each one. Push past the attribution window so every case starts from
    // «the user has done nothing», and a case that needs an input has to produce it itself.
    act(() => {
      vi.advanceTimersByTime(FOCUS_INTENT_WINDOW_MS + 1);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders children (trigger element)", () => {
    render(
      <Tooltip text="Help info">
        <button>Hover me</button>
      </Tooltip>
    );
    expect(screen.getByText("Hover me")).toBeInTheDocument();
  });

  it("does not show tooltip text initially", () => {
    render(
      <Tooltip text="Help info">
        <button>Hover me</button>
      </Tooltip>
    );
    expect(screen.queryByText("Help info")).not.toBeInTheDocument();
  });

  it("shows tooltip text on hover after delay", () => {
    render(
      <Tooltip text="Help info" delay={400}>
        <button>Hover me</button>
      </Tooltip>
    );

    const trigger = screen.getByText("Hover me").closest("div")!;
    fireEvent.mouseEnter(trigger);

    expect(screen.queryByText("Help info")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(450);
    });

    expect(screen.getByText("Help info")).toBeInTheDocument();
  });

  it("hides tooltip on mouse leave", () => {
    render(
      <Tooltip text="Help info" delay={0}>
        <button>Hover me</button>
      </Tooltip>
    );

    const trigger = screen.getByText("Hover me").closest("div")!;

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(screen.getByText("Help info")).toBeInTheDocument();

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByText("Help info")).not.toBeInTheDocument();
  });

  it("tooltip text matches the text prop", () => {
    render(
      <Tooltip text="Specific tooltip content" delay={0}>
        <span>Trigger</span>
      </Tooltip>
    );

    const trigger = screen.getByText("Trigger").closest("div")!;
    fireEvent.mouseEnter(trigger);

    act(() => {
      vi.advanceTimersByTime(10);
    });

    const tip = screen.getByText("Specific tooltip content");
    expect(tip).toBeInTheDocument();
    expect(tip.tagName).toBe("P");
  });

  it("cancels tooltip if mouse leaves before delay finishes", () => {
    render(
      <Tooltip text="Delayed tip" delay={500}>
        <span>Trigger</span>
      </Tooltip>
    );

    const trigger = screen.getByText("Trigger").closest("div")!;

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.mouseLeave(trigger);

    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(screen.queryByText("Delayed tip")).not.toBeInTheDocument();
  });

  it("uses z-[var(--z-tooltip)] above modal (not hardcoded, not below modal)", () => {
    render(
      <Tooltip text="Z-check" delay={0}>
        <span>Trigger</span>
      </Tooltip>
    );

    const trigger = screen.getByText("Trigger").closest("div")!;
    fireEvent.mouseEnter(trigger);

    act(() => {
      vi.advanceTimersByTime(10);
    });

    const tip = screen.getByText("Z-check").closest("div[class*='fixed']")!;
    // Tooltip must sit above Modal (z-modal=300). Dedicated --z-tooltip=450 token.
    expect(tip.className).toContain("z-[var(--z-tooltip)]");
    expect(tip.className).not.toContain("9500");
    expect(tip.className).not.toContain("z-[var(--z-dropdown)]");
  });

  // CC-7: keyboard + screen-reader accessibility.
  //
  // These four cases used to dispatch a bare `focus` event and call it «keyboard focus». They no
  // longer can: a bare `focus` is exactly what a window returning from the tray fires at the element
  // it had focused, which is G-32-16 round three. `tabTo` presses Tab first, so what they exercise
  // is what they have always claimed to.
  it("shows tooltip on keyboard focus with role=tooltip", () => {
    render(
      <Tooltip text="Focus tip" delay={0}>
        <button>Focusable</button>
      </Tooltip>
    );

    tabTo(screen.getByText("Focusable"));
    act(() => {
      vi.advanceTimersByTime(10);
    });

    expect(screen.getByRole("tooltip")).toHaveTextContent("Focus tip");
  });

  it("associates the focusable child via aria-describedby resolving to the tooltip", () => {
    render(
      <Tooltip text="Described tip" delay={0}>
        <button>Focusable</button>
      </Tooltip>
    );

    const child = screen.getByText("Focusable");
    tabTo(child);
    act(() => {
      vi.advanceTimersByTime(10);
    });

    const describedBy = child.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveAttribute("id", describedBy);
  });

  it("hides tooltip on Escape", () => {
    render(
      <Tooltip text="Escape tip" delay={0}>
        <button>Focusable</button>
      </Tooltip>
    );

    const child = screen.getByText("Focusable");
    tabTo(child);
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.keyDown(child, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("hides tooltip on blur", () => {
    render(
      <Tooltip text="Blur tip" delay={0}>
        <button>Focusable</button>
      </Tooltip>
    );

    const child = screen.getByText("Focusable");
    tabTo(child);
    act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.blur(child);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  // G-32-16 — the tooltip must be on screen only while the pointer is attested to be on the
  // trigger. The sequence: hover «Закрыть» → the tip appears → the window hides to the
  // tray → the tray icon brings it back → the tip is still painted over a window the pointer has
  // never been in, and stays until an unrelated movement finally produces the `mouseleave`.
  //
  // These drive DOM `blur`/`focus`/`visibilitychange` on the webview rather than `tauri://blur`,
  // because the Tauri event does not exist under vitest — which is exactly why the previous fix
  // (Tooltip.tsx, `try { listen("tauri://blur") } catch {}`) was a silent no-op in every test that
  // has ever run against this component.
  describe("pointer presence (G-32-16)", () => {
    const renderTip = (delay = 400) => {
      render(
        <Tooltip text="Close the window" delay={delay}>
          <button>Close</button>
        </Tooltip>,
      );
      return screen.getByText("Close").closest("div")!;
    };

    /** Simulate a hidden webview without emitting an event, to isolate the show-time precondition. */
    const withHiddenDocument = (run: () => void) => {
      const original = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      try {
        run();
      } finally {
        delete (document as unknown as Record<string, unknown>).visibilityState;
        if (original) Object.defineProperty(Document.prototype, "visibilityState", original);
      }
    };

    it("does not survive a window hide and re-show with the pointer never moving", () => {
      const trigger = renderTip();

      fireEvent.mouseEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(450);
      });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();

      // Tray click hides the window. The pointer does not move, so NO mouseleave is emitted.
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

      // Tray icon brings the window back. Still not a single pointer event.
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    it("stays hidden after a re-show even when the hide itself emitted nothing", () => {
      const trigger = renderTip();

      fireEvent.mouseEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(450);
      });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();

      // Regaining focus is the one event every return path must produce. A window that has just
      // been away cannot vouch for the pointer, so the tip goes even with no preceding blur.
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    it("does not fire a pending show timer into a hidden window", () => {
      const trigger = renderTip();

      fireEvent.mouseEnter(trigger);
      withHiddenDocument(() => {
        act(() => {
          vi.advanceTimersByTime(450);
        });
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      });
    });

    it("cancels a pending show timer when the window goes away mid-delay", () => {
      const trigger = renderTip();

      fireEvent.mouseEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(200);
        window.dispatchEvent(new Event("blur"));
      });
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    it("hides when the webview reports itself hidden", () => {
      const trigger = renderTip();

      fireEvent.mouseEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(450);
      });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();

      withHiddenDocument(() => {
        act(() => {
          document.dispatchEvent(new Event("visibilitychange"));
        });
      });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    // The suppression must not outlast its cause: a real re-entry is still a real hover.
    it("shows again when the pointer genuinely re-enters after the window returns", () => {
      const trigger = renderTip();

      fireEvent.mouseEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(450);
      });
      act(() => {
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("focus"));
      });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

      fireEvent.mouseEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(450);
      });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    });

    // Keyboard focus is a separate claim from pointer presence, and the two differ in WHAT expires
    // them, not in whether they can. This pair replaces one case that asserted the opposite — that
    // a keyboard tip survives a window focus event — which was round two's design and is the half
    // of the defect the owner met as «теперь оно вообще не пропадает».
    it("keeps a keyboard tip up when only the pointer's own cross-check expires", () => {
      // Both claims are up at once: he has tabbed to the button AND the cursor is resting on it.
      // `hover-recheck` says the cursor has left. That is the pointer's business alone — the button
      // is still focused, so the tip stays. This is what the replaced case was right about.
      const queue: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queue.push(cb));
      vi.stubGlobal("cancelAnimationFrame", () => {});
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const paint = (ts: number) => {
        const due = queue.splice(0, queue.length);
        act(() => {
          for (const cb of due) cb(ts);
        });
      };

      render(
        <Tooltip text="Keyboard tip" delay={400}>
          <button>Focusable</button>
        </Tooltip>,
      );
      const child = screen.getByText("Focusable");
      const trigger = child.closest("div")!;
      let onIt = true;
      trigger.matches = ((selector: string) =>
        selector === ":hover" ? onIt : false) as typeof trigger.matches;

      tabTo(child);
      fireEvent.mouseEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(450);
      });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();

      paint(1_000); // calibration frame: `:hover` agrees, so it is worth listening to
      onIt = false;
      paint(1_016); // and now it says the cursor has gone

      expect(screen.getByRole("tooltip")).toBeInTheDocument();
    });

    it("drops a keyboard tip when the window itself goes away", () => {
      render(
        <Tooltip text="Keyboard tip" delay={0}>
          <button>Focusable</button>
        </Tooltip>,
      );
      const child = screen.getByText("Focusable");

      tabTo(child);
      act(() => {
        vi.advanceTimersByTime(10);
      });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();

      // Alt-tab, a hide to the tray, anything that takes the window off screen. Native Windows
      // keeps the focus ring and drops the tip, and so does this: he gets it back on the next Tab.
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });

      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });

    // The contract that the SHIPPED fix could not honour. Build `t3ykm8` carried the event-driven
    // version and the tooltip still hung on a real machine, which proved that on that machine the close-to-tray
    // path delivers no blur, no focus, no pagehide and no visibilitychange to the document. The gap
    // between two painted frames needs none of them.
    it("goes down on the return frame when the window was not painted in between", () => {
      // Take the frame clock off sinon and drive it by hand: a real gap cannot be staged with
      // timers that hand out a frame every 16 ms.
      const queue: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queue.push(cb));
      vi.stubGlobal("cancelAnimationFrame", () => {});
      const paint = (ts: number) => {
        const due = queue.splice(0, queue.length);
        act(() => {
          for (const cb of due) cb(ts);
        });
      };

      const trigger = renderTip();
      fireEvent.mouseEnter(trigger);
      act(() => {
        vi.advanceTimersByTime(450);
      });
      expect(screen.getByRole("tooltip")).toBeInTheDocument();

      paint(1_000); // the last frame before the window went away
      expect(screen.getByRole("tooltip")).toBeInTheDocument();

      // Four seconds later the window is back and paints again. Not one event was delivered and
      // the pointer never moved — the interval is the only evidence there is, and it is enough.
      paint(5_000);
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });

  /**
   * G-32-16, round three — the focus the user did not ask for.
   *
   * Rounds one and two both treated an element `focus` event as evidence of a keyboard user. It is
   * not. When the window is hidden to the tray with a button focused and the tray icon brings it
   * back, Windows restores focus to that button and the DOM re-fires `focus` on it, with no keypress
   * and no pointer movement anywhere. Round one raised the tip a moment after correctly dismissing
   * it; round two raised a KEYBOARD claim, which by its own design no expiry rule could take down —
   * «теперь оно вообще не пропадает».
   *
   * The `activity.log` from build v8qc2r acquitted the presence mechanism: `blur` and
   * `hover-recheck` expiries fired exactly as designed. Presence was never the problem; what was
   * showing had simply been put back up by a focus event nobody had asked for.
   *
   * The cases below are written as his sequence, not as an abstraction, and they assert on what is
   * RENDERED, so a refactor that keeps the internal flags and breaks the render still goes red.
   */
  describe("a focus the user did not ask for (round three)", () => {
    const renderCloseButton = () => {
      render(
        <Tooltip text="Close the window" delay={400}>
          <button>Close</button>
        </Tooltip>,
      );
      return screen.getByText("Close");
    };

    /** Hide to the tray: Windows deactivates the window, so the focused button loses focus too. */
    const hideToTray = (child: HTMLElement) => {
      act(() => {
        window.dispatchEvent(new Event("blur"));
      });
      fireEvent.blur(child);
    };

    /**
     * The trip to the tray icon. Seconds, not milliseconds — and the fake clock's participation is
     * asserted rather than assumed, so a config change that stops faking `Date` fails HERE instead
     * of quietly making every case below vacuous.
     */
    const secondsPass = (ms: number) => {
      const before = Date.now();
      act(() => {
        vi.advanceTimersByTime(ms);
      });
      expect(Date.now() - before).toBeGreaterThanOrEqual(ms);
    };

    // Both orders, because the mechanism must not depend on one. On the real path the window's own
    // `focus` event arrives before the element's; a fix that merely took the tip DOWN on the window
    // event would pass the first case and fail the second — and would also be round one, which took
    // it down a moment before the returning focus put it back up.
    it.each([
      ["the window focus event arrives first", true],
      ["the element focus event arrives first", false],
    ])(
      "paints nothing when a returning window re-focuses a pointer-focused button (%s)",
      (_label, windowFirst) => {
        const child = renderCloseButton();

        // 1. He presses «Закрыть» WITH THE MOUSE. The press focuses the button; a click must not
        //    raise the tip, and it does not.
        fireEvent.mouseDown(child);
        fireEvent.focus(child);
        act(() => {
          vi.advanceTimersByTime(450);
        });
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

        // 2. The window goes to the tray. The pointer does not move, so no mouseleave is emitted.
        hideToTray(child);

        // 3. He finds the tray icon and clicks it.
        secondsPass(5_000);

        // 4. The window is back and focus lands on that same button again. Not one keypress, not
        //    one pointer event: nothing here is a user action, so nothing may be painted.
        const refocus = () => fireEvent.focus(child);
        const windowBack = () =>
          act(() => {
            window.dispatchEvent(new Event("focus"));
          });
        if (windowFirst) {
          windowBack();
          refocus();
        } else {
          refocus();
          windowBack();
        }
        act(() => {
          vi.advanceTimersByTime(450);
        });

        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      },
    );

    it("writes the refused focus to the activity log, so a fourth round can be read", () => {
      // This defect has cost three builds because the code that was supposed to prevent it left no
      // trace of running. The refusal names itself and reports how long it had been since the user
      // last did anything — which is also the proof that the input timestamp comes from his mouse
      // press and not from somewhere else.
      vi.mocked(invoke).mockResolvedValue(null);
      const child = renderCloseButton();

      fireEvent.mouseDown(child);
      fireEvent.focus(child);
      hideToTray(child);
      secondsPass(5_000);
      fireEvent.focus(child);

      expect(loggedLines()).toContainEqual([
        "pointer focus refused: no user input",
        "sinceInput=5000ms",
      ]);
    });

    it("refuses a focus it cannot time, when the clock has moved backwards", () => {
      // An NTP correction in the wild, and a fake clock reinstalled between tests in here. Either
      // way the interval since the last user input is meaningless, and a meaningless interval must
      // not be allowed to look like «he pressed Tab a moment ago». Without this the cases in this
      // file would also stop being independent of each other: one that advances its clock by five
      // seconds leaves a timestamp in the FUTURE of the next one.
      vi.mocked(invoke).mockResolvedValue(null);
      const child = renderCloseButton();

      fireEvent.keyDown(document.body, { key: "Tab" });
      act(() => {
        vi.setSystemTime(new Date(Date.now() - 10_000));
      });
      fireEvent.focus(child);
      act(() => {
        vi.advanceTimersByTime(450);
      });

      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      expect(loggedLines()).toContainEqual([
        "pointer focus refused: no user input",
        "sinceInput=-10000ms",
      ]);
    });

    // The case that must NOT regress. A keyboard user inside a visible window presses Tab and the
    // tip belongs on screen — the whole reason a focus claim exists at all.
    it("still shows the tip for a genuine keyboard Tab inside a visible window", () => {
      const child = renderCloseButton();

      tabTo(child);
      act(() => {
        vi.advanceTimersByTime(10);
      });

      expect(screen.getByRole("tooltip")).toHaveTextContent("Close the window");
    });
  });
});
