import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Pointer presence — «is the pointer on this element, and do we still have grounds to believe it?»
 *
 * ## The defect this exists to close (G-32-16)
 *
 * `window.hide()` does not move the pointer. A webview that is hidden to the tray therefore emits no
 * `mouseleave`, and any visual driven by `onMouseEnter` / `onMouseLeave` alone — a tooltip, a hover
 * tint, a lit close button — keeps the state it had at the moment of the hide. React is not
 * unmounted by a hide, so the state comes back with the window, painted over a webview the pointer
 * has never been in. It stays until an unrelated movement finally produces the missing `mouseleave`.
 * The owner met this on the most common gesture in the program and called it the most irritating
 * defect in testing.
 *
 * ## What has already been tried, and measured to fail
 *
 * Twice, the fix was a longer list of events to switch visibility off with:
 *
 *  1. a per-component `tauri://blur` subscription. It covered the leaving edge only, and under
 *     vitest it was a silent no-op, so no test could ever have failed because of the bug;
 *  2. presence-with-an-expiry, driven by `blur` / `focus` / `pagehide` / `visibilitychange` at the
 *     document level plus the `tauri://blur` / `tauri://focus` pair. **This shipped as build
 *     `t3ykm8` and the tooltip still hung on a real Windows install.** The binary he ran was verified
 *     byte-identical to the one in the installer, so the failure is not a testing mistake: on his
 *     close-to-tray path, none of those signals reaches this document. What the previous round
 *     called «reasoned, not measured» has now been measured, and it is false.
 *
 * A third, longer list is not the answer. The signal has to be one the document produces by itself.
 *
 * ## The signal that needs no event
 *
 * While something is on screen the page is painting frames. Hide the window and the frames stop;
 * show it and they resume. **The interval between two consecutive animation frames is therefore
 * evidence in itself that the window was not being presented** — and so that the document could not
 * have been observing the pointer across it. Nothing has to tell us; the clock simply stops ticking
 * and the length of the gap is the measurement. It arrives with no cooperation from WebView2, from
 * Tauri, or from the window manager, and it lands exactly when the user sees the window again,
 * because the frame that reveals the gap IS the first frame of the restored window.
 *
 * ### The threshold, and why this number
 *
 * `FRAME_GAP_EXPIRY_MS` is 1000. The number has to separate two populations:
 *
 *  - **What a visible window does to itself.** A dropped frame at 60 Hz is 17 ms. A visible stutter
 *    is a handful of frames, 50–100 ms. The worst this app can inflict on its own main thread — a
 *    large React commit, a garbage-collection pause, a synchronous IPC round trip — is a few hundred
 *    milliseconds. 1000 ms is roughly sixty missed frames: an order of magnitude clear of all of it.
 *  - **What a hidden window does.** Chromium does not *slow* `requestAnimationFrame` for a page it
 *    is not presenting, it stops delivering it altogether, so there is no throttled-but-alive regime
 *    at (say) 1 Hz for a 1000 ms threshold to mistake for a hide. (Timer throttling to 1 s is a
 *    different mechanism, and the clock here is deliberately not built on timers.) And the gesture
 *    at the other end is human: hide to the tray, find the tray icon, click it. Even hurried, that
 *    is well over a second.
 *
 * The asymmetry of the costs decides the tie. A false expiry costs the user a tooltip that returns
 * on the next real hover. A missed expiry is the defect he has now reported twice.
 *
 * ## Two more rules, because the first one has a blind spot
 *
 * The frame gap assumes a hidden window stops painting. If some WebView2 configuration keeps
 * painting one, no gap ever opens — so the same loop carries two further checks that are only
 * reachable *because* frames are still arriving. Between them the branches are closed: either the
 * frames stop (gap) or they continue (poll).
 *
 *  - **The focus poll.** The window is asked, every frame, whether it still has focus, instead of
 *    waiting for a `blur` event that may never be delivered. Self-calibrating: it is armed only if
 *    the window HAD focus when the pointer arrived, so hovering a control on a background window —
 *    legitimate, and what Windows itself does — is not policed.
 *  - **The `:hover` cross-check.** The DOM is asked whether the pointer is still on the trigger.
 *    This is the most direct evidence available and it also catches a case no event covers: a
 *    re-render that slides the element out from under a motionless cursor. It cannot be trusted
 *    blind, because whether an environment tracks `:hover` at all depends on how the hover arrived
 *    — jsdom answers `true` for an element that received a dispatched `mouseenter` (measured) and
 *    `false` for one that never saw a mouse event, and a hover established by anything other than a
 *    real pointer gesture will read `false` while the pointer is demonstrably there. So it
 *    calibrates itself on the first frame after the pointer arrives: a `:hover` that disagrees with
 *    an arrival it should have seen is not consulted again for that episode.
 *
 * ## The event listeners are kept, and demoted
 *
 * `blur`, `focus`, `pagehide`, `visibilitychange` and the `tauri://blur` / `tauri://focus` pair are
 * still subscribed — one set for the whole app, not one per component. They cost nothing and on some
 * machines they may well fire. They are simply no longer the mechanism, because on at least one
 * machine they demonstrably do not.
 *
 * ## Instrumentation
 *
 * Every expiry that actually took something off the screen writes the name of the signal that fired
 * through `write_activity_log`. Volume is inherently low: an expiry only happens when something was
 * showing. This project has paid twice for a hook that failed silently — G-32-8 cost three wrong
 * diagnoses of auto-connect, and this defect cost a shipped build — so if the next build still hangs
 * the answer is read out of `activity.log` rather than guessed at. D-29: the signal name and the
 * measured timing, nothing else.
 *
 * **And it worked.** The log from build `v8qc2r` reads `pointer presence expired: blur` and
 * `pointer presence expired: hover-recheck` at the right moments, which acquitted everything above
 * and moved the search to the one thing it does not cover — see the next block.
 *
 * ## Round three: presence was never the whole question
 *
 * Presence answers «is the pointer on the element». It says nothing about a claim raised by FOCUS,
 * and `Tooltip` has one: a keyboard user's tip. On the path the window comes back, Windows
 * restores focus to the button he last pressed, the DOM re-fires `focus` on it, and that was read as
 * a keyboard Tab — so the tip went back up a moment after presence had correctly taken it down.
 *
 * A focus event is therefore not evidence of a user. The evidence is whether the user DID anything
 * in this document that could have produced it: a Tab keydown, a mouse press, a tap. Those arrive in
 * the same task as the focus they cause, while a window returning from the tray arrives seconds
 * after the last thing the user did here — his press on «Закрыть», before the window ever left.
 * `isFocusUserInitiated` below is that question, and it is asked at the moment the tip would be
 * shown rather than when the window left, because a check on the way out has to be delivered an
 * event this machine has already been measured not to send.
 *
 * ## Round four: the third path, and why «recently» was not enough (G-32-20)
 *
 * The owner found it a day later: «а что, нельзя сразу во всех местах "починить" тултип? а то только
 * на "закрыть" окно пофиксил. А если модалку закрываю — там тултип остаётся». He is right that this
 * should have been fixed everywhere at once.
 *
 * A dialog returns focus to the control that opened it when it closes. That is correct
 * accessibility behaviour and it is not going to change. But closing a dialog IS something the user
 * did a moment earlier — he clicked its close button — so the restored focus sails through the
 * contemporaneity test above, `focusShow` goes true, and the tip is painted with the pointer
 * nowhere near. Round three's rule was not wrong; it was answering a coarser question than the one
 * that matters. «Did the user do something recently» is not «did the user navigate HERE».
 *
 * ### The measurement that decided the design
 *
 * The obvious candidate was `:focus-visible` — the platform's own answer to «is this a keyboard user
 * navigating», maintained by the engine instead of guessed by us. It was measured rather than
 * assumed this time, over CDP against Edge 152.0.4191.66 (the engine behind the installed WebView2
 * runtime), driving real trusted input:
 *
 *  | sequence | `:focus-visible` |
 *  |---|---|
 *  | a real Tab | true |
 *  | a real mouse click, in a document where no key has ever been pressed | false |
 *  | mouse-open / mouse-close / script restore, no key ever pressed | false — the answer we want |
 *  | **the same, after ANY earlier keypress anywhere in the document** | **true** |
 *  | a real mouse click on an element, after any earlier keypress | **true** |
 *
 * Blink's flag is «has this document ever seen a keydown», and it is sticky: one keypress — a plain
 * letter will do — and every later focus in that document matches `:focus-visible`, including a
 * plain mouse click. In an app where the user types a server address and a password within seconds
 * of opening it, that is permanently true, so `:focus-visible` would not have fixed this defect and
 * would have re-opened the one round three closed. It is refuted here by measurement, not by
 * argument, and it is not used.
 *
 * ### What is used instead: stop inferring, and ask the party that knows
 *
 * Every round so far swapped one proxy for another — «did an event fire», «was there a frame gap»,
 * «did the user press something recently». For this class there is no need for a proxy at all,
 * because **the app itself is the thing moving the focus**. `Modal` calls `.focus()` on the opener;
 * `OverflowMenu` calls it on its trigger. They know, at the instant they do it, that this focus is
 * not a person navigating. `placeFocus` is them saying so.
 *
 * That closes the class by exhausting it rather than by enumerating it. A focus is moved either by
 * our own code or by something outside it, and there is no third party:
 *
 *  - **our code moved it** → `placeFocus` has the marker up while the event is dispatched (Blink
 *    dispatches `focus` and `focusin` synchronously inside `.focus()` — measured, same harness), so
 *    the refusal is exact and needs no threshold at all;
 *  - **something outside moved it** — Windows restoring a window from the tray, where no code of
 *    ours runs — → nothing can be marked, and the contemporaneity rule above is what catches it.
 *
 * Neither rule is a weaker copy of the other: each covers the branch the other cannot see. The
 * remaining failure mode is a future call site that moves focus without saying so, and that is not
 * left to memory — `focusHygiene.test.ts` fails the build for a `.focus()` in `src/` that neither
 * routes through `placeFocus` nor carries an explicit note saying why it is the user navigating.
 */

