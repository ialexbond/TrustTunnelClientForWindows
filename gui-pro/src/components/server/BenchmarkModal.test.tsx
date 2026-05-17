import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { renderWithProviders as render } from "../../test/test-utils";
import { BenchmarkModal } from "./BenchmarkModal";
// Vite ?raw import — avoids node:fs / __dirname (same pattern as Plan 17-02 parser tests)
import BenchmarkModalSource from "./BenchmarkModal.tsx?raw";

// ─── Spy: useActivityLog (D-29) ──────────────────────────────────────────────
const activityLogSpy = vi.fn();
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: activityLogSpy }),
}));

// ─── Mock: useConfirm (expose call args for W1 test) ─────────────────────────
const confirmMock = vi.fn().mockResolvedValue(true);
vi.mock("../../shared/ui/useConfirm", () => ({
  useConfirm: () => confirmMock,
}));

// ─── Mock: Tauri core (invoke) ────────────────────────────────────────────────
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// ─── Mock: Tauri event (listen) — track handlers ─────────────────────────────
const listenHandlers = new Map<string, Array<(payload: unknown) => void>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    const handlers = listenHandlers.get(event) ?? [];
    handlers.push((p) => handler({ payload: p }));
    listenHandlers.set(event, handlers);
    return Promise.resolve(() => {
      const arr = listenHandlers.get(event) ?? [];
      listenHandlers.set(event, arr.filter((h) => h !== handler as unknown));
    });
  }),
}));

/** Emit a Tauri event to all registered handlers */
function emit(event: string, payload: unknown) {
  const handlers = listenHandlers.get(event) ?? [];
  handlers.forEach((h) => h(payload));
}

// ─── SSH params fixture ───────────────────────────────────────────────────────
const sshParams = {
  host: "192.168.1.100",
  port: 22,
  user: "admin",
  password: "testpass-SECRET-XYZ",
  keyPath: undefined as string | undefined,
  keyData: undefined as string | undefined,
};

/** Minimal raw_stdout that parser can extract 3+ sections from */
const PARSEABLE_RAW = [
  "1. Basic Information",
  "IP: 1.2.3.4",
  "Country: Germany",
  "2. IP Type",
  "Type: Residential",
  "3. Risk Score",
  "Score: 42 / 100",
  "Risk Level: Low",
  "4. Risk Factors",
  "Factors: none",
  "5. Accessibility check for media and AI services",
  "Netflix: Yes",
  "6. Email service availability and blacklist detection",
  "SMTP: Open",
].join("\n");

const BENCHMARK_RESULT = {
  raw_stdout: PARSEABLE_RAW,
  duration_seconds: 73,
};

// ─── Default render helper ────────────────────────────────────────────────────
function renderModal(extras?: Parameters<typeof BenchmarkModal>[0]) {
  return render(
    <BenchmarkModal
      isOpen={true}
      onClose={vi.fn()}
      sshParams={sshParams}
      {...extras}
    />
  );
}

