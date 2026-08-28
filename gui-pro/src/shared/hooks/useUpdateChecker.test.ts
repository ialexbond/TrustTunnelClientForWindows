import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { useUpdateChecker } from "./useUpdateChecker";
import type { UpdateCheckerSshParams } from "./useUpdateChecker";

// Test SSH params — реальные пароли НЕ используются (Tauri invoke мокается).
// Эти значения только для проверки что hook передаёт их в invoke('check_sidecar_version')
// в правильном camelCase shape (Plan 18-03 contract).
const SSH_PARAMS: UpdateCheckerSshParams = {
  host: "203.0.113.10",
  port: 22,
  user: "root",
  password: "test-passwd",
  keyPath: undefined,
  keyData: undefined,
};

// Phase 30: the app check is `invoke("check_app_update_info")`, not a webview fetch.
// This is the command's wire shape — snake_case, as Tauri serializes the Rust struct.
const APP_UPDATE_AVAILABLE = {
  current_version: "3.0.0",
  latest_version: "3.0.1",
  latest_tag: "v3.0.1",
  available: true,
  download_url:
    "https://github.com/ialexbond/TrustTunnelClientForWindows/releases/download/v3.0.1/TrustTunnel-Pro-3.0.1-setup.exe",
  release_notes: "Release notes тут",
  sha256: "",
};

const SIDECAR_INFO_AVAILABLE = {
  current_version: "1.0.32",
  latest_version: "1.0.33",
  latest_tag: "v1.0.33",
  available: true,
  asset_download_url:
    "https://github.com/TrustTunnel/TrustTunnel/releases/download/v1.0.33/trusttunnel-v1.0.33-linux-x86_64.tar.gz",
  asset_size_bytes: 10485760,
};

/**
 * What a mocked command should do this test.
 *
 * The outcome lives in a mutable variable that each test sets BEFORE rendering, and the
 * `mockImplementation` in `beforeEach` reads it. That is the house shape (GeoDataStatus.test.tsx)
 * and it is deliberate: `vite.config.ts` sets `restoreMocks: true`, so a resolved value pinned in a
 * top-level `vi.mock` factory does not survive to the next test — Phase 28 lost a debugging cycle
 * to exactly that. It also lets one `invoke` mock serve two commands, which matters now that the
 * app check and the sidecar check both go through `invoke`.
 */
type Outcome = { resolve: unknown } | { reject: unknown };

function settle(outcome: Outcome): Promise<unknown> {
  return "resolve" in outcome
    ? Promise.resolve(outcome.resolve)
    : Promise.reject(outcome.reject);
}

