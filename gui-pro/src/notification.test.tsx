// Phase 13 / Plan 13-05 — regression tests for the plate's emit-before-listener recovery.
//
// The UAT test-1 blocker: at launch (auto-connect ON) the plate window was shown by Rust before the
// React root attached its `notify-plate` listener; Tauri v2 does not buffer events for a not-yet-
// subscribed webview, so the Connected fire was DROPPED while the opaque window still showed — an
// empty black box with no content and no auto-dismiss timer. The fix stages the payload in Rust and
// the plate PULLS it once (`pull_pending_plate`) after its listener attaches: a staged payload is
// redelivered through the same render+timer path a live event uses; no staged payload heals the
// stray window by hiding it.
//
// These tests mount the real `NotificationPlate` (exported for test) with the shared Tauri-mock
// discipline (invoke / listen / getCurrentWindow().hide), driving both branches of the mount pull.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import type { EventCallback } from "@tauri-apps/api/event";
import { AUTO_DISMISS_MS } from "./components/connection/plateLifetime";

// --- Tauri surface mocks (mirroring src/test/tauri-mock.ts) -----------------------------------
// invoke: the mount pulls `pull_pending_plate`; each test sets its resolved value.
const invokeMock = vi.fn();
// listen: capture the registered `notify-plate` callback so a test can deliver a LIVE event.
let listenCallback: EventCallback<unknown> | null = null;
const unlistenSpy = vi.fn();
const listenMock = vi.fn((_event: string, cb: EventCallback<unknown>) => {
  listenCallback = cb;
  return Promise.resolve(unlistenSpy);
});
const hideMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, cb: EventCallback<unknown>) => listenMock(event, cb),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ hide: hideMock }),
}));
// The entry file imports CSS — stub so the import is inert under vitest.
vi.mock("./shared/styles/tokens.css", () => ({}));
vi.mock("./index.css", () => ({}));

// Import AFTER the mocks are registered so the module binds to them.
import { NotificationPlate } from "./notification";

/** Flush pending microtasks (the mount effect's `listen().then` + `invoke().then` pull) under fake
 *  timers, where testing-library's `waitFor` (which polls on real timers) cannot advance. Runs
 *  inside `act` so React flushes the resulting state updates. Two ticks: one for listen()'s resolve,
 *  one for the pull's resolve. */
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Deliver a live `notify-plate` event through the captured listener callback (wrapped in act so
 *  React flushes the state update + timer arming). 13-08: accepts the optional CONNECT detail fields
 *  (address / login / pingMs) so a test can drive the richer detail block via the live path. */
async function deliverLiveEvent(
  kind: string,
  configName: string,
  theme?: "dark" | "light",
  language?: "ru" | "en",
  extra?: { address?: string; login?: string; pingMs?: number },
) {
  await act(async () => {
    listenCallback?.({ payload: { kind, configName, theme, language, ...extra } } as never);
    await Promise.resolve();
  });
}

