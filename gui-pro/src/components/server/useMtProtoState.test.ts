import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useMtProtoState,
  type MtProtoStatus,
  type SshParams,
} from "./useMtProtoState";

// Mock useConfirm: always resolve `true` so confirm-gated actions proceed.
// Individual tests can override via mockConfirm.mockResolvedValueOnce(false).
const mockConfirm = vi.fn().mockResolvedValue(true);
vi.mock("../../shared/ui/useConfirm", () => ({
  useConfirm: () => mockConfirm,
}));

// ─── Helpers ────────────────────────────────────────

const mockInvoke = vi.mocked(invoke) as unknown as Mock;
const mockListen = vi.mocked(listen) as unknown as Mock;

const mockSshParams: SshParams = {
  host: "1.2.3.4",
  port: 22,
  user: "root",
  password: "pass",
  keyPath: "",
};

const mockPushSuccess = vi.fn();

function makeStatus(overrides?: Partial<MtProtoStatus>): MtProtoStatus {
  return {
    installed: true,
    active: true,
    port: 8443,
    secret: "ee11223344",
    proxy_link: "tg://proxy?server=1.2.3.4&port=8443&secret=ee11223344",
    ...overrides,
  };
}

const STORAGE_KEY = `mtproto_cache_${mockSshParams.host}`;

// ─── Tests ──────────────────────────────────────────

describe("useMtProtoState", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);
    mockInvoke.mockResolvedValue(null);
    mockListen.mockResolvedValue(() => {});
  });

  it("loads status on mount via mtproto_get_status invoke (MTPROTO-05)", async () => {
    const status = makeStatus();
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mtproto_get_status") return status;
      return null;
    });

    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "mtproto_get_status",
      expect.objectContaining({
        host: "1.2.3.4",
        port: 22,
        user: "root",
        password: "pass",
      }),
    );
    expect(result.current.status).toEqual(status);
  });

  it("install invokes mtproto_install with mtprotoPort param (MTPROTO-01)", async () => {
    const installed = makeStatus({ port: 8443 });
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mtproto_get_status") {
        return { installed: false, active: false, port: 0, secret: "", proxy_link: "" };
      }
      if (cmd === "mtproto_install") return installed;
      return null;
    });

    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.install(8443);
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      "mtproto_install",
      expect.objectContaining({
        host: "1.2.3.4",
        mtprotoPort: 8443,
      }),
    );
    expect(result.current.status).toEqual(installed);
    expect(result.current.installing).toBe(false);
  });

  it("listens for mtproto-install-step events during install (MTPROTO-02)", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mtproto_get_status") {
        return { installed: false, active: false, port: 0, secret: "", proxy_link: "" };
      }
      if (cmd === "mtproto_install") return makeStatus();
      return null;
    });

    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // listen() is registered inside a useEffect gated by installing=true.
    // Kick off an install and await the listener registration.
    let installPromise: Promise<void> | undefined;
    act(() => {
      installPromise = result.current.install(8443);
    });

    await vi.waitFor(() => {
      expect(mockListen).toHaveBeenCalledWith(
        "mtproto-install-step",
        expect.any(Function),
      );
    });

    await act(async () => {
      await installPromise;
    });
  });

  it("uninstall invokes mtproto_uninstall (MTPROTO-08)", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mtproto_get_status") return makeStatus();
      if (cmd === "mtproto_uninstall") return null;
      return null;
    });

    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.requestUninstall();
    });

    expect(mockConfirm).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "mtproto_uninstall",
        expect.objectContaining({ host: "1.2.3.4" }),
      );
    });
  });

  it("requestUninstall sets confirm dialog state", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mtproto_get_status") return makeStatus();
      return null;
    });
    // Reject the confirm so we can assert that invoke(mtproto_uninstall) was NOT called.
    mockConfirm.mockResolvedValueOnce(false);

    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.requestUninstall();
    });

    // Dialog was opened with MTPROTO strings.
    expect(mockConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "warning" }),
    );
    // User cancelled -> no uninstall invoke fired.
    expect(mockInvoke).not.toHaveBeenCalledWith(
      "mtproto_uninstall",
      expect.anything(),
    );
  });

  it("retry resets error and calls install (MTPROTO-01)", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mtproto_get_status") {
        return { installed: false, active: false, port: 0, secret: "", proxy_link: "" };
      }
      if (cmd === "mtproto_install") throw new Error("network down");
      return null;
    });

    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // First install fails -> error populated.
    await act(async () => {
      await result.current.install(8443);
    });
    expect(result.current.error).toContain("network down");

    // Now make install succeed.
    const installed = makeStatus({ port: 9999 });
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mtproto_install") return installed;
      if (cmd === "mtproto_get_status") {
        return { installed: false, active: false, port: 0, secret: "", proxy_link: "" };
      }
      return null;
    });

    act(() => {
      result.current.retry(9999);
    });

    // Error is cleared synchronously by retry().
    expect(result.current.error).toBeNull();

    // And a new mtproto_install was dispatched with the supplied port.
    await vi.waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "mtproto_install",
        expect.objectContaining({ mtprotoPort: 9999 }),
      );
    });
  });

  it("persists proxy_link and port to localStorage (MTPROTO-06)", async () => {
    const installed = makeStatus({
      port: 8443,
      proxy_link: "tg://proxy?server=host&port=8443&secret=aa",
    });
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mtproto_get_status") {
        return { installed: false, active: false, port: 0, secret: "", proxy_link: "" };
      }
      if (cmd === "mtproto_install") return installed;
      return null;
    });

    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.install(8443);
    });

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { proxy_link: string; port: number };
    expect(parsed.proxy_link).toBe(installed.proxy_link);
    expect(parsed.port).toBe(8443);
  });

  it("rehydrates proxy_link and port from localStorage on mount (MTPROTO-06)", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        proxy_link: "tg://proxy?server=cached&port=7777&secret=cc",
        port: 7777,
      }),
    );

    // Keep the initial invoke hanging so we observe the pre-invoke state only.
    mockInvoke.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));

    // Status is pre-populated from localStorage BEFORE the server responds.
    expect(result.current.status).not.toBeNull();
    expect(result.current.status!.installed).toBe(true);
    expect(result.current.status!.port).toBe(7777);
    expect(result.current.status!.proxy_link).toBe(
      "tg://proxy?server=cached&port=7777&secret=cc",
    );
  });
});