/** Which rule took presence away. Written verbatim into the activity log. */
export type PresenceSignal =
  | "frame-gap"
  | "focus-poll"
  | "hover-recheck"
  | "blur"
  | "focus"
  | "pagehide"
  | "visibilitychange"
  | "tauri-blur"
  | "tauri-focus";

/**
 * How long a silence between painted frames has to be before it means «this window was not on
 * screen» rather than «this window was busy». See the threshold discussion above for the number.
 */
export const FRAME_GAP_EXPIRY_MS = 1000;

/**
 * How long after a user input event a focus may still be attributed to it.
 *
 * The two populations this has to separate are even further apart than the frame-gap ones:
 *
 *  - **A focus the user caused.** A `Tab` keydown moves focus in the same task, before the next
 *    frame is painted; so does a mouse press. Sub-millisecond, in practice. 500 ms is thirty frames
 *    of slack on top of that, enough for an activation that routes through a React commit first.
 *  - **A focus a returning window caused.** The window went to the tray, the user found the tray
 *    icon and clicked it. The last thing he did in THIS document was the press on «Закрыть» before
 *    it left. Seconds, and the same human gesture the frame-gap threshold reasons about.
 *
 * The asymmetry of the costs again decides the tie, and it is even more lopsided here: too strict
 * costs a keyboard user a tip that returns the moment he presses Tab again; too loose is the defect
 * that has now shipped twice.
 */
