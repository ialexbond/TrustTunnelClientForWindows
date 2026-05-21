import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  useUpdateProgress,
  BACKEND_TO_UI_STEP,
  UI_STEPS,
} from "./useUpdateProgress";

// ─── Tauri API mocks ───────────────────────────────────────
// `listen` от @tauri-apps/api/event возвращает unlisten fn.
// Сохраняем переданный callback чтобы тесты могли эмитить события.
const listeners = new Map<
  string,
  (event: { payload: unknown }) => void
>();
const unlistenMocks: Array<ReturnType<typeof vi.fn>> = [];

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (
      eventName: string,
      cb: (event: { payload: unknown }) => void
    ) => {
      listeners.set(eventName, cb);
      const unlisten = vi.fn(() => {
        listeners.delete(eventName);
      });
      unlistenMocks.push(unlisten);
      return unlisten;
    }
  ),
}));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, payload?: unknown) => invokeMock(cmd, payload),
}));

describe("useUpdateProgress", () => {
  beforeEach(() => {
    listeners.clear();
    unlistenMocks.length = 0;
    invokeMock.mockReset();
  });

  it("frozen contract: 7 backend keys map to 4 UI steps + finalizer", () => {
    // Phase 17.1 Option B pattern — adding a step requires updating BOTH
    // backend и frontend simultaneously.
    const expectedBackendKeys = [
      "download_tarball",
      "extract",
      "backup",
      "swap",
      "restart",
      "verify",
      "complete",
    ];
    for (const k of expectedBackendKeys) {
      expect(BACKEND_TO_UI_STEP[k]).toBeDefined();
    }
    // 4 UI steps + 1 finalizer = 5 unique values
    const uniqueUiSteps = new Set(Object.values(BACKEND_TO_UI_STEP));
    expect(uniqueUiSteps.size).toBe(5);
    expect(UI_STEPS).toHaveLength(4);
  });

  it("initial phase is 'idle' с percent 0", () => {
    const { result } = renderHook(() => useUpdateProgress());
    expect(result.current.state.phase).toBe("idle");
    expect(result.current.state.percent).toBe(0);
    expect(result.current.state.currentStep).toBe(0);
    expect(result.current.state.errorCode).toBeNull();
    expect(result.current.state.errorMessage).toBeNull();
    expect(result.current.state.cancelling).toBe(false);
  });

  it("startUpdate transitions phase to 'active' immediately", async () => {
    invokeMock.mockImplementation(() => new Promise(() => {})); // pending forever
    const { result } = renderHook(() => useUpdateProgress());
    await waitFor(() =>
      expect(listeners.has("update-protocol-step")).toBe(true)
    );

    act(() => {
      void result.current.startUpdate(
        { host: "1.1.1.1", port: 22, user: "root", password: "x" },
        "1.0.33"
      );
    });
    expect(result.current.state.phase).toBe("active");
  });

  it("backend step event maps to correct UI step + percent", async () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useUpdateProgress());
    await waitFor(() =>
      expect(listeners.has("update-protocol-step")).toBe(true)
    );
    act(() => {
      void result.current.startUpdate(
        { host: "1.1.1.1", port: 22, user: "root", password: "x" },
        "1.0.33"
      );
    });

    // Emit backend extract (UI: download)
    act(() => {
      listeners.get("update-protocol-step")!({
        payload: { step: "extract", status: "running", percent: 20, message: "" },
      });
    });
    expect(result.current.state.currentStep).toBe(0); // download UI index
    expect(result.current.state.percent).toBe(20);

    // Emit backend swap (UI: apply)
    act(() => {
      listeners.get("update-protocol-step")!({
        payload: { step: "swap", status: "running", percent: 60, message: "" },
      });
    });
    expect(result.current.state.currentStep).toBe(2); // apply UI index
    expect(result.current.state.percent).toBe(60);

    // Emit backend verify (UI: verify)
    act(() => {
      listeners.get("update-protocol-step")!({
        payload: { step: "verify", status: "running", percent: 90, message: "" },
      });
    });
    expect(result.current.state.currentStep).toBe(3); // verify UI index
    expect(result.current.state.percent).toBe(90);
  });

  it("complete event with status=completed transitions to 'success'", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useUpdateProgress());
    await waitFor(() =>
      expect(listeners.has("update-protocol-step")).toBe(true)
    );
    act(() => {
      void result.current.startUpdate(
        { host: "1.1.1.1", port: 22, user: "root", password: "x" },
        "1.0.33"
      );
    });

    act(() => {
      listeners.get("update-protocol-step")!({
        payload: {
          step: "complete",
          status: "completed",
          percent: 100,
          message: "",
        },
      });
    });
    expect(result.current.state.phase).toBe("success");
    expect(result.current.state.percent).toBe(100);
  });

  it("complete event with status=failed transitions to 'error'", async () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useUpdateProgress());
    await waitFor(() =>
      expect(listeners.has("update-protocol-step")).toBe(true)
    );
    act(() => {
      void result.current.startUpdate(
        { host: "1.1.1.1", port: 22, user: "root", password: "x" },
        "1.0.33"
      );
    });

    act(() => {
      listeners.get("update-protocol-step")!({
        payload: {
          step: "complete",
          status: "failed",
          percent: 100,
          message: "complete.rolled_back",
        },
      });
    });
    expect(result.current.state.phase).toBe("error");
    expect(result.current.state.errorMessage).toBe("complete.rolled_back");
  });

  it("invoke reject transitions to 'error' с errorCode", async () => {
    invokeMock.mockRejectedValueOnce("UPDATE_VERIFY_TIMEOUT");
    const { result } = renderHook(() => useUpdateProgress());
    await waitFor(() =>
      expect(listeners.has("update-protocol-step")).toBe(true)
    );

    await act(async () => {
      await result.current.startUpdate(
        { host: "1.1.1.1", port: 22, user: "root", password: "secret" },
        "1.0.33"
      );
    });
    expect(result.current.state.phase).toBe("error");
    expect(result.current.state.errorCode).toBe("UPDATE_VERIFY_TIMEOUT");
  });

  it("cancelUpdate sets cancelling=true и invokes cancel_update_sidecar", async () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useUpdateProgress());
    await waitFor(() =>
      expect(listeners.has("update-protocol-step")).toBe(true)
    );
    act(() => {
      void result.current.startUpdate(
        { host: "1.1.1.1", port: 22, user: "root", password: "x" },
        "1.0.33"
      );
    });

    invokeMock.mockResolvedValueOnce(undefined); // for cancel_update_sidecar
    await act(async () => {
      await result.current.cancelUpdate();
    });
    expect(result.current.state.cancelling).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith(
      "cancel_update_sidecar",
      undefined
    );
  });

  it("D-29 spy: invoke reject does NOT leak sshPassword в console.warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    invokeMock.mockRejectedValueOnce("SSH_AUTH_FAILED");
    const { result } = renderHook(() => useUpdateProgress());
    await waitFor(() =>
      expect(listeners.has("update-protocol-step")).toBe(true)
    );

    const secretPassword = "SuperSecretPass123!";
    await act(async () => {
      await result.current.startUpdate(
        {
          host: "1.1.1.1",
          port: 22,
          user: "root",
          password: secretPassword,
        },
        "1.0.33"
      );
    });

    // D-29: console.warn calls MUST NOT contain password.
    for (const call of warnSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(secretPassword);
      }
    }
    warnSpy.mockRestore();
  });

  it("reset returns state to initial", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useUpdateProgress());
    await waitFor(() =>
      expect(listeners.has("update-protocol-step")).toBe(true)
    );
    act(() => {
      void result.current.startUpdate(
        { host: "1.1.1.1", port: 22, user: "root", password: "x" },
        "1.0.33"
      );
    });
    act(() => {
      listeners.get("update-protocol-step")!({
        payload: {
          step: "complete",
          status: "completed",
          percent: 100,
          message: "",
        },
      });
    });
    expect(result.current.state.phase).toBe("success");

    act(() => result.current.reset());
    expect(result.current.state.phase).toBe("idle");
    expect(result.current.state.percent).toBe(0);
  });

  it("startUpdate invokes update_sidecar с individual fields shape (Plan 18-05 contract)", async () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useUpdateProgress());
    await waitFor(() =>
      expect(listeners.has("update-protocol-step")).toBe(true)
    );

    act(() => {
      void result.current.startUpdate(
        {
          host: "1.2.3.4",
          port: 2222,
          user: "ubuntu",
          password: "pw",
          keyPath: "/tmp/key",
        },
        "1.0.34"
      );
    });

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_sidecar", {
        host: "1.2.3.4",
        port: 2222,
        user: "ubuntu",
        password: "pw",
        keyPath: "/tmp/key",
        keyData: null,
        targetVersion: "1.0.34",
      })
    );
  });

  it("unmount calls unlisten cleanup", async () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderHook(() => useUpdateProgress());
    await waitFor(() =>
      expect(listeners.has("update-protocol-step")).toBe(true)
    );

    unmount();

    expect(unlistenMocks[0]).toHaveBeenCalled();
    expect(listeners.has("update-protocol-step")).toBe(false);
  });
});