describe("NotificationPlate — pull-and-redeliver on mount (13-05)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    listenMock.mockClear();
    unlistenSpy.mockClear();
    hideMock.mockClear();
    listenCallback = null;
    // 13-06: reset the document theme between tests so a prior test's data-theme cannot leak.
    document.documentElement.removeAttribute("data-theme");
    // Review #18: applyPlate also stamps the DOCUMENT language — reset it between tests too.
    document.documentElement.removeAttribute("lang");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("Test A — a pulled payload redelivers: renders the plate AND arms the auto-dismiss timer", async () => {
    invokeMock.mockResolvedValue({ kind: "connected", configName: "My VPN" });
    render(<NotificationPlate />);
    await flushMicrotasks();

    // The pull resolved and the plate renders its Card + title + × (role="status" from ConnectionToast).
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Подключено")).toBeInTheDocument();
    // The pull did NOT hide the window (a payload path renders, it does not heal).
    expect(hideMock).not.toHaveBeenCalled();

    // Advancing past the auto-dismiss window fires the armed timer → hides the plate exactly once.
    await act(async () => {
      vi.advanceTimersByTime(AUTO_DISMISS_MS + 10);
    });
    expect(hideMock).toHaveBeenCalledTimes(1);
  });

  it("F15 — grows the window to the content height when the content OVERFLOWS the window", async () => {
    // jsdom has no layout, so stub a #notification-root whose content (scrollHeight) overflows the
    // window (clientHeight). The plate's useLayoutEffect invokes resize_notification_plate with the
    // full content height (grow for a long wrapped config name so the bottom padding is never clipped).
    const root = document.createElement("div");
    root.id = "notification-root";
    Object.defineProperty(root, "scrollHeight", { configurable: true, value: 180 });
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 140 });
    document.body.appendChild(root);
    try {
      invokeMock.mockResolvedValue(null); // pull → nothing staged
      render(<NotificationPlate />);
      await flushMicrotasks();
      invokeMock.mockClear();
      await deliverLiveEvent("connected", "My VPN");
      expect(invokeMock).toHaveBeenCalledWith("resize_notification_plate", { height: 180 });
    } finally {
      root.remove();
    }
  });

  it("F15 — does NOT resize when the content fits the window (no overflow → no stale-viewport echo)", async () => {
    // scrollHeight === clientHeight: the content fits (or the viewport hasn't shrunk yet). The guard
    // must NOT invoke — never echo a stale/equal height back to re-grow a window Rust just shrank.
    const root = document.createElement("div");
    root.id = "notification-root";
    Object.defineProperty(root, "scrollHeight", { configurable: true, value: 140 });
    Object.defineProperty(root, "clientHeight", { configurable: true, value: 140 });
    document.body.appendChild(root);
    try {
      invokeMock.mockResolvedValue(null);
      render(<NotificationPlate />);
      await flushMicrotasks();
      invokeMock.mockClear();
      await deliverLiveEvent("connected", "My VPN");
      expect(invokeMock).not.toHaveBeenCalledWith("resize_notification_plate", expect.anything());
    } finally {
      root.remove();
    }
  });

  it("F15 — skips the resize when there is no measurable content", async () => {
    // No #notification-root (jsdom default) → the guard skips the resize invoke.
    invokeMock.mockResolvedValue(null);
    render(<NotificationPlate />);
    await flushMicrotasks();
    invokeMock.mockClear();
    await deliverLiveEvent("connected", "My VPN");
    expect(invokeMock).not.toHaveBeenCalledWith("resize_notification_plate", expect.anything());
  });

  it("Test A (sticky) — a sticky kind (connectionError) redelivers WITHOUT arming a timer", async () => {
    invokeMock.mockResolvedValue({ kind: "connectionError", configName: "My VPN" });
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Ошибка подключения")).toBeInTheDocument();

    // No timer armed for a sticky kind — advancing time must NOT hide the plate.
    await act(async () => {
      vi.advanceTimersByTime(AUTO_DISMISS_MS + 10);
    });
    expect(hideMock).not.toHaveBeenCalled();
  });

  it("Test B — a null pull heals the stray window: renders nothing and hides exactly once", async () => {
    invokeMock.mockResolvedValue(null);
    render(<NotificationPlate />);
    await flushMicrotasks();

    // The heal path hides the window …
    expect(hideMock).toHaveBeenCalledTimes(1);
    // … and renders NO plate.
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("Test C — the two pull branches are mutually exclusive", async () => {
    // null → hide, no render (a payload → render, no hide is asserted in Test A).
    invokeMock.mockResolvedValue(null);
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(hideMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("Test D — a live notify-plate event AFTER mount still renders + arms the timer (warm path intact)", async () => {
    // Nothing staged (null pull), so mount heals — but the live listener must still work.
    invokeMock.mockResolvedValue(null);
    render(<NotificationPlate />);
    await flushMicrotasks();
    expect(hideMock).toHaveBeenCalledTimes(1);
    hideMock.mockClear();

    await deliverLiveEvent("connected", "My VPN");
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Подключено")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(AUTO_DISMISS_MS + 10);
    });
    expect(hideMock).toHaveBeenCalledTimes(1);
  });

  it("Test E — double-apply (mount pull + live listener, same event) is idempotent: one timer, hide once", async () => {
    // The SAME event lands via BOTH the mount pull and the live listener. applyPlate clears any
    // running timer before arming a new one (D-03 replace-resets), so the two applies leave a
    // SINGLE live timer, not two — advancing past one window hides exactly once.
    invokeMock.mockResolvedValue({ kind: "connected", configName: "My VPN" });
    render(<NotificationPlate />);
    await flushMicrotasks();
    // The pull already applied + armed a timer.
    expect(screen.getByRole("status")).toBeInTheDocument();

    // A live event with the SAME {kind, configName} arrives too (the post-listen/pre-pull window).
    await deliverLiveEvent("connected", "My VPN");

    // Still a single plate, identical state.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByText("Подключено")).toBeInTheDocument();

    // Advancing one window hides exactly once — the two applies did not stack two live timers.
    await act(async () => {
      vi.advanceTimersByTime(AUTO_DISMISS_MS + 10);
    });
    expect(hideMock).toHaveBeenCalledTimes(1);
  });
});

describe("NotificationPlate — theme threading (13-06)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    listenMock.mockClear();
    unlistenSpy.mockClear();
    hideMock.mockClear();
    listenCallback = null;
    document.documentElement.removeAttribute("data-theme");
    // Review #18: applyPlate also stamps the DOCUMENT language — reset it between tests too.
    document.documentElement.removeAttribute("lang");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("a pulled payload with theme:'light' stamps data-theme='light' on the document element", async () => {
    // UAT round-2 defect 1: the plate webview has an empty localStorage and never learns the theme,
    // so it stayed dark on the light app theme. The pulled payload now carries the effective theme;
    // the plate must apply it as data-theme BEFORE rendering so its tokens resolve to light.
    invokeMock.mockResolvedValue({ kind: "connected", configName: "My VPN", theme: "light" });
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("a pulled payload with theme:'dark' stamps data-theme='dark'", async () => {
    invokeMock.mockResolvedValue({ kind: "connected", configName: "My VPN", theme: "dark" });
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("a LIVE event with theme:'light' stamps data-theme='light' (shared render path)", async () => {
    // Nothing staged (null pull → mount heals), then a live event carries the theme — the same
    // applyPlate path themes the plate identically to the pull branch.
    invokeMock.mockResolvedValue(null);
    render(<NotificationPlate />);
    await flushMicrotasks();

    await deliverLiveEvent("connected", "My VPN", "light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("a payload with a MISSING theme defaults to data-theme='dark' (legacy/edge payload)", async () => {
    // A payload without a theme field must not throw and must fall to the :root dark fallback.
    invokeMock.mockResolvedValue({ kind: "connected", configName: "My VPN" });
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("NotificationPlate — language threading (13-07)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    listenMock.mockClear();
    unlistenSpy.mockClear();
    hideMock.mockClear();
    listenCallback = null;
    document.documentElement.removeAttribute("data-theme");
    // Review #18: applyPlate also stamps the DOCUMENT language — reset it between tests too.
    document.documentElement.removeAttribute("lang");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("a pulled payload with language:'en' renders the English copy", async () => {
    // UAT round-3 defect 2: the plate copy was hardcoded Russian and this webview has an empty
    // localStorage, so it stayed Russian on the English app language. The pulled payload now carries
    // the effective language; the plate must render the en title/body.
    invokeMock.mockResolvedValue({ kind: "connected", configName: "My VPN", language: "en" });
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText('VPN active: "My VPN"')).toBeInTheDocument();
    // The Russian title must NOT be present when language is en.
    expect(screen.queryByText("Подключено")).not.toBeInTheDocument();
    // Review #11: the × close affordance localizes with the copy — English accessible name.
    expect(screen.getByRole("button", { name: "Close notification" })).toBeInTheDocument();
    // Review #18 (WCAG 3.1.1): the DOCUMENT language matches the rendered copy (notification.html
    // hardcodes lang="ru"; applyPlate must restamp it per event).
    expect(document.documentElement.lang).toBe("en");
  });

  it("a pulled payload with language:'ru' renders the Russian copy", async () => {
    invokeMock.mockResolvedValue({ kind: "connected", configName: "My VPN", language: "ru" });
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(screen.getByText("Подключено")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    // Review #11 / #18: Russian × label + Russian document language.
    expect(screen.getByRole("button", { name: "Закрыть уведомление" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("ru");
  });

  it("a LIVE event with language:'en' renders the English copy (shared render path)", async () => {
    invokeMock.mockResolvedValue(null);
    render(<NotificationPlate />);
    await flushMicrotasks();

    await deliverLiveEvent("autoConnected", "Sweden", "dark", "en");
    expect(screen.getByText("Auto-connect on launch")).toBeInTheDocument();
    expect(screen.getByText('Server "Sweden" active')).toBeInTheDocument();
    // Review #18: the live path stamps the document language through the SAME applyPlate seam.
    expect(document.documentElement.lang).toBe("en");
  });

  it("a payload with a MISSING language defaults to Russian (the app's primary language)", async () => {
    invokeMock.mockResolvedValue({ kind: "connected", configName: "My VPN" });
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(screen.getByText("Подключено")).toBeInTheDocument();
    // Review #18: a missing language also defaults the document language to "ru" (matches the copy).
    expect(document.documentElement.lang).toBe("ru");
  });
});

describe("NotificationPlate — CONNECT detail block (13-08)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    listenMock.mockClear();
    unlistenSpy.mockClear();
    hideMock.mockClear();
    listenCallback = null;
    document.documentElement.removeAttribute("data-theme");
    // Review #18: applyPlate also stamps the DOCUMENT language — reset it between tests too.
    document.documentElement.removeAttribute("lang");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("a connect payload with address/login/pingMs renders the address, login and ping rows", async () => {
    // The richer CONNECT plate: Rust threads the endpoint address, the login and the connect-time
    // ping, and the plate shows them under the body. Domain address → the address value present; the
    // ping renders «{ms} мс».
    invokeMock.mockResolvedValue({
      kind: "connected",
      configName: "My VPN",
      address: "de-fra.trusttunnel.net:443",
      login: "ivan_petrov",
      pingMs: 42,
    });
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(screen.getByText("Подключено")).toBeInTheDocument();
    // The three detail values are rendered.
    expect(screen.getByText("de-fra.trusttunnel.net:443")).toBeInTheDocument();
    expect(screen.getByText("ivan_petrov")).toBeInTheDocument();
    expect(screen.getByText("42 мс")).toBeInTheDocument();
  });

  it("a connect payload with a MISSING ping renders «—» (no measurement)", async () => {
    invokeMock.mockResolvedValue({
      kind: "connected",
      configName: "My VPN",
      address: "203.0.113.42:443",
      login: "ivan_petrov",
      // pingMs absent → «—»
    });
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(screen.getByText("203.0.113.42:443")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("a disconnect payload (no detail fields) renders NO detail rows — stays compact", async () => {
    invokeMock.mockResolvedValue({ kind: "disconnected", configName: "My VPN" });
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(screen.getByText("Отключено")).toBeInTheDocument();
    // No address/login/ping — the compact plate. A stray «мс» / «—» must not appear.
    expect(screen.queryByText("—")).not.toBeInTheDocument();
    expect(screen.queryByText(/мс$/)).not.toBeInTheDocument();
  });

  it("a LIVE connect event carries the detail block through the shared render path", async () => {
    invokeMock.mockResolvedValue(null);
    render(<NotificationPlate />);
    await flushMicrotasks();

    await deliverLiveEvent("autoConnected", "Sweden", "dark", "ru", {
      address: "203.0.113.42:443",
      login: "ivan_petrov",
      pingMs: 150,
    });
    // Auto-connect title + the detail rows (a bare-IP address + login + amber-band ping).
    expect(screen.getByText("Автоподключение при запуске")).toBeInTheDocument();
    expect(screen.getByText("203.0.113.42:443")).toBeInTheDocument();
    expect(screen.getByText("ivan_petrov")).toBeInTheDocument();
    expect(screen.getByText("150 мс")).toBeInTheDocument();
  });

  it("an EN connect payload renders the ping unit in English — \"142 ms\", not «мс» (review #4)", async () => {
    // The unit used to be hardcoded Cyrillic inside buildConnectDetails, so the English plate showed
    // "142 мс" amid otherwise-English text. The plate now threads its payload language into the
    // detail builder — the whole plate (title/body/ping unit) reads in one language.
    invokeMock.mockResolvedValue({
      kind: "connected",
      configName: "My VPN",
      language: "en",
      address: "de-fra.trusttunnel.net:443",
      login: "ivan_petrov",
      pingMs: 142,
    });
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("142 ms")).toBeInTheDocument();
    expect(screen.queryByText("142 мс")).not.toBeInTheDocument();
  });
});

describe("NotificationPlate — error plate × acknowledges (Phase 19, 19-01 Bug 1 / D-04)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invokeMock.mockReset();
    listenMock.mockClear();
    unlistenSpy.mockClear();
    hideMock.mockClear();
    listenCallback = null;
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("lang");
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("clicking × on a connectionError plate invokes clear_vpn_error THEN hides (→ gray tray)", async () => {
    // D-04: the error plate's × used to only hide the window (`onClose={hideSelf}`), so status
    // stayed `Error` and the tray icon stayed red. The × now, for the connectionError kind only,
    // acknowledges via the backend `clear_vpn_error` (mirroring StatusPanel.handleDismiss) — that
    // routes Error→Disconnected through the single status writer → vpn-status emit → lib.rs
    // listener → update_tray_icon("disconnected") → gray. Assert the invoke fired AND the plate
    // still hides locally.
    invokeMock.mockResolvedValue({ kind: "connectionError", configName: "My VPN" });
    render(<NotificationPlate />);
    await flushMicrotasks();

    // The sticky error plate is up (the pull redelivered it; no auto-dismiss).
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Ошибка подключения")).toBeInTheDocument();

    // Drop the pull's invoke calls so the assertion sees only the ×-driven acknowledge.
    invokeMock.mockClear();
    hideMock.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Закрыть уведомление" }));
      await Promise.resolve();
    });

    // The acknowledge fired (fire-and-forget) and the plate hid locally.
    expect(invokeMock).toHaveBeenCalledWith("clear_vpn_error");
    expect(hideMock).toHaveBeenCalledTimes(1);
  });

  it("clicking × on a NON-error plate hides only — it does NOT invoke clear_vpn_error", async () => {
    // Only the connectionError kind acknowledges; every other kind keeps the plain hide-only close,
    // so a disconnect/connect plate close must never call clear_vpn_error (it would be a spurious
    // status write). Drive a disconnect plate and assert the × hides without the acknowledge.
    invokeMock.mockResolvedValue({ kind: "disconnected", configName: "My VPN" });
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Отключено")).toBeInTheDocument();

    invokeMock.mockClear();
    hideMock.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Закрыть уведомление" }));
      await Promise.resolve();
    });

    expect(invokeMock).not.toHaveBeenCalledWith("clear_vpn_error");
    expect(hideMock).toHaveBeenCalledTimes(1);
  });

  it("clicking the BODY of a connectionError plate ALSO acknowledges (clear_vpn_error) then restores (→ gray tray)", async () => {
    // Phase 19 UAT (G-19-1): the × was fixed to acknowledge, but clicking the notification BODY
    // (the natural "take me to the app" gesture) only invoked restore_main_window and left status
    // at `Error`, so the tray icon stayed RED. The body click now ALSO clears the error for the
    // connectionError kind — mirroring the ×. Assert BOTH invokes fire on a body click.
    invokeMock.mockResolvedValue({ kind: "connectionError", configName: "My VPN" });
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Ошибка подключения")).toBeInTheDocument();

    invokeMock.mockClear();
    hideMock.mockClear();

    await act(async () => {
      // Click the title (the body), NOT the × — the root onClick=onBodyClick fires via bubbling.
      fireEvent.click(screen.getByText("Ошибка подключения"));
      await Promise.resolve();
    });

    expect(invokeMock).toHaveBeenCalledWith("clear_vpn_error");
    expect(invokeMock).toHaveBeenCalledWith("restore_main_window");
  });

  it("clicking the BODY of a NON-error plate restores only — it does NOT invoke clear_vpn_error", async () => {
    // Only the connectionError kind acknowledges on a body click; every other kind keeps the plain
    // restore-only behaviour, so a disconnect/connect plate body click must never call
    // clear_vpn_error (it would be a spurious status write).
    invokeMock.mockResolvedValue({ kind: "disconnected", configName: "My VPN" });
    render(<NotificationPlate />);
    await flushMicrotasks();

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Отключено")).toBeInTheDocument();

    invokeMock.mockClear();
    hideMock.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByText("Отключено"));
      await Promise.resolve();
    });

    expect(invokeMock).not.toHaveBeenCalledWith("clear_vpn_error");
    expect(invokeMock).toHaveBeenCalledWith("restore_main_window");
  });
});