export const FOCUS_INTENT_WINDOW_MS = 500;

/**
 * When this document last saw an input event that could father a focus. `null` = never.
 *
 * Module state deliberately: it is a property of the document, not of a component, and the whole
 * point is that it SURVIVES the focus events in between. His press on «Закрыть» is still the last
 * thing he did here when the window comes back seconds later and re-fires focus on that button.
 */
let lastUserInputAt: number | null = null;

/**
 * Input events that can produce a focus.
 *
 * `mousemove` and `wheel` are excluded on purpose. They do not move focus, and a stray movement on
 * the way back from the tray would otherwise hand the returning focus an alibi it has not earned.
 * `pointerdown` and `mousedown` both fire for one mouse press; recording the same instant twice
 * costs nothing and means neither browser quirk can leave the press unrecorded.
 */
const USER_INPUT_EVENTS = ["keydown", "pointerdown", "mousedown", "touchstart"] as const;

function noteUserInput(): void {
  lastUserInputAt = Date.now();
}

/**
 * Can a focus event that has just arrived be attributed to something the user did in this document?
 *
 * Asked at the moment a focus-driven visual would be SHOWN, which is what makes it survive the
 * case: the element is focused before the window is hidden and the focus event arrives only
 * on the way back, so there is nothing to notice on the way out — and nothing was being delivered
 * there anyway, as build `t3ykm8` measured.
 *
 * A negative interval means the clock moved backwards (an NTP correction in the wild, a reinstalled
 * fake clock between tests). Unattributable, so refused: the safe direction is the one where a
 * keyboard user presses Tab again, not the one where a tip hangs over a window nobody looked at.
 *
 * Logs its refusals. That is not a side effect to tidy away — three builds have now been spent on
 * code that was supposed to prevent this and left no trace of having run.
 */