describe("useUpdateChecker", () => {
  let appOutcome: Outcome;
  let sidecarOutcome: Outcome;

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    // Default app version stub — может перезаписываться в отдельных тестах
    vi.mocked(getVersion).mockResolvedValue("3.0.0");
    // Defaults: the app check succeeds and finds 3.0.0 → 3.0.1; the sidecar check is
    // never called unless a test calls it.
    appOutcome = { resolve: APP_UPDATE_AVAILABLE };
    sidecarOutcome = { resolve: SIDECAR_INFO_AVAILABLE };
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "check_app_update_info") return settle(appOutcome);
      if (cmd === "check_sidecar_version") return settle(sidecarOutcome);
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function appCheckCalls() {
    return vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "check_app_update_info").length;
  }

  // ─── Backwards-compat (Blocker #3) ───

  it("no_arg_invocation_preserves_app_check — hook не crash'ит когда sshParams === undefined", async () => {
    // CRITICAL: existing call site App.tsx:81 `useUpdateChecker()` без args
    // MUST продолжать работать (PLAN-REVIEW Blocker #3 fix).
    const { result } = renderHook(() => useUpdateChecker());

    // Initial state — все поля заданы (нет undefined access ошибок)
    expect(result.current.updateInfo.available).toBe(false);
    expect(result.current.updateInfo.appAvailable).toBe(false);
    expect(result.current.updateInfo.checkError).toBeNull();
    expect(result.current.checkForUpdates).toBeInstanceOf(Function);
    expect(result.current.checkSidecarForServer).toBeInstanceOf(Function);
    expect(result.current.dismissSidecarUpdate).toBeInstanceOf(Function);

    // App update detection работает без sshParams
    await waitFor(() => {
      expect(result.current.updateInfo.appAvailable).toBe(true);
    });
    expect(result.current.updateInfo.available).toBe(true); // backwards-compat alias
    expect(result.current.updateInfo.latestVersion).toBe("3.0.1");
    expect(result.current.updateInfo.currentVersion).toBe("3.0.0");
  });

  it("app check идёт через Rust-команду check_app_update_info, не через webview fetch", async () => {
    // Obligation 1 / RESEARCH L-1: the app's own CSP names no GitHub origin in
    // `connect-src`, so the check has to leave the webview to have a route at all.
    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => {
      expect(result.current.updateInfo.appAvailable).toBe(true);
    });
    expect(invoke).toHaveBeenCalledWith("check_app_update_info");
  });

  it("sha256 приезжает из команды (integrity expectation не потерялась при переносе в Rust)", async () => {
    // T-30-03: the digest resolution moved into Rust. If the hook stopped carrying it,
    // `self_update` would silently run with an empty expectation.
    appOutcome = { resolve: { ...APP_UPDATE_AVAILABLE, sha256: "a".repeat(64) } };
    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => {
      expect(result.current.updateInfo.sha256).toBe("a".repeat(64));
    });
  });

  // ─── App + sidecar independence ───

  it("App available + sidecar НЕ checked separately — appAvailable=true + sidecarAvailable=false initially", async () => {
    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => {
      expect(result.current.updateInfo.appAvailable).toBe(true);
    });

    // Sidecar НЕ проверялся (нет sshParams) → sidecarAvailable остаётся false
    expect(result.current.updateInfo.sidecarAvailable).toBe(false);
    expect(result.current.updateInfo.sidecarCurrentVersion).toBe("");
    expect(result.current.updateInfo.sidecarLatestVersion).toBe("");
  });

  // ─── Sidecar detection ───

  it("checkSidecarForServer(params) invokes Tauri command с правильными args", async () => {
    const { result } = renderHook(() => useUpdateChecker());

    await act(async () => {
      await result.current.checkSidecarForServer(SSH_PARAMS);
    });

    expect(invoke).toHaveBeenCalledWith("check_sidecar_version", {
      host: "203.0.113.10",
      port: 22,
      user: "root",
      password: "test-passwd",
      keyPath: null,
      keyData: null,
    });
  });

  it("успешный sidecar check → sidecarAvailable=true когда backend возвращает available=true", async () => {
    const { result } = renderHook(() => useUpdateChecker());

    await act(async () => {
      await result.current.checkSidecarForServer(SSH_PARAMS);
    });

    expect(result.current.updateInfo.sidecarAvailable).toBe(true);
    expect(result.current.updateInfo.sidecarCurrentVersion).toBe("1.0.32");
    expect(result.current.updateInfo.sidecarLatestVersion).toBe("1.0.33");
    expect(result.current.updateInfo.sidecarLatestTag).toBe("v1.0.33");
    expect(result.current.updateInfo.sidecarDownloadUrl).toContain(
      "trusttunnel-v1.0.33-linux-x86_64.tar.gz",
    );
    expect(result.current.updateInfo.sidecarChecking).toBe(false);
  });

  // ─── Per-session dismissal (UAT-2, owner 6.8 — per-launch nudge) ───

  it("sidecarDismissed=true когда tt_dismissed_update_<version> существует в sessionStorage", async () => {
    sessionStorage.setItem("tt_dismissed_update_1.0.33", "true");

    const { result } = renderHook(() => useUpdateChecker());
    await act(async () => {
      await result.current.checkSidecarForServer(SSH_PARAMS);
    });

    expect(result.current.updateInfo.sidecarAvailable).toBe(true);
    expect(result.current.updateInfo.sidecarDismissed).toBe(true);
  });

  it("новая версия (1.0.34) → sidecarDismissed=false (per-version scope, REQ-18-UPDATE-FLOW-02)", async () => {
    // Пользователь dismissed v1.0.33; сервер обновился до v1.0.34
    sessionStorage.setItem("tt_dismissed_update_1.0.33", "true");
    sidecarOutcome = {
      resolve: { ...SIDECAR_INFO_AVAILABLE, latest_version: "1.0.34", latest_tag: "v1.0.34" },
    };

    const { result } = renderHook(() => useUpdateChecker());
    await act(async () => {
      await result.current.checkSidecarForServer(SSH_PARAMS);
    });

    // tt_dismissed_update_1.0.34 НЕ существует → автоматически not-dismissed
    expect(result.current.updateInfo.sidecarLatestVersion).toBe("1.0.34");
    expect(result.current.updateInfo.sidecarDismissed).toBe(false);
  });

  it("fresh session (no flag) → sidecarDismissed=false пока update доступен (UAT-2 per-launch nudge)", async () => {
    // UAT-2 / owner 6.8: dismiss-флаг живёт в sessionStorage, поэтому новый
    // запуск приложения (свежая сессия, флага нет) снова показывает точку,
    // даже если update тот же. Свежая сессия = пустой sessionStorage.
    const { result } = renderHook(() => useUpdateChecker());
    await act(async () => {
      await result.current.checkSidecarForServer(SSH_PARAMS);
    });

    expect(result.current.updateInfo.sidecarAvailable).toBe(true);
    expect(result.current.updateInfo.sidecarDismissed).toBe(false);
  });

  it("стейл localStorage-флаг прошлой версии НЕ глушит точку (только sessionStorage учитывается, UAT-2)", async () => {
    // Регрессия: до UAT-2 dismiss писался в localStorage (постоянно). После
    // перехода на sessionStorage старый постоянный флаг в localStorage не
    // должен подавлять точку — читаем ТОЛЬКО sessionStorage.
    localStorage.setItem("tt_dismissed_update_1.0.33", "true");

    const { result } = renderHook(() => useUpdateChecker());
    await act(async () => {
      await result.current.checkSidecarForServer(SSH_PARAMS);
    });

    expect(result.current.updateInfo.sidecarAvailable).toBe(true);
    expect(result.current.updateInfo.sidecarDismissed).toBe(false);
  });

  it("dismissSidecarUpdate(version) пишет sessionStorage (не localStorage) + flips state", async () => {
    const { result } = renderHook(() => useUpdateChecker());

    await act(async () => {
      await result.current.checkSidecarForServer(SSH_PARAMS);
    });
    expect(result.current.updateInfo.sidecarDismissed).toBe(false);

    act(() => {
      result.current.dismissSidecarUpdate("1.0.33");
    });

    // Per-launch scope: флаг в sessionStorage, НЕ в localStorage (UAT-2 / 6.8)
    expect(sessionStorage.getItem("tt_dismissed_update_1.0.33")).toBe("true");
    expect(localStorage.getItem("tt_dismissed_update_1.0.33")).toBeNull();
    expect(result.current.updateInfo.sidecarDismissed).toBe(true);
  });

  // ─── The app-check error channel (Phase 30 / ABOUT-01) ───
  //
  // These INVERT what this file used to assert. The old case proved a failed app check
  // left no trace anywhere; the whole point of the phase is that it now leaves exactly
  // one — a cause discriminant, and nothing else.

  it("OBL-1c: отказ check_app_update_info пишет checkError и НЕ поднимает available", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    appOutcome = { reject: "no-internet" };

    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => {
      expect(result.current.updateInfo.checking).toBe(false);
    });

    expect(result.current.updateInfo.checkError).toBe("no-internet");
    expect(result.current.updateInfo.available).toBe(false);
    expect(result.current.updateInfo.appAvailable).toBe(false);
    expect(warnSpy).toHaveBeenCalled(); // DevTools visibility only — not a user surface
    warnSpy.mockRestore();
  });

  it("отказ server-unreachable маппится в свой собственный discriminant", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    appOutcome = { reject: "server-unreachable" };

    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => {
      expect(result.current.updateInfo.checkError).toBe("server-unreachable");
    });
    warnSpy.mockRestore();
  });

  it("OBL-1d: неудачная проверка НЕ стирает lastChecked — приложение помнит, что знало", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useUpdateChecker());

    // Первая проверка удачная — lastChecked заполнен.
    await waitFor(() => {
      expect(result.current.updateInfo.lastChecked).not.toBeNull();
    });
    const firstStamp = result.current.updateInfo.lastChecked;
    const firstLatest = result.current.updateInfo.latestVersion;

    // Вторая — падает.
    appOutcome = { reject: "server-unreachable" };
    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.updateInfo.checkError).toBe("server-unreachable");
    expect(result.current.updateInfo.lastChecked).toBe(firstStamp);
    expect(result.current.updateInfo.latestVersion).toBe(firstLatest);
    warnSpy.mockRestore();
  });

  it("успешная проверка после неудачной сбрасывает checkError в null", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    appOutcome = { reject: "no-internet" };
    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => {
      expect(result.current.updateInfo.checkError).toBe("no-internet");
    });

    appOutcome = { resolve: APP_UPDATE_AVAILABLE };
    await act(async () => {
      await result.current.checkForUpdates();
    });

    expect(result.current.updateInfo.checkError).toBeNull();
    expect(result.current.updateInfo.available).toBe(true);
    warnSpy.mockRestore();
  });

  it("незнакомый backend-токен резолвится в server-unreachable, а не протекает как текст", async () => {
    // No passthrough: a token the front end has never heard of — a stack trace, a
    // hostname, a status line — must never become the value the card renders.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    appOutcome = { reject: "Error: getaddrinfo ENOTFOUND api.github.com" };

    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => {
      expect(result.current.updateInfo.checkError).toBe("server-unreachable");
    });
    expect(result.current.updateInfo.checkError).not.toBe("no-internet");
    warnSpy.mockRestore();
  });

  it("OBL-1e: неудачный sidecar check НЕ пишет checkError (две разные дорожки обновления)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    sidecarOutcome = { reject: "UPDATE_CHECK_FAILED" };

    const { result } = renderHook(() => useUpdateChecker());
    await waitFor(() => {
      expect(result.current.updateInfo.checking).toBe(false);
    });

    await act(async () => {
      await result.current.checkSidecarForServer(SSH_PARAMS);
    });

    expect(result.current.updateInfo.sidecarAvailable).toBe(false);
    expect(result.current.updateInfo.checkError).toBeNull();
    warnSpy.mockRestore();
  });

  it("две наложившиеся проверки успокаиваются: checking=false и никогда checkError+available вместе", async () => {
    // EDGE concurrency (a)+(b): whatever order the two settle in, the hook must not
    // come to rest asserting both "an update is available" and "the check failed".
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => {
      expect(result.current.updateInfo.checking).toBe(false);
    });

    await act(async () => {
      const first = result.current.checkForUpdates();
      appOutcome = { reject: "no-internet" };
      const second = result.current.checkForUpdates();
      await Promise.all([first, second]);
    });

    expect(result.current.updateInfo.checking).toBe(false);
    const { checkError, available } = result.current.updateInfo;
    expect(Boolean(checkError) && Boolean(available)).toBe(false);
    warnSpy.mockRestore();
  });

  // ─── EDGE concurrency (c) — проверка переживает поверхность, которая её запросила ───
  //
  // Это тот самый случай, который план 30-01 отложил меткой `verification: backstop`, а проверка
  // фазы честно не стала засчитывать: `checkForUpdates` дописывал состояние и отметку времени уже
  // ПОСЛЕ того, как вкладка «О программе» закрылась. React 18 на запись состояния в снятый
  // компонент не ругается — поэтому «предупреждения в консоли нет» ничего не доказывает, и тест
  // ловит дефект не по предупреждению, а по единственному наблюдаемому следу дороги «после
  // ожидания»: записи `tt_last_update_check` в хранилище. Без гарда в хуке этот тест падает, с
  // гардом — проходит.

  it("EDGE concurrency (c): проверка, застигнутая закрытием вкладки, не дописывает ничего", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Проверка, которая не закончится, пока мы сами её не закончим — так закрытие гарантированно
    // попадает В СЕРЕДИНУ запроса, а не до и не после него.
    let finishAppCheck: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      finishAppCheck = resolve;
    });
    vi.mocked(invoke).mockImplementation(((cmd: string) => {
      if (cmd === "check_app_update_info") return pending;
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);

    const { unmount } = renderHook(() => useUpdateChecker());
    // Стартовая проверка висит: ни успеха, ни отказа, следов в хранилище ещё нет.
    expect(localStorage.getItem("tt_last_update_check")).toBeNull();

    unmount();

    await act(async () => {
      finishAppCheck(APP_UPDATE_AVAILABLE);
      await pending;
      // Лишний оборот очереди задач: продолжение внутри хука встаёт в неё раньше нашего, но
      // полагаться на порядок не будем.
      await Promise.resolve();
    });

    // Главное утверждение: дорога «после ожидания» не пройдена — отметку времени никто не поставил.
    expect(localStorage.getItem("tt_last_update_check")).toBeNull();
    // Вспомогательное: ни предупреждения React, ни отказа. Само по себе это ничего не доказывает
    // (React 18 на такую запись молчит), но подтверждает, что ранний выход прошёл тихо, а не через
    // исключение.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalledWith("Update check failed:", expect.anything());

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  // ─── Silent fail (D-2.x) — sidecar track only ───

  it("Sidecar invoke rejects → silent fail, sidecarAvailable=false, no exception", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    sidecarOutcome = { reject: "UPDATE_CHECK_FAILED" };

    const { result } = renderHook(() => useUpdateChecker());

    // Promise не rejected, hook не throw
    await act(async () => {
      await expect(
        result.current.checkSidecarForServer(SSH_PARAMS),
      ).resolves.toBeUndefined();
    });

    expect(result.current.updateInfo.sidecarAvailable).toBe(false);
    expect(result.current.updateInfo.sidecarChecking).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      "Sidecar update check failed:",
      "UPDATE_CHECK_FAILED",
    );

    warnSpy.mockRestore();
  });

  // ─── localStorage timestamp ───

  it("tt_last_update_check пишется при успешном app check", async () => {
    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => {
      expect(result.current.updateInfo.lastChecked).not.toBeNull();
    });

    const stored = localStorage.getItem("tt_last_update_check");
    expect(stored).not.toBeNull();
    // ISO-8601 формат — простой sanity check
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("tt_last_update_check пишется при успешном sidecar check", async () => {
    const { result } = renderHook(() => useUpdateChecker());

    // Очищаем после initial app check (который тоже пишет timestamp)
    await waitFor(() => {
      expect(result.current.updateInfo.lastChecked).not.toBeNull();
    });
    localStorage.removeItem("tt_last_update_check");

    await act(async () => {
      await result.current.checkSidecarForServer(SSH_PARAMS);
    });

    expect(localStorage.getItem("tt_last_update_check")).not.toBeNull();
  });

  // ─── Polling cadence (REQ-18-UPDATE-DETECTION-03) ───

  it("polling interval = 24h (NOT 6h)", async () => {
    vi.useFakeTimers();

    renderHook(() => useUpdateChecker());

    // Run initial mount check + flush promises
    await vi.runOnlyPendingTimersAsync();

    const initialCalls = appCheckCalls();
    expect(initialCalls).toBeGreaterThanOrEqual(1);

    // Advance 6 часов — НЕ должно случиться нового check
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(appCheckCalls()).toBe(initialCalls);

    // Advance ещё 18 часов (всего 24h) — должен случиться один новый check
    await vi.advanceTimersByTimeAsync(18 * 60 * 60 * 1000);
    expect(appCheckCalls()).toBeGreaterThan(initialCalls);
  });

  // ─── Backwards-compat alias ───

  it("updateInfo.available === appAvailable (backwards-compat alias)", async () => {
    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => {
      expect(result.current.updateInfo.appAvailable).toBe(true);
    });

    expect(result.current.updateInfo.available).toBe(result.current.updateInfo.appAvailable);
    expect(result.current.updateInfo.available).toBe(true);
  });

  // ─── D-29 invariant ───

  it("D-29: hook НЕ пишет password в console.warn (silent fail logs только error code)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    sidecarOutcome = { reject: "UPDATE_CHECK_FAILED" };

    const { result } = renderHook(() => useUpdateChecker());

    await act(async () => {
      await result.current.checkSidecarForServer(SSH_PARAMS);
    });

    // Ни один console.warn call не должен содержать password
    const allCalls = warnSpy.mock.calls.flat().map((arg) => String(arg));
    for (const call of allCalls) {
      expect(call).not.toContain("test-passwd");
    }

    warnSpy.mockRestore();
  });
});