describe("BenchmarkModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activityLogSpy.mockClear();
    confirmMock.mockClear().mockResolvedValue(true);
    listenHandlers.clear();
    localStorage.clear();
    i18n.changeLanguage("ru");
  });

  // ─── 1: idle_initial_when_no_history ─────────────────────────────────────
  it("idle_initial_when_no_history", () => {
    renderModal({ _forceState: { kind: "idle" } });
    // Should show start button
    const startBtn = screen.getByRole("button", { name: /запустить проверку/i });
    expect(startBtn).toBeVisible();
  });

  // ─── 2: completed_initial_when_history_present ───────────────────────────
  it("completed_initial_when_history_present", () => {
    const record = {
      timestamp: new Date().toISOString(),
      parsed_sections: { basic: { IP: "1.2.3.4" }, ip_type: { Type: "Residential" }, risk: { Score: "Low" } },
      raw_stdout: PARSEABLE_RAW,
      duration_seconds: 42,
    };
    localStorage.setItem("tt_benchmark_192.168.1.100", JSON.stringify([record]));
    // Render without _forceState — should detect history and start in completed state
    render(
      <BenchmarkModal
        isOpen={true}
        onClose={vi.fn()}
        sshParams={sshParams}
      />
    );
    // Completed view shows duration
    expect(screen.getByText(/Длительность:/)).toBeVisible();
  });

  // ─── 3: starts_on_click_transitions_to_running ───────────────────────────
  it("starts_on_click_transitions_to_running", async () => {
    // invoke never resolves so it stays running
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    const startBtn = screen.getByRole("button", { name: /запустить проверку/i });
    await userEvent.click(startBtn);

    // Should show running hint
    await waitFor(() => {
      expect(screen.getByText(/1-3 минуты/i)).toBeVisible();
    });
  });

  // ─── 4: listen_event_advances_step ───────────────────────────────────────
  it("listen_event_advances_step", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    const startBtn = screen.getByRole("button", { name: /запустить проверку/i });
    await userEvent.click(startBtn);

    // Wait for listen to register
    await waitFor(() => expect(listenHandlers.has("benchmark-progress")).toBe(true));

    // Emit stage 2 (Оцениваем риск)
    emit("benchmark-progress", { stage: 2, label: "Risk", current_line: "Risk factor check..." });

    await waitFor(() => {
      // Stage label for index 2 is "Оцениваем риск" — rendered as step label in StepProgress
      expect(screen.getByText(/Оцениваем риск/i)).toBeVisible();
    });
  });

  // ─── 5: invoke_uses_camelCase_keys (B7 explicit) ─────────────────────────
  it("invoke_uses_camelCase_keys", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    const startBtn = screen.getByRole("button", { name: /запустить проверку/i });
    await userEvent.click(startBtn);

    await waitFor(() => expect(vi.mocked(invoke)).toHaveBeenCalled());

    const [command, args] = vi.mocked(invoke).mock.calls[0];
    expect(command).toBe("server_run_benchmark");
    // B7: must use camelCase keys (not snake_case)
    expect(args).toMatchObject({ host: sshParams.host });
    expect(args).toHaveProperty("keyPath");
    expect(args).toHaveProperty("keyData");
    // Anti-presence: must NOT have snake_case keys
    expect(args).not.toHaveProperty("key_path");
    expect(args).not.toHaveProperty("key_data");
  });

  // ─── 6: cancel_confirm_warning_variant (W1 explicit) ─────────────────────
  it("cancel_confirm_warning_variant", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    const startBtn = screen.getByRole("button", { name: /запустить проверку/i });
    await userEvent.click(startBtn);

    // Wait for running state
    await waitFor(() => screen.getByRole("button", { name: /Отменить/i }));

    const cancelBtn = screen.getByRole("button", { name: /Отменить/i });
    await userEvent.click(cancelBtn);

    // W1: confirm must be called with variant:"warning" (not "danger")
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "warning" })
    );
    // Anti-presence: must NOT be called with "danger"
    const callArgs = confirmMock.mock.calls[0][0] as { variant?: string };
    expect(callArgs.variant).not.toBe("danger");
  });

  // ─── 7: cancel_invoke_then_state_cancelled ───────────────────────────────
  it("cancel_invoke_then_state_cancelled", async () => {
    let rejectMain!: (reason: string) => void;
    vi.mocked(invoke)
      .mockImplementationOnce(
        () => new Promise<unknown>((_, rej) => { rejectMain = rej; })
      )
      .mockResolvedValueOnce(undefined); // server_cancel_benchmark

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByRole("button", { name: /Отменить/i }));
    await userEvent.click(screen.getByRole("button", { name: /Отменить/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());

    // Reject main invoke with cancel signal
    rejectMain("BENCHMARK_CANCELLED|dur=10");

    await waitFor(() => {
      expect(screen.getByText(/отменена/i)).toBeVisible();
    });
    // server_cancel_benchmark should have been called
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("server_cancel_benchmark");
  });

  // ─── 8: cancel_handles_forced_watchdog_variant (B8) ──────────────────────
  it("cancel_handles_forced_watchdog_variant", async () => {
    // Simulate watchdog-forced cancel (BENCHMARK_CANCELLED|dur=N|forced)
    vi.mocked(invoke).mockRejectedValueOnce("BENCHMARK_CANCELLED|dur=10|forced");

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => {
      // Should transition to cancelled (not error) — same view as plain cancel
      expect(screen.getByText(/отменена/i)).toBeVisible();
    });
  });

  // ─── 9: completed_after_resolve_pushes_history ───────────────────────────
  it("completed_after_resolve_pushes_history", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    // Wait for completed view
    await waitFor(() => {
      expect(screen.getAllByText(/Длительность/i).length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    // History must be persisted (D-1.4 — pushHistory on completion)
    const stored = localStorage.getItem("tt_benchmark_192.168.1.100");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
    // frontend-computed parsed_sections must be present
    const rec = parsed[0] as { parsed_sections?: unknown };
    expect(rec.parsed_sections).toBeDefined();
  });

  // ─── 10: rerun_button_in_completed_state_re_invokes ──────────────────────
  it("rerun_button_in_completed_state_re_invokes", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(BENCHMARK_RESULT)  // first run
      .mockReturnValueOnce(new Promise(() => {})); // second run (never resolves)

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByText(/Проверить ещё раз/i));
    await userEvent.click(screen.getByRole("button", { name: /Проверить ещё раз/i }));

    // invoke should have been called twice with server_run_benchmark
    await waitFor(() => {
      const benchmarkCalls = vi.mocked(invoke).mock.calls.filter(
        (c) => c[0] === "server_run_benchmark"
      );
      expect(benchmarkCalls.length).toBe(2);
    });
  });

  // ─── 11: parser_fallback_when_few_keys ───────────────────────────────────
  it("parser_fallback_when_few_keys", async () => {
    // Garbled output → parseBenchmarkOutput returns {} (0 keys) < 3
    vi.mocked(invoke).mockResolvedValueOnce({
      raw_stdout: "Some garbled text with no section headers at all",
      duration_seconds: 5,
    });

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => {
      expect(screen.getByText(/Не удалось распарсить/i)).toBeVisible();
    }, { timeout: 3000 });
  });

  // ─── 12: D-29 SECURITY no password in activity log ───────────────────────
  it("D-29_no_password_in_activity_log", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByText(/Длительность/i));

    expect(activityLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("testpass-SECRET-XYZ")
    );
  });

  // ─── 13: D-29 SECURITY no raw_stdout content in activity log ─────────────
  it("D-29_no_raw_stdout_content_in_activity_log", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByText(/Длительность/i));

    // D-29: raw_stdout content (like "1. Basic Information" or IP data) must not be logged
    expect(activityLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("1. Basic Information")
    );
    expect(activityLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Netflix: Yes")
    );
  });

  // ─── 14: close_blocked_while_running ─────────────────────────────────────
  it("close_blocked_while_running", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByText(/1-3 минуты/i));

    // Attempt to close with Escape — should be blocked
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });

    // Modal content should still be visible (running state not exited)
    expect(screen.queryByText(/1-3 минуты/i)).toBeTruthy();
  });

  // ─── 15: early_return_null_anti_pattern_absent ───────────────────────────
  it("early_return_null_anti_pattern_absent", () => {
    // Use Vite ?raw import — same pattern as Plan 17-02 parser tests (avoids node:fs)
    const content = BenchmarkModalSource;
    // T-03 invariant: no early return null before <Modal>
    expect(content).not.toContain("if (!isOpen) return null");
  });

  // ─── 16: B1_old_stage_labels_absent ──────────────────────────────────────
  it("B1_old_stage_labels_absent", () => {
    // Use Vite ?raw import — same pattern as Plan 17-02 parser tests (avoids node:fs)
    const content = BenchmarkModalSource;
    // B1: old D-1.2 labels must NOT exist in source (replaced with i18n keys)
    expect(content).not.toContain("Проверяем сеть");
    expect(content).not.toContain("Замеряем скорость");
  });
});