export function isFocusUserInitiated(): boolean {
  const since = lastUserInputAt === null ? null : Date.now() - lastUserInputAt;
  if (since !== null && since >= 0 && since <= FOCUS_INTENT_WINDOW_MS) return true;
  logLine(
    "pointer focus refused: no user input",
    since === null ? "sinceInput=never" : `sinceInput=${Math.round(since)}ms`,
  );
  return false;
}

/**
 * How deep we are inside a focus this application is placing itself.
 *
 * A counter rather than a flag: `Modal`'s restore can in principle run while another placement is
 * on the stack (a dialog closing from inside another dialog's cleanup), and a flag would be cleared
 * by the inner one while the outer is still going.
 */
let placingFocusDepth = 0;

/**
 * Move focus somewhere because the APPLICATION decided to, not because the user navigated there.
 *
 * Use it for every focus the app places on the user's behalf — a dialog returning focus to the
 * control that opened it, a dialog taking focus when it opens, a menu handing focus back to its
 * trigger, an input re-focused after its own clear button was pressed. Do NOT use it for roving
 * focus inside a composite widget (arrow keys in a tab strip, Tab inside a focus trap): there the
 * user really is navigating, and suppressing the tooltip would take an affordance away from a
 * keyboard user for no reason.
 *
 * Blink dispatches `focus` and `focusin` synchronously from inside `.focus()` — measured over CDP
 * against Edge 152.0.4191.66, with a marker set around the call and read from the listener — and so
 * does jsdom. That synchronicity is the whole mechanism: the handler runs while the marker is up,
 * so no timing threshold is involved and nothing has to be guessed.
 *
 * `finally` rather than a plain decrement, because a focus handler that throws must not leave the
 * marker stuck up. Stuck up, every later keyboard focus in the session would be silently refused —
 * the failure would look exactly like the defect this replaces.
 */
export function placeFocus(el: { focus: () => void } | null | undefined): void {
  if (!el) return;
  placingFocusDepth++;
  try {
    el.focus();
  } finally {
    placingFocusDepth--;
  }
}

/**
 * Is the focus now being delivered one the application placed itself?
 *
 * Asked at show time by anything that would raise a visual on focus. Logs its refusals for the same
 * reason `isFocusUserInitiated` does: three builds of this defect were spent on code that left no
 * trace of having run, and the fourth round only started from a reading instead of a guess because
 * the instrumentation from the second one was there.
 *
 * D-29: the element's TAG NAME and nothing else. Not its label, not its value — a config row's
 * tooltip carries a username, and this line goes to a file on disk.
 */
export function isFocusBeingPlaced(target?: EventTarget | null): boolean {
  if (placingFocusDepth <= 0) return false;
  const tag = target instanceof Element ? target.tagName : "unknown";
  logLine("pointer focus refused: app-placed", `target=${tag}`);
  return true;
}

interface Subscriber {
  notify: (signal: PresenceSignal) => void;
  /** True while this subscriber has something on screen. Gates the frame clock and the log. */
  active: boolean;
  /** The element to cross-check against `:hover`, when the caller has one to offer. */
  hoverTarget: { readonly current: HTMLElement | null } | null;
  /** `null` = not yet calibrated; `false` = this environment cannot answer `:hover`. */
  hoverAnswerable: boolean | null;
}

const subscribers = new Set<Subscriber>();
let detachDom: (() => void) | null = null;
let detachTauri: (() => void) | null = null;
let tauriPending = false;

