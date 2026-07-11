import React, { createElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./shared/styles/tokens.css";
import "./index.css";
import { ConnectionToast } from "./components/connection/ConnectionToast";
import {
  getNotificationCopy,
  buildBody,
  plateCloseCopy,
  type NotifyKind,
  type PlateLang,
} from "./components/connection/notificationCopy";
import { plateLifetime } from "./components/connection/plateLifetime";
import { buildConnectDetails } from "./components/connection/plateDetails";

/**
 * The desktop connection-notification plate — Phase 13 (Plan 13-03, Wave 2).
 *
 * Its OWN Vite entry (notification.html → this file), mirroring tray-menu.tsx: a separate
 * always-on-top, skip-taskbar, non-activating webview window built once in lib.rs .setup(),
 * repositioned + shown by Rust (notify::maybe_fire) on a real VPN status transition. This root is a
 * PASSIVE renderer — it does NOT decide whether to fire and does NOT read the master gate
 * (`tt_notifications_enabled`) from localStorage (Pitfall 5 — separate webview store; the gate is
 * Rust-side). It only renders what the `notify-plate` event tells it.
 *
 * Wiring:
 *   - listens `notify-plate` { kind, configName } → looks up the copy + starts/resets the timer
 *   - D-03: a new event REPLACES the plate and RESETS the auto-dismiss timer (clear-then-restart)
 *   - D-02: `connectionError` is sticky (no timer); every other kind auto-dismisses (~4.5s)
 *   - D-04: body click → invoke("restore_main_window") (Rust restores main + hides this plate);
 *           × → hide self; for a connectionError plate it FIRST invoke("clear_vpn_error") so the
 *           acknowledge turns the tray gray (19-01 Bug 1), then hides. The auto-timer callback also hides self
 */

/** The event payload the Rust decider emits — a KIND plus the config DISPLAY NAME only (D-29;
 *  never the `.toml` content or the password). `configName` may be empty (no active config). */
interface NotifyPlatePayload {
  kind: NotifyKind;
  configName: string;
  /** Phase 13 (13-06) — the app's effective theme ("dark" | "light"), threaded from Rust so the
   *  plate stamps its OWN `data-theme` before rendering. Without it the plate's empty-localStorage
   *  webview falls to the `:root` dark defaults and stays dark on the light app theme (UAT round-2
   *  defect 1). Optional on the wire — a missing/legacy payload defaults to "dark" (the :root fallback). */
  theme?: "dark" | "light";
  /** Phase 13 (13-07) — the app's UI language ("ru" | "en"), threaded from Rust so the plate renders
   *  the right-language copy. The plate copy was hardcoded Russian and this webview has an empty
   *  localStorage, so it stayed Russian on the English app language (UAT round-3 defect 2). Optional
   *  on the wire — a missing/legacy payload defaults to "ru" (the app's primary language). */
  language?: PlateLang;
  /** Phase 13 (13-08) — the endpoint ADDRESS ("host:port"), threaded from Rust for CONNECT kinds only
   *  (connected / autoConnected / autoSwitched). Present → the plate shows the richer detail block
   *  under the body; absent → the plate stays compact (disconnect / error / reconnect). D-29: this is
   *  the endpoint host, NEVER the password. */
  address?: string;
  /** Phase 13 (13-08) — the endpoint LOGIN (username), threaded from Rust for CONNECT kinds only.
   *  D-29: the username, NEVER the password. */
  login?: string;
  /** Phase 13 (13-08) — the connect-time reachability PING in ms, threaded from Rust for CONNECT
   *  kinds only. A number → coloured by quality; absent/`null` → the plate renders «—» (no data). */
  pingMs?: number;
}

/** One plate render's data — the resolved copy for the current event. `null` before the first
 *  event (the window is built hidden, so nothing renders until Rust shows + emits). */
interface PlateState {
  kind: NotifyKind;
  configName: string;
  language: PlateLang;
  /** Phase 13 (13-08) — the CONNECT detail block (address / login / ping), present ONLY for the
   *  connect kinds; `null` for the compact kinds (disconnect / error / reconnect). Resolved once in
   *  `applyPlate` (shared path) so the live listener and the mount pull render details identically. */
  address: string | null;
  login: string | null;
  pingMs: number | null;
}

function hideSelf() {
  void getCurrentWindow().hide();
}

/** Exported for unit test (13-05). The production bootstrap at the bottom of this entry file
 *  mounts it under StrictMode; the test imports it directly so it can drive the mount pull without
 *  the createRoot side effect firing against a missing `notification-root`. */
export function NotificationPlate() {
  const [plate, setPlate] = useState<PlateState | null>(null);
  // The running auto-dismiss timeout id, so a replace (D-03) can CLEAR it before restarting.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // D-08 / Pitfall 3 (mirrors tray-menu.tsx): harden the async-unlisten StrictMode race. This
    // file mounts under <React.StrictMode>, so the effect runs mount → unmount → mount. A bare
    // `unlisten.then((fn) => fn())` cleanup can let a late-resolving listener survive the first
    // unmount (double registration → double plate updates). Guard with a cancelled flag + stored
    // fn: if cleanup already ran when listen() resolves, unlisten immediately.
    let cancelled = false;
    let resolvedUnlisten: (() => void) | null = null;

    // Factored so the live listener AND the mount pull (13-05) apply a plate through the EXACT same
    // path — redelivery of a fire that beat the mount is then byte-identical to a live event.
    // D-03: clear any running auto-dismiss BEFORE (re)rendering so the new event starts a fresh
    // lifetime from the current kind's policy — the plate always reflects the CURRENT state and
    // never carries a stale timer. This clear-then-arm is exactly what makes a double-apply (the
    // same event via both the live listener and the pull, in the narrow post-listen/pre-pull
    // window) leave only a SINGLE live timer.
    const applyPlate = (
      kind: NotifyKind,
      configName: string,
      theme?: "dark" | "light",
      language?: PlateLang,
      address?: string,
      login?: string,
      pingMs?: number,
    ) => {
      // 13-06: stamp the plate webview's OWN `data-theme` from the payload BEFORE rendering. This
      // window has an empty localStorage (Pitfall 5), so `useTheme` never set it here; without this
      // the tokens fall to the `:root` dark defaults and the plate stays dark on the light app theme
      // (UAT round-2 defect 1). Default "dark" if the theme is missing (a legacy/edge payload) — that
      // matches the `:root` fallback, so a missing theme is no worse than before. Applied on the
      // SHARED render path so BOTH the live listener and the mount pull theme the plate identically.
      document.documentElement.setAttribute("data-theme", theme ?? "dark");

      // Review #18 (WCAG 3.1.1): also stamp the DOCUMENT language per event. notification.html
      // hardcodes `lang="ru"`, so without this the English plate content was announced under a
      // Russian document language. Same default as the render state ("ru" — the app's primary
      // language) so the document language always matches the rendered copy.
      document.documentElement.lang = language ?? "ru";

      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      // 13-07: carry the payload language into the render state (default "ru" — the app's primary
      // language — for a missing/legacy payload) so the render picks the right-language copy.
      // 13-08: carry the CONNECT detail fields (address / login / ping). Rust sends them ONLY for the
      // connect kinds; a compact kind (disconnect / error / reconnect) sends none, so they arrive
      // undefined → stored as null → the render shows no detail block. `pingMs` may legitimately be
      // undefined even on a connect kind (no measurement) — normalise to null so `buildConnectDetails`
      // renders the honest «—».
      setPlate({
        kind,
        configName,
        language: language ?? "ru",
        address: address ?? null,
        login: login ?? null,
        pingMs: pingMs ?? null,
      });

      // D-02: sticky kinds (connectionError) carry no timer — they wait for an explicit × close.
      // Every other kind auto-dismisses after the policy's autoDismissMs.
      const lifetime = plateLifetime(kind);
      if (!lifetime.sticky && lifetime.autoDismissMs !== undefined) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          hideSelf();
        }, lifetime.autoDismissMs);
      }
    };

    const unlisten = listen<NotifyPlatePayload>("notify-plate", (e) => {
      const payload = e.payload;
      if (!payload?.kind) return;
      applyPlate(
        payload.kind,
        payload.configName ?? "",
        payload.theme,
        payload.language,
        payload.address,
        payload.login,
        payload.pingMs,
      );
    });

    void unlisten.then((fn) => {
      if (cancelled) fn();
      else resolvedUnlisten = fn;
    });

    // 13-05: AFTER the notify-plate listener is attached (listen() registered the subscription
    // synchronously above), PULL the staged plate ONCE to recover a fire that beat this mount (the
    // emit-before-listener race — the empty-black-plate-at-launch blocker). The pull runs after
    // listen() so it can never MISS a fire; it redelivers ONLY a fire that beat the mount. A fire
    // landing in the narrow post-listen/pre-pull window may be applied by BOTH the live listener
    // AND this pull — that is SAFE and intended: applyPlate is idempotent (same {kind, configName}
    // → identical rendered state; the only effect of a double-apply is the auto-dismiss timer
    // restarting from full duration, which is imperceptible). We do NOT add cross-path clearing
    // (e.g. the live listener also pulling to clear the stage) — that adds IPC-per-event and its
    // own subtlety for no user-visible gain.
    void invoke<NotifyPlatePayload | null>("pull_pending_plate").then((payload) => {
      // Guard with the SAME cancelled flag as the unlisten cleanup so a StrictMode
      // mount→unmount→mount cannot apply a stale pull against a torn-down window.
      if (cancelled) return;
      if (payload?.kind) {
        // A staged fire beat the mount — redeliver it through the shared render+timer path. Do NOT hide.
        applyPlate(
          payload.kind,
          payload.configName ?? "",
          payload.theme,
          payload.language,
          payload.address,
          payload.login,
          payload.pingMs,
        );
      } else {
        // Nothing staged: this window was Rust-shown with a lost emit (or is just an idle shown
        // window). Heal it by hiding — safe because Rust owns win.show(), so a later real fire
        // re-shows it via Rust + the now-attached listener. Do NOT render.
        hideSelf();
      }
    });

    return () => {
      cancelled = true;
      if (resolvedUnlisten) resolvedUnlisten();
      // Drop any pending auto-dismiss on unmount so it cannot fire against a torn-down window.
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  // F15 (14-UAT round 2): after the plate content lays out (useLayoutEffect — before paint, keyed on
  // the plate object so it re-runs on EVERY applyPlate, latest-wins/D-03), GROW the window to fit when
  // the content OVERFLOWS the current window. Rust already set the per-kind base height (68/140) in
  // fire_plate_tail; this only needs to grow when a long config name wraps to extra lines
  // (`overflow:hidden` was clipping the bottom padding — owner: «не хватает отступа снизу»). The plate
  // toast is now `min-h-full` (ConnectionToast), so its border-box grows with content and
  // #notification-root.scrollHeight includes the toast's FULL height (content + top/bottom padding +
  // border). GUARD on `scrollHeight > clientHeight` (genuine overflow): (1) it never sends a value
  // smaller than the window, so a stale (not-yet-shrunk) viewport right after Rust set a shorter base
  // is not echoed back to re-grow the window; (2) jsdom reports 0 for both, so the resize is a no-op
  // in tests unless a test stubs scrollHeight.
  useLayoutEffect(() => {
    if (!plate) return;
    const root = document.getElementById("notification-root");
    if (root && root.scrollHeight > root.clientHeight) {
      void invoke("resize_notification_plate", { height: root.scrollHeight }).catch(() => {});
    }
  }, [plate]);

  // Nothing to render before the first event (the window is built hidden).
  if (!plate) return null;

  // 13-07: resolve the copy in the plate's threaded language (getNotificationCopy + buildBody both
  // take the language). icon/colour are language-independent; title/body come from the language map.
  const copy = getNotificationCopy(plate.kind, plate.language);

  // 13-08: build the CONNECT detail rows (address / login / ping) ONLY when Rust threaded the connect
  // fields (address + login present — the connect kinds carry them; the compact kinds send none, so
  // this stays undefined and the plate renders no detail block). `pingMs` may be null even here (no
  // measurement) — buildConnectDetails renders the honest «—» for that. Passing the SAME shared
  // builder the Storybook design uses keeps the real plate 1:1 with the approved look. The threaded
  // language picks the ping unit («мс» / "ms" — review #4) so the detail block matches the copy.
  const details =
    plate.address !== null && plate.login !== null
      ? buildConnectDetails(plate.address, plate.login, plate.pingMs, plate.language)
      : undefined;

  return (
    <ConnectionToast
      // 13-07 (defect 1 «подложка»): variant="plate" — the DWM-rounded opaque WINDOW is the plate,
      // so the toast fills the window and drops its own rounding/border/shadow (no card-on-backing).
      variant="plate"
      icon={createElement(copy.icon, { className: "h-5 w-5" })}
      iconColor={copy.iconColor}
      title={copy.title}
      body={buildBody(plate.kind, plate.configName, plate.language)}
      // 13-08: the richer CONNECT detail block (address / login / ping) — undefined for compact kinds.
      details={details}
      // Review #11: the × label/tooltip were hardcoded Russian inside ConnectionToast, so the close
      // affordance stayed «Закрыть уведомление» on an otherwise-English plate. Resolve the pair from
      // the shared plate copy per the threaded language (the same language as title/body above).
      closeLabel={plateCloseCopy[plate.language].label}
      closeTooltip={plateCloseCopy[plate.language].tooltip}
      // D-04: body click restores the main window from the tray AND hides this plate. The Rust
      // command owns BOTH (show+focus main, hide notification) so the two windows stay in step.
      // Phase 19 UAT (G-19-1): a connectionError plate must ALSO acknowledge the error on a BODY
      // click — mirroring the × path below. The × was fixed in 19-01 to clear the error, but the
      // body click (the natural "take me to the app" gesture) only restored the window and left
      // status at `Error`, so the tray icon stayed RED (restore_main_window performs no status
      // write). clear_vpn_error routes Error→Disconnected through the single status writer →
      // vpn-status emit → lib.rs listener → update_tray_icon("disconnected") → GRAY tray. It is
      // fire-and-forget (.catch swallows) and a no-op unless live status is `Error` (vpn.rs
      // T-09-02), so firing it alongside restore can never knock a live reconnecting/connected
      // session offline. Every OTHER plate kind keeps the plain restore-only behaviour. D-29:
      // clear_vpn_error carries `None` error — no secret reaches the log/status channel.
      onBodyClick={() => {
        if (plate.kind === "connectionError") {
          void invoke("clear_vpn_error").catch(() => {});
        }
        void invoke("restore_main_window");
      }}
      // D-04 (Phase 19, 19-01 Bug 1): the × on a connectionError plate ACKNOWLEDGES the error
      // before hiding — mirroring StatusPanel.handleDismiss. The plate used to only hide its window
      // (hideSelf), so status stayed `Error` and the tray icon stayed RED after the user closed the
      // desktop error notification. Now the connectionError × also invokes the backend
      // `clear_vpn_error`, which routes Error→Disconnected through the single status writer →
      // `vpn-status` emit → lib.rs listener → update_tray_icon("disconnected") → GRAY tray. It is
      // fire-and-forget (.catch swallows): a backend miss still hides locally and the next
      // vpn-status reconciles. `clear_vpn_error` is a no-op unless the live status is `Error`
      // (vpn.rs T-09-02), so closing a STALE error plate after an in-flight reconnect already moved
      // status off Error cannot knock a live session offline — safe to fire unconditionally on the
      // error plate. Every OTHER plate kind keeps the plain hide-only close (no status write). D-29:
      // clear_vpn_error carries `None` error — no secret reaches the log/status channel.
      onClose={() => {
        if (plate.kind === "connectionError") {
          void invoke("clear_vpn_error").catch(() => {});
        }
        hideSelf();
      }}
    />
  );
}

// Production bootstrap. Guarded on the mount node's presence so importing this entry file in a
// unit test (which renders <NotificationPlate/> directly — 13-05) does not fire createRoot against
// a missing `notification-root` and throw.
const notificationRoot = document.getElementById("notification-root");
if (notificationRoot) {
  ReactDOM.createRoot(notificationRoot).render(
    <React.StrictMode>
      <NotificationPlate />
    </React.StrictMode>,
  );
}
