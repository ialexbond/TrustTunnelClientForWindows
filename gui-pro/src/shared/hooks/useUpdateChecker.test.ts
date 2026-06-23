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

const GITHUB_RELEASE_OK = {
  tag_name: "v3.0.1",
  body: "Release notes тут",
  html_url: "https://github.com/ialexbond/TrustTunnelClientForWindows/releases/v3.0.1",
  assets: [
    {
      name: "TrustTunnel-Pro-3.0.1-setup.exe",
      browser_download_url:
        "https://github.com/ialexbond/TrustTunnelClientForWindows/releases/download/v3.0.1/TrustTunnel-Pro-3.0.1-setup.exe",
    },
  ],
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

describe("useUpdateChecker", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.clearAllMocks();
    // Default app version stub — может перезаписываться в отдельных тестах
    vi.mocked(getVersion).mockResolvedValue("3.0.0");
    // Default fetch stub — GitHub API success → app update available (3.0.0 → 3.0.1)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string) => ({
        ok: true,
        status: 200,
        json: async () => GITHUB_RELEASE_OK,
        text: async () => "",
      })) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ─── Backwards-compat (Blocker #3) ───

  it("no_arg_invocation_preserves_app_check — hook не crash'ит когда sshParams === undefined", async () => {
    // CRITICAL: existing call site App.tsx:81 `useUpdateChecker()` без args
    // MUST продолжать работать (PLAN-REVIEW Blocker #3 fix).
    const { result } = renderHook(() => useUpdateChecker());

    // Initial state — все поля заданы (нет undefined access ошибок)
    expect(result.current.updateInfo.available).toBe(false);
    expect(result.current.updateInfo.appAvailable).toBe(false);
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
    vi.mocked(invoke).mockResolvedValueOnce(SIDECAR_INFO_AVAILABLE);
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
    vi.mocked(invoke).mockResolvedValueOnce(SIDECAR_INFO_AVAILABLE);
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
    vi.mocked(invoke).mockResolvedValueOnce(SIDECAR_INFO_AVAILABLE);

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
    vi.mocked(invoke).mockResolvedValueOnce({
      ...SIDECAR_INFO_AVAILABLE,
      latest_version: "1.0.34",
      latest_tag: "v1.0.34",
    });

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
    vi.mocked(invoke).mockResolvedValueOnce(SIDECAR_INFO_AVAILABLE);

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
    vi.mocked(invoke).mockResolvedValueOnce(SIDECAR_INFO_AVAILABLE);

    const { result } = renderHook(() => useUpdateChecker());
    await act(async () => {
      await result.current.checkSidecarForServer(SSH_PARAMS);
    });

    expect(result.current.updateInfo.sidecarAvailable).toBe(true);
    expect(result.current.updateInfo.sidecarDismissed).toBe(false);
  });

  it("dismissSidecarUpdate(version) пишет sessionStorage (не localStorage) + flips state", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(SIDECAR_INFO_AVAILABLE);
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

  // ─── Silent fail (D-2.x) ───

  it("Sidecar invoke rejects → silent fail, sidecarAvailable=false, no exception", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValueOnce("UPDATE_CHECK_FAILED");

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

  it("App fetch ошибка → silent fail (D-2.x), appAvailable=false, no exception", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Перезаписываем fetch на 403 (rate limit)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({}),
        text: async () => "",
      })) as unknown as typeof fetch,
    );

    const { result } = renderHook(() => useUpdateChecker());

    await waitFor(() => {
      expect(result.current.updateInfo.checking).toBe(false);
    });

    expect(result.current.updateInfo.appAvailable).toBe(false);
    expect(result.current.updateInfo.available).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
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
    vi.mocked(invoke).mockResolvedValueOnce(SIDECAR_INFO_AVAILABLE);
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
    // ставим fetch на success — initial check + последующие интервалы все возвращают ту же versionу
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => GITHUB_RELEASE_OK,
        text: async () => "",
      })) as unknown as typeof fetch,
    );

    renderHook(() => useUpdateChecker());

    // Run initial mount check + flush promises
    await vi.runOnlyPendingTimersAsync();

    // Initial fetch happened — ровно один call
    const fetchMock = vi.mocked(fetch);
    const initialCalls = fetchMock.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(1);

    // Advance 6 часов — НЕ должно случиться нового check
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(fetchMock.mock.calls.length).toBe(initialCalls);

    // Advance ещё 18 часов (всего 24h) — должен случиться один новый check
    await vi.advanceTimersByTimeAsync(18 * 60 * 60 * 1000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCalls);
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
    vi.mocked(invoke).mockRejectedValueOnce("UPDATE_CHECK_FAILED");

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