function anyActive(): boolean {
  for (const s of subscribers) if (s.active) return true;
  return false;
}

/** Record which signal expired a live hover. */
function logExpiry(signal: PresenceSignal, gapMs: number | null): void {
  logLine(
    `pointer presence expired: ${signal}`,
    gapMs === null ? undefined : `gap=${Math.round(gapMs)}ms`,
  );
}

/**
 * One line into the activity log, and never a way for the log to change what it is watching.
 *
 * Defended twice over: the invoke may reject (no IPC in Storybook, and the tray popup's window has
 * no capability for this command) and in a non-Tauri runtime it throws synchronously.
 */
function logLine(message: string, details?: string): void {
  try {
    void Promise.resolve(invoke("write_activity_log", { tag: "STATE", message, details })).catch(
      () => {},
    );
  } catch {
    // No IPC at all. Nothing to do and nothing to report.
  }
}

/** Expire everything, and account for it once if anything was on screen. */
function notifyAll(signal: PresenceSignal, gapMs: number | null = null): void {
  // One line per expiry, not one per subscriber: hovering the close button holds presence in both
  // `Tooltip` and `WindowControls`, and that is one event in the world.
  if (anyActive()) logExpiry(signal, gapMs);
  // Copy first: a subscriber may unmount (and unsubscribe) from inside its own callback.
  for (const fn of [...subscribers]) fn.notify(signal);
}

/**
 * Expire one subscriber — used by `:hover`, which is answered per element.
 *
 * No `active` check here on purpose. The only caller has already established it, and a second copy
 * of the condition would be a guard that can never fail — the shape of check this phase has already
 * caught itself writing twice.
 */
function notifyOne(s: Subscriber, signal: PresenceSignal): void {
  logExpiry(signal, null);
  s.notify(signal);
}

// ---------------------------------------------------------------------------
// The frame clock
// ---------------------------------------------------------------------------

let clockRunning = false;
let frameHandle: number | null = null;
let lastFrameAt: number | null = null;
let schedulingFrame = false;
let hadFocusWhenClockStarted = false;

function documentHasFocus(): boolean {
  try {
    if (typeof document === "undefined" || typeof document.hasFocus !== "function") return false;
    return document.hasFocus();
  } catch {
    return false;
  }
}

function startClock(): void {
  if (clockRunning) return;
  clockRunning = true;
  // A gap is only meaningful between two frames observed during the SAME episode, so the first
  // frame after arming seeds the clock rather than being compared with an ancient timestamp.
  lastFrameAt = null;
  hadFocusWhenClockStarted = documentHasFocus();
  scheduleFrame();
}

function stopClock(): void {
  clockRunning = false;
  lastFrameAt = null;
  if (frameHandle !== null) {
    try {
      window.cancelAnimationFrame(frameHandle);
    } catch {
      // Nothing to cancel in a runtime without rAF; the guards below cover it either way.
    }
    frameHandle = null;
  }
}

function scheduleFrame(): void {
  if (!clockRunning || frameHandle !== null || schedulingFrame) return;
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;

  // `schedulingFrame` is the whole re-entrancy defence. A `requestAnimationFrame` that runs its
  // callback synchronously is not a frame clock — it is the jsdom shim in src/test/setup.ts,
  // `(cb) => { cb(0); return 0; }`. Chaining on that recurses until the stack blows, which would
  // take out every Tooltip, WindowControls and PresetGrid test in the suite. Under such a shim the
  // callback runs while this flag is still up, the re-schedule it asks for is refused, and the clock
  // takes the single observation it can get and goes quiet.
  schedulingFrame = true;
  try {
    frameHandle = window.requestAnimationFrame(onFrame);
  } finally {
    schedulingFrame = false;
  }
}