// ─── Phase 17.1 — legacyMigrationNote (Option B event-based) ─────────
//
// Plan 17.1-02 Task 2: при step="cleanup_legacy" с непустым `message`
// backend сигнализирует что был обнаружен и удалён старый MTProxy.
// Frontend hook сохраняет текст в additive поле `legacyMigrationNote`
// (НЕ ломая frozen public API). Эти тесты — реальная интеграция через
// мок `listen()`, который вызывает callback с настроенными payloads.

describe("useMtProtoState — Phase 17.1 legacyMigrationNote (Option B)", () => {
  type StepEvent = { step: string; status: string; message: string };
  type Listener = (ev: { payload: StepEvent }) => void;

  let listeners: Listener[];
  let triggerStep: (payload: StepEvent) => void;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockConfirm.mockResolvedValue(true);

    // По умолчанию `mtproto_get_status` возвращает not-installed (чтобы install
    // мог быть инициирован) и `mtproto_install` зависает — это даёт нам
    // окно во времени когда `installing===true` и listener подписан.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "mtproto_get_status") {
        return { installed: false, active: false, port: 0, secret: "", proxy_link: "" };
      }
      if (cmd === "mtproto_install") {
        // Зависающий promise — listener остаётся подписан пока тест эмитит шаги.
        return new Promise(() => {});
      }
      return null;
    });

    // Сохраняем callbacks из listen() — затем `triggerStep` зовёт их вручную.
    listeners = [];
    mockListen.mockImplementation(async (eventName: string, callback: Listener) => {
      if (eventName === "mtproto-install-step") {
        listeners.push(callback);
      }
      return () => {
        const idx = listeners.indexOf(callback);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    });
    triggerStep = (payload: StepEvent) => {
      for (const cb of listeners) cb({ payload });
    };
  });

  it("starts with legacyMigrationNote === null on mount", async () => {
    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.legacyMigrationNote).toBeNull();
  });

  it("captures legacyMigrationNote from cleanup_legacy event with non-empty message", async () => {
    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Запускаем install — hook подписывается на mtproto-install-step.
    act(() => {
      void result.current.install(8443);
    });
    await vi.waitFor(() => {
      expect(listeners.length).toBeGreaterThan(0);
    });

    // Backend сообщил что нашёл и удалил старый MTProxy.
    act(() => {
      triggerStep({
        step: "cleanup_legacy",
        status: "running",
        message: "Старый MTProxy был обнаружен и удалён в процессе установки",
      });
    });

    await vi.waitFor(() => {
      expect(result.current.legacyMigrationNote).toContain("MTProxy");
    });
  });

  it("does NOT set legacyMigrationNote when cleanup_legacy emits empty message", async () => {
    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      void result.current.install(8443);
    });
    await vi.waitFor(() => {
      expect(listeners.length).toBeGreaterThan(0);
    });

    // legacy не найден → backend всё равно emit'ит этап но без message.
    act(() => {
      triggerStep({ step: "cleanup_legacy", status: "done", message: "" });
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.legacyMigrationNote).toBeNull();
  });

  it("does NOT set legacyMigrationNote when cleanup_legacy emits whitespace-only message", async () => {
    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      void result.current.install(8443);
    });
    await vi.waitFor(() => {
      expect(listeners.length).toBeGreaterThan(0);
    });

    act(() => {
      triggerStep({ step: "cleanup_legacy", status: "done", message: "   \t\n  " });
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.legacyMigrationNote).toBeNull();
  });

  it("ignores message on non-cleanup_legacy steps (e.g. start_service)", async () => {
    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      void result.current.install(8443);
    });
    await vi.waitFor(() => {
      expect(listeners.length).toBeGreaterThan(0);
    });

    // start_service несёт message, но это не сигнал миграции.
    act(() => {
      triggerStep({
        step: "start_service",
        status: "running",
        message: "Сервис запускается",
      });
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current.legacyMigrationNote).toBeNull();
  });

  it("STEP_INDEX wiring: emit configure_telemt → currentStep === 3", async () => {
    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      void result.current.install(8443);
    });
    await vi.waitFor(() => {
      expect(listeners.length).toBeGreaterThan(0);
    });

    act(() => {
      triggerStep({ step: "configure_telemt", status: "running", message: "" });
    });

    await vi.waitFor(() => {
      expect(result.current.currentStep).toBe(3);
    });
  });

  it("STEP_INDEX wiring: emit open_firewall → currentStep === 5", async () => {
    const { result } = renderHook(() => useMtProtoState(mockSshParams, mockPushSuccess));
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    act(() => {
      void result.current.install(8443);
    });
    await vi.waitFor(() => {
      expect(listeners.length).toBeGreaterThan(0);
    });

    act(() => {
      triggerStep({ step: "open_firewall", status: "running", message: "" });
    });

    await vi.waitFor(() => {
      expect(result.current.currentStep).toBe(5);
    });
  });
});
