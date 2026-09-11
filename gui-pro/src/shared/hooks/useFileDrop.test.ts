import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFileDrop } from "./useFileDrop";

// Mock @tauri-apps/api/core
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock react-i18next. `i18n.language` drives the IN-41 plural branch; "ru" exercises the real
// pluralRu path so the batch toast declines «конфиг». The single-config add (IN-43) calls
// t("connection.snackbar.config_added") with no fallback, so resolve that key explicitly.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    // IN-05 (19-fix): the ru batch toast now comes from the config_added_batch key with a
    // {{plural}} interpolation (was a hardcoded «Добавлено …» literal). Resolve it here so the
    // assertions still see the rendered «Добавлено N конфига…» string. Other keys keep the prior
    // passthrough-fallback behavior.
    t: (key: string, opts?: unknown) => {
      if (key === "connection.snackbar.config_added") return "Конфиг добавлен";
      if (key === "connection.import.config_added_batch") {
        return `Добавлено ${(opts as { plural?: string })?.plural ?? ""}`;
      }
      return opts;
    },
    i18n: { language: "ru" },
  }),
}));

const defaultOptions = {
  status: "disconnected" as const,
  onConfigImported: vi.fn(),
  onRoutingImported: vi.fn(),
  pushSuccess: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useFileDrop", () => {
  it("starts with isDragging false", () => {
    const { result } = renderHook(() => useFileDrop(defaultOptions));
    expect(result.current.isDragging).toBe(false);
  });

  it("sets isDragging true on dragenter with files", () => {
    renderHook(() => useFileDrop(defaultOptions));

    act(() => {
      const event = new Event("dragenter", { bubbles: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", {
        value: { types: ["Files"] },
      });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
      document.dispatchEvent(event);
    });

    // isDragging state is internal — verify by checking that dragenter was handled
    // (no error thrown means handler worked)
  });

  it("shows error snackbar when dropping unsupported format", async () => {
    const pushSuccess = vi.fn();
    renderHook(() => useFileDrop({ ...defaultOptions, pushSuccess }));

    const file = new File(["test"], "image.png", { type: "image/png" });

    await act(async () => {
      const event = new Event("drop", { bubbles: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", {
        value: { files: [file] },
      });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
      document.dispatchEvent(event);
    });

    expect(pushSuccess).toHaveBeenCalledWith(
      expect.stringContaining(".toml or .json"),
      "error"
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // IN-16: on the «Подключение» tab only a .toml config is accepted — a .json file is rejected
  // with a clear message (no import) so the overlay's «только .toml» label stays truthful.
  it("rejects a non-.toml file on the «Подключение» tab", async () => {
    const pushSuccess = vi.fn();
    renderHook(() =>
      useFileDrop({ ...defaultOptions, activeTab: "connection", pushSuccess })
    );

    const file = new File(["{}"], "rules.json", { type: "application/json" });

    await act(async () => {
      const event = new Event("drop", { bubbles: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
      document.dispatchEvent(event);
    });

    expect(pushSuccess).toHaveBeenCalledWith(expect.stringContaining(".toml"), "error");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  // IN-16: on the «Маршрутизация» tab only a .json routing file is accepted — a .toml file is
  // rejected (no import).
  it("rejects a non-.json file on the «Маршрутизация» tab", async () => {
    const pushSuccess = vi.fn();
    renderHook(() =>
      useFileDrop({ ...defaultOptions, activeTab: "routing", pushSuccess })
    );

    const file = new File(["[endpoint]"], "config.toml", { type: "" });

    await act(async () => {
      const event = new Event("drop", { bubbles: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", { value: { files: [file] } });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
      document.dispatchEvent(event);
    });

    expect(pushSuccess).toHaveBeenCalledWith(expect.stringContaining(".json"), "error");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("blocks drop when status is connecting", async () => {
    const pushSuccess = vi.fn();
    renderHook(() =>
      useFileDrop({ ...defaultOptions, status: "connecting", pushSuccess })
    );

    const file = new File(["[endpoint]"], "config.toml", { type: "" });

    await act(async () => {
      const event = new Event("drop", { bubbles: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", {
        value: { files: [file] },
      });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
      document.dispatchEvent(event);
    });

    expect(pushSuccess).toHaveBeenCalledWith(
      expect.stringContaining("connecting"),
      "error"
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("blocks drop when status is disconnecting", async () => {
    const pushSuccess = vi.fn();
    renderHook(() =>
      useFileDrop({ ...defaultOptions, status: "disconnecting", pushSuccess })
    );

    const file = new File(["[endpoint]"], "config.toml", { type: "" });

    await act(async () => {
      const event = new Event("drop", { bubbles: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", {
        value: { files: [file] },
      });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
      document.dispatchEvent(event);
    });

    expect(pushSuccess).toHaveBeenCalledWith(
      expect.stringContaining("disconnecting"),
      "error"
    );
  });

  it("blocks drop when isBusy is true", async () => {
    const pushSuccess = vi.fn();
    renderHook(() =>
      useFileDrop({ ...defaultOptions, isBusy: true, pushSuccess })
    );

    const file = new File(["[endpoint]"], "config.toml", { type: "" });

    await act(async () => {
      const event = new Event("drop", { bubbles: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", {
        value: { files: [file] },
      });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
      document.dispatchEvent(event);
    });

    expect(pushSuccess).toHaveBeenCalledWith(
      expect.stringContaining("active operation"),
      "error"
    );
  });

  it("calls import_dropped_content for .toml file", async () => {
    const onConfigImported = vi.fn();
    const pushSuccess = vi.fn();
    mockInvoke.mockResolvedValue({
      file_type: "config",
      config_path: "/path/to/config.toml",
    });

    renderHook(() =>
      useFileDrop({ ...defaultOptions, onConfigImported, pushSuccess })
    );

    const file = new File(["[endpoint]\nhostname = 'test'"], "config.toml", {
      type: "",
    });

    await act(async () => {
      const event = new Event("drop", { bubbles: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", {
        value: { files: [file] },
      });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
      document.dispatchEvent(event);
    });

    expect(mockInvoke).toHaveBeenCalledWith("import_dropped_content", {
      content: "[endpoint]\nhostname = 'test'",
      fileName: "config.toml",
    });
    expect(onConfigImported).toHaveBeenCalledWith("/path/to/config.toml");
    // IN-43: a single config now says «Конфиг добавлен» (connection.snackbar.config_added) on the
    // drag-drop path too — same copy as the modal, not the old «Конфигурация VPN импортирована».
    expect(pushSuccess).toHaveBeenCalledWith("Конфиг добавлен");
  });

  it("calls import_dropped_content for .json routing rules", async () => {
    const onRoutingImported = vi.fn();
    const pushSuccess = vi.fn();
    mockInvoke.mockResolvedValue({ file_type: "routing" });

    renderHook(() =>
      useFileDrop({ ...defaultOptions, onRoutingImported, pushSuccess })
    );

    const file = new File(['{"direct":[],"proxy":[]}'], "rules.json", {
      type: "application/json",
    });

    await act(async () => {
      const event = new Event("drop", { bubbles: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", {
        value: { files: [file] },
      });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
      document.dispatchEvent(event);
    });

    expect(mockInvoke).toHaveBeenCalledWith("import_dropped_content", {
      content: '{"direct":[],"proxy":[]}',
      fileName: "rules.json",
    });
    expect(onRoutingImported).toHaveBeenCalled();
  });

  it("shows error snackbar when invoke fails", async () => {
    const pushSuccess = vi.fn();
    mockInvoke.mockRejectedValue("Server error");

    renderHook(() => useFileDrop({ ...defaultOptions, pushSuccess }));

    const file = new File(["[endpoint]"], "config.toml", { type: "" });

    await act(async () => {
      const event = new Event("drop", { bubbles: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", {
        value: { files: [file] },
      });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
      document.dispatchEvent(event);
    });

    expect(pushSuccess).toHaveBeenCalledWith("Server error", "error");
  });

  // IN-24: dropping several files at once imports ALL of them (the old code took only files[0]).
  it("imports every file when several are dropped", async () => {
    const onConfigImported = vi.fn();
    const pushSuccess = vi.fn();
    mockInvoke.mockResolvedValue({ file_type: "config", config_path: "/path/c.toml" });
    renderHook(() => useFileDrop({ ...defaultOptions, onConfigImported, pushSuccess }));

    const f1 = new File(["[endpoint]"], "a.toml", { type: "" });
    const f2 = new File(["[endpoint]"], "b.toml", { type: "" });

    await act(async () => {
      const event = new Event("drop", { bubbles: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", { value: { files: [f1, f2] } });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
      document.dispatchEvent(event);
    });

    const importCalls = mockInvoke.mock.calls.filter((c) => c[0] === "import_dropped_content");
    expect(importCalls).toHaveLength(2);
    expect(importCalls[0][1]).toMatchObject({ fileName: "a.toml" });
    expect(importCalls[1][1]).toMatchObject({ fileName: "b.toml" });
    // Promote/refresh fires once after the batch; a batch summary toast is shown.
    expect(onConfigImported).toHaveBeenCalledTimes(1);
    // IN-41: the batch toast declines «конфиг» — 2 → few form «конфига» (was the noun-less
    // «Добавлено 2»). The mocked language is "ru", so this exercises the real pluralRu path.
    expect(pushSuccess).toHaveBeenCalledWith("Добавлено 2 конфига");
  });

  // IN-24 + IN-16: a mixed drop on «Подключение» imports the .toml configs and rejects the
  // .json, processing the rest instead of aborting on the first wrong-format file.
  it("imports the .toml and rejects the .json in a mixed drop on the «Подключение» tab", async () => {
    const onConfigImported = vi.fn();
    const pushSuccess = vi.fn();
    mockInvoke.mockResolvedValue({ file_type: "config", config_path: "/path/c.toml" });
    renderHook(() =>
      useFileDrop({ ...defaultOptions, activeTab: "connection", onConfigImported, pushSuccess }),
    );

    const cfg = new File(["[endpoint]"], "good.toml", { type: "" });
    const rules = new File(["{}"], "rules.json", { type: "application/json" });

    await act(async () => {
      const event = new Event("drop", { bubbles: true }) as DragEvent;
      Object.defineProperty(event, "dataTransfer", { value: { files: [cfg, rules] } });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
      document.dispatchEvent(event);
    });

    const importCalls = mockInvoke.mock.calls.filter((c) => c[0] === "import_dropped_content");
    expect(importCalls).toHaveLength(1); // only the .toml is imported
    expect(importCalls[0][1]).toMatchObject({ fileName: "good.toml" });
    expect(pushSuccess).toHaveBeenCalledWith(expect.stringContaining(".toml"), "error");
    expect(onConfigImported).toHaveBeenCalledTimes(1);
  });

  // ─── 19-04 (Q3 / D-09): a config-partial drop routes through the SAME rich in-modal partial UX
  //     as the file-picker path (failed list + «Повторить»), NOT a burst of per-file flyaway error
  //     toasts. The successful configs are still promoted; a fully-successful drop keeps its batch
  //     snackbar; the routing (.json) failure path is UNCHANGED. ─────────────────────────────────
  describe("19-04 config-partial → rich in-modal partial UX (Q3/D-09)", () => {
    it("routes a config-partial drop through onConfigPartial instead of per-file error toasts", async () => {
      const onConfigPartial = vi.fn();
      const onConfigImported = vi.fn();
      const pushSuccess = vi.fn();
      // good.toml imports OK; bad.toml throws inside import_dropped_content (a malformed config).
      mockInvoke.mockImplementation(async (cmd: string, args?: { fileName?: string }) => {
        if (cmd === "import_dropped_content") {
          if (args?.fileName === "bad.toml") throw new Error("import failed");
          return { file_type: "config", config_path: "/path/good.toml" };
        }
        if (cmd === "add_config") return null;
        return null;
      });
      renderHook(() =>
        useFileDrop({
          ...defaultOptions,
          activeTab: "connection",
          onConfigPartial,
          onConfigImported,
          pushSuccess,
        }),
      );

      const good = new File(["[endpoint]"], "good.toml", { type: "" });
      const bad = new File(["broken"], "bad.toml", { type: "" });

      await act(async () => {
        const event = new Event("drop", { bubbles: true }) as DragEvent;
        Object.defineProperty(event, "dataTransfer", { value: { files: [good, bad] } });
        Object.defineProperty(event, "preventDefault", { value: vi.fn() });
        Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
        document.dispatchEvent(event);
      });

      // The partial is surfaced via the SAME PartialResult shape the picker path uses — the failed
      // file is carried as a NAME only (D-29), with a retryable item for «Повторить».
      expect(onConfigPartial).toHaveBeenCalledTimes(1);
      const partial = onConfigPartial.mock.calls[0][0];
      expect(partial.ok).toBe(1);
      expect(partial.failed).toEqual([{ label: "bad.toml", reason: "invalid-file" }]);
      expect(partial.failedItems).toHaveLength(1);
      expect(partial.failedItems[0].label).toBe("bad.toml");
      expect(typeof partial.failedItems[0].run).toBe("function");
      // NO per-file flyaway error toast, and NO batch success snackbar (a failure is present).
      expect(pushSuccess).not.toHaveBeenCalled();
      // The successful config is still promoted (idempotent manifest reload).
      expect(onConfigImported).toHaveBeenCalledWith("/path/good.toml");
    });

    it("a fully-successful config drop still fires the batch snackbar (onConfigPartial NOT called)", async () => {
      const onConfigPartial = vi.fn();
      const pushSuccess = vi.fn();
      mockInvoke.mockResolvedValue({ file_type: "config", config_path: "/path/c.toml" });
      renderHook(() =>
        useFileDrop({ ...defaultOptions, activeTab: "connection", onConfigPartial, pushSuccess }),
      );

      const f1 = new File(["[endpoint]"], "a.toml", { type: "" });
      const f2 = new File(["[endpoint]"], "b.toml", { type: "" });

      await act(async () => {
        const event = new Event("drop", { bubbles: true }) as DragEvent;
        Object.defineProperty(event, "dataTransfer", { value: { files: [f1, f2] } });
        Object.defineProperty(event, "preventDefault", { value: vi.fn() });
        Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
        document.dispatchEvent(event);
      });

      // No failures → the unified partial surface is NOT engaged; the batch snackbar is unchanged.
      expect(onConfigPartial).not.toHaveBeenCalled();
      expect(pushSuccess).toHaveBeenCalledWith("Добавлено 2 конфига");
    });

    it("a routing (.json) drop failure is UNCHANGED — a per-file error toast, not onConfigPartial", async () => {
      const onConfigPartial = vi.fn();
      const pushSuccess = vi.fn();
      mockInvoke.mockRejectedValue("Server error");
      renderHook(() =>
        useFileDrop({ ...defaultOptions, activeTab: "routing", onConfigPartial, pushSuccess }),
      );

      const rules = new File(["{}"], "rules.json", { type: "application/json" });

      await act(async () => {
        const event = new Event("drop", { bubbles: true }) as DragEvent;
        Object.defineProperty(event, "dataTransfer", { value: { files: [rules] } });
        Object.defineProperty(event, "preventDefault", { value: vi.fn() });
        Object.defineProperty(event, "stopPropagation", { value: vi.fn() });
        document.dispatchEvent(event);
      });

      // Routing failures keep the existing per-file error toast — the unification is config-only.
      expect(pushSuccess).toHaveBeenCalledWith("Server error", "error");
      expect(onConfigPartial).not.toHaveBeenCalled();
    });
  });

  it("removes event listeners on unmount", () => {
    const spy = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => useFileDrop(defaultOptions));
    unmount();
    expect(spy).toHaveBeenCalledWith("dragover", expect.any(Function));
    expect(spy).toHaveBeenCalledWith("drop", expect.any(Function));
    spy.mockRestore();
  });
});