function onFrame(timestamp: number): void {
  frameHandle = null;

  if (!clockRunning) return;

  const previous = lastFrameAt;
  lastFrameAt = timestamp;

  // The `stopClock()` in the two branches below is belt, not braces. Our own callers all drop their
  // `active` when notified, and the effect that watches it stops the clock a beat later — so no test
  // can tell the difference and none is claimed to. It is here for a future caller that ignores the
  // signal: without it the clock would stay MARKED running with nothing pending, `startClock` would
  // keep early-returning, and the rule would be quietly dead for the rest of the session.

  // 1. The gap. The window was not being presented, so it cannot have been watching the pointer.
  if (previous !== null && timestamp - previous > FRAME_GAP_EXPIRY_MS) {
    const gap = timestamp - previous;
    stopClock();
    notifyAll("frame-gap", gap);
    return;
  }

  // 2. Focus, polled rather than awaited — for the branch where a hidden window keeps painting.
  if (hadFocusWhenClockStarted && !documentHasFocus()) {
    stopClock();
    notifyAll("focus-poll", null);
    return;
  }

  // 3. `:hover`, per subscriber, where the DOM has shown it can answer.
  for (const s of [...subscribers]) {
    if (s.active && hoverLost(s)) notifyOne(s, "hover-recheck");
  }

  // The one place the loop is allowed to end. Not just an optimisation: the active subscriber may
  // have UNMOUNTED while other idle ones kept the module attached, in which case nothing else in the
  // system would ever stop the clock and it would spin at 60 fps for the rest of the session.
  if (anyActive()) scheduleFrame();
  else stopClock();
}

/**
 * Has the DOM positively reported that the pointer is no longer on this subscriber's element?
 *
 * Calibrates on the first frame of the episode: if `:hover` says «no» while the pointer has
 * demonstrably just arrived, this environment is not tracking the hover we are looking at and is not
 * asked again. Only a `:hover` that has already been seen to agree is allowed to disagree.
 */
function hoverLost(s: Subscriber): boolean {
  const el = s.hoverTarget?.current;
  if (!el) return false;

  let onIt: boolean;
  try {
    onIt = el.matches(":hover");
  } catch {
    s.hoverAnswerable = false;
    return false;
  }

  if (s.hoverAnswerable === null) {
    s.hoverAnswerable = onIt;
    return false;
  }
  return s.hoverAnswerable && !onIt;
}

// ---------------------------------------------------------------------------
// The event listeners — kept, and no longer relied upon
// ---------------------------------------------------------------------------

function attachTauri(): void {
  if (detachTauri || tauriPending) return;
  tauriPending = true;
  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const unlistenBlur = await win.listen("tauri://blur", () => notifyAll("tauri-blur"));
      const unlistenFocus = await win.listen("tauri://focus", () => notifyAll("tauri-focus"));
      const detach = () => {
        // Teardown must not throw: `detachIfIdle` runs from a React cleanup, outside any try.
        try {
          unlistenBlur();
          unlistenFocus();
        } catch {
          // Already gone.
        }
      };
      // Everything may have unmounted while the two awaits were in flight.
      if (subscribers.size === 0) detach();
      else detachTauri = detach;
    } catch {
      // No Tauri runtime (vitest / Storybook / SSR). The frame clock carries the rule on its own;
      // this subscription was never the mechanism, and since build t3ykm8 it is not even trusted.
    } finally {
      tauriPending = false;
    }
  })();
}

function attach(): void {
  if (detachDom) return;
  const onBlur = () => notifyAll("blur");
  const onFocusEvent = () => notifyAll("focus");
  const onPageHide = () => notifyAll("pagehide");
  const onVisibility = () => notifyAll("visibilitychange");
  window.addEventListener("blur", onBlur);
  window.addEventListener("focus", onFocusEvent);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);
  // Capture phase, so a `stopPropagation` anywhere in the app cannot hide a user's action from the
  // bookkeeping. Passive in every sense: it writes one timestamp and reads nothing. If the last
  // subscriber unmounts these come off too and the timestamp goes stale, which fails toward
  // refusing a focus — the safe direction.
  for (const type of USER_INPUT_EVENTS) document.addEventListener(type, noteUserInput, true);
  detachDom = () => {
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("focus", onFocusEvent);
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
    for (const type of USER_INPUT_EVENTS) document.removeEventListener(type, noteUserInput, true);
  };
  attachTauri();
}

function detachIfIdle(): void {
  if (subscribers.size > 0) return;
  stopClock();
  detachDom?.();
  detachDom = null;
  detachTauri?.();
  detachTauri = null;
}

/**
 * Can the document currently vouch for where the pointer is?
 *
 * A precondition, not an event: callers that show something on a delay re-check this when the timer
 * elapses, so a timer armed before a hide cannot fire into a hidden window. This catches the case
 * where the webview went invisible without emitting anything.
 */
export function canObservePointer(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState !== "hidden";
}

/**
 * Run `onLoss` whenever the document stops being able to vouch for the pointer position.
 *
 * For callers that keep their own hover shape — `WindowControls` holds which of two buttons is lit,
 * not a boolean — and only need the expiry.
 *
 * @param onLoss called with the name of the signal that fired.
 * @param active whether this caller currently has something on screen. **Load-bearing:** it arms
 *               the frame clock (which otherwise does not run at all) and it is how the log knows
 *               an expiry took something down rather than firing into an empty screen.
 * @param hoverTargetRef optional element for the `:hover` cross-check.
 */
export function usePointerContextLoss(
  onLoss: (signal: PresenceSignal) => void,
  active = false,
  hoverTargetRef?: { readonly current: HTMLElement | null },
): void {
  const latest = useRef(onLoss);
  useEffect(() => {
    latest.current = onLoss;
  });

  const record = useRef<Subscriber | null>(null);

  useEffect(() => {
    const subscriber: Subscriber = {
      notify: (signal) => latest.current(signal),
      active: false,
      hoverTarget: null,
      hoverAnswerable: null,
    };
    record.current = subscriber;
    subscribers.add(subscriber);
    attach();
    return () => {
      subscribers.delete(subscriber);
      record.current = null;
      detachIfIdle();
    };
  }, []);

  // Declared after the subscription effect so `record.current` is set by the time it first runs.
  useEffect(() => {
    const subscriber = record.current;
    if (!subscriber) return;
    subscriber.hoverTarget = hoverTargetRef ?? null;
    if (subscriber.active === active) return;
    subscriber.active = active;
    if (active) {
      // A fresh episode: whatever this environment last said about `:hover` is re-learned.
      subscriber.hoverAnswerable = null;
      startClock();
    } else if (!anyActive()) {
      stopClock();
    }
  }, [active, hoverTargetRef]);
}

export interface PointerPresence {
  /** True only while the pointer is attested to be over the element. Drives rendering. */
  present: boolean;
  /**
   * The same fact, readable from inside a timer callback without capturing a stale render.
   * A delayed reveal must consult THIS, not the `present` it closed over when it was armed.
   */
  presentRef: React.RefObject<boolean>;
  /** Wire to `onMouseEnter`. */
  enter: () => void;
  /** Wire to `onMouseLeave`. */
  leave: () => void;
}

/**
 * Boolean pointer presence for a single element.
 *
 * @param onLoss optional extra teardown to run when presence expires — e.g. clearing a pending
 *               reveal timer. Called on every expiry, including ones where presence was already
 *               false, so keep it cheap and idempotent. Receives the signal that fired, because a
 *               caller holding more than pointer state needs to tell the WINDOW going away
 *               (`frame-gap`, `blur`, `focus`, …) from this element's own `hover-recheck`.
 * @param hoverTargetRef the element the pointer is supposed to be on. Supplying it enables the
 *               `:hover` cross-check; omitting it simply leaves that one rule unused.
 */
export function usePointerPresence(
  onLoss?: (signal: PresenceSignal) => void,
  hoverTargetRef?: { readonly current: HTMLElement | null },
): PointerPresence {
  const [present, setPresent] = useState(false);
  const presentRef = useRef(false);

  const set = useCallback((next: boolean) => {
    presentRef.current = next;
    // A no-op when the value is unchanged: React bails out, so the app-wide broadcast on every
    // alt-tab does not re-render every mounted subscriber.
    setPresent(next);
  }, []);

  const onLossRef = useRef(onLoss);
  useEffect(() => {
    onLossRef.current = onLoss;
  });

  usePointerContextLoss(
    useCallback(
      (signal: PresenceSignal) => {
        set(false);
        onLossRef.current?.(signal);
      },
      [set],
    ),
    present,
    hoverTargetRef,
  );

  return {
    present,
    presentRef,
    enter: useCallback(() => set(true), [set]),
    leave: useCallback(() => set(false), [set]),
  };
}
