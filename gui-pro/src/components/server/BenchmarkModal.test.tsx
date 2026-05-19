import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { renderWithProviders as render } from "../../test/test-utils";
import { BenchmarkModal } from "./BenchmarkModal";
// Vite ?raw import — avoids node:fs / __dirname (same pattern as Plan 17-02 parser tests)
import BenchmarkModalSource from "./BenchmarkModal.tsx?raw";

// ─── Mock: Tauri plugin-shell ─────────────────────────────────────────────────
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn().mockResolvedValue(undefined),
}));

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

// ─── SSH params fixture ───────────────────────────────────────────────────────
const sshParams = {
  host: "192.168.1.100",
  port: 22,
  user: "admin",
  password: "testpass-SECRET-XYZ",
  keyPath: undefined as string | undefined,
  keyData: undefined as string | undefined,
};

/** Minimal raw_stdout with a report link */
const RAW_WITH_LINK = [
  "########################################",
  "  IP QUALITY CHECK REPORT  1.2.3.4",
  "########################################",
  "",
  "1. Basic Information",
  "ASN: AS41745",
  "",
  "Report Link: https://Report.Check.Place/ip/TESTID.svg",
].join("\n");

/** Raw without report link */
const RAW_NO_LINK = "Some garbled text with no report link here";

const BENCHMARK_RESULT_WITH_LINK = {
  raw_stdout: RAW_WITH_LINK,
  duration_seconds: 73,
};

const BENCHMARK_RESULT_NO_LINK = {
  raw_stdout: RAW_NO_LINK,
  duration_seconds: 5,
};

// ─── Default render helper ────────────────────────────────────────────────────
type PartialBenchmarkProps = Partial<Parameters<typeof BenchmarkModal>[0]>;
function renderModal(extras?: PartialBenchmarkProps) {
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
    localStorage.clear();
    i18n.changeLanguage("ru");
  });

  // ─── 1: idle_initial_when_no_history ─────────────────────────────────────
  it("idle_initial_when_no_history", () => {
    renderModal({ _forceState: { kind: "idle" } });
    const startBtn = screen.getByRole("button", { name: /запустить проверку/i });
    expect(startBtn).toBeVisible();
  });

  // ─── 2: completed_initial_when_history_present ───────────────────────────
  it("completed_initial_when_history_present", () => {
    const record = {
      timestamp: new Date().toISOString(),
      parsed_sections: { raw: RAW_WITH_LINK, reportLink: "https://Report.Check.Place/ip/TESTID.svg" },
      raw_stdout: RAW_WITH_LINK,
      duration_seconds: 42,
    };
    localStorage.setItem("tt_benchmark_192.168.1.100", JSON.stringify([record]));
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

  // ─── 3: running_shows_spinner_and_hint ───────────────────────────────────
  it("running_shows_spinner_and_hint", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => {
      expect(screen.getByText(/1-3 минуты/i)).toBeVisible();
    });
    // Spinner should be in DOM (Loader2 with animate-spin)
    expect(screen.getByText(/Проверка выполняется/i)).toBeVisible();
  });

  // ─── 4: invoke_uses_camelCase_keys (B7 explicit) ─────────────────────────
  it("invoke_uses_camelCase_keys", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

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

  // ─── 5: cancel_confirm_warning_variant (W1 explicit) ─────────────────────
  it("cancel_confirm_warning_variant", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByRole("button", { name: /Отменить/i }));
    await userEvent.click(screen.getByRole("button", { name: /Отменить/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "warning" })
    );
    const callArgs = confirmMock.mock.calls[0][0] as { variant?: string };
    expect(callArgs.variant).not.toBe("danger");
  });

  // ─── 6: cancel_invoke_then_state_cancelled ───────────────────────────────
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

    rejectMain("BENCHMARK_CANCELLED|dur=10");

    await waitFor(() => {
      expect(screen.getByText(/отменена/i)).toBeVisible();
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("server_cancel_benchmark");
  });

  // ─── 7: cancel_handles_forced_watchdog_variant (B8) ──────────────────────
  it("cancel_handles_forced_watchdog_variant", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("BENCHMARK_CANCELLED|dur=10|forced");

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => {
      expect(screen.getByText(/отменена/i)).toBeVisible();
    });
  });

  // ─── 8: completed_after_resolve_pushes_history ───────────────────────────
  it("completed_after_resolve_pushes_history", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/Длительность/i).length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    const stored = localStorage.getItem("tt_benchmark_192.168.1.100");
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  // ─── 9: rerun_button_re_invokes ──────────────────────────────────────────
  it("rerun_button_re_invokes", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK)
      .mockReturnValueOnce(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByText(/Проверить ещё раз/i));
    await userEvent.click(screen.getByRole("button", { name: /Проверить ещё раз/i }));

    await waitFor(() => {
      const benchmarkCalls = vi.mocked(invoke).mock.calls.filter(
        (c) => c[0] === "server_run_benchmark"
      );
      expect(benchmarkCalls.length).toBe(2);
    });
  });

  // ─── 10: report_link_button_visible_when_present ─────────────────────────
  it("report_link_button_visible_when_present", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByText(/Длительность/i), { timeout: 3000 });

    expect(screen.getByTestId("report-link-button")).toBeVisible();
  });

  // ─── 11: no_report_link_shows_banner_and_autoopens_raw ───────────────────
  it("no_report_link_shows_banner_and_autoopens_raw", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_NO_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => {
      expect(screen.getByText(/Ссылка на отчёт не найдена/i)).toBeVisible();
    }, { timeout: 3000 });

    // Raw accordion auto-opens — raw content visible
    await waitFor(() => {
      expect(screen.getByText(/garbled text/i)).toBeVisible();
    }, { timeout: 1000 });
  });

  // ─── 12: close_blocked_while_running ─────────────────────────────────────
  it("close_blocked_while_running", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByText(/1-3 минуты/i));

    // Attempt to close with Escape — should be blocked
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });

    expect(screen.queryByText(/1-3 минуты/i)).toBeTruthy();
  });

  // ─── 13: D-29 SECURITY no password in activity log ───────────────────────
  it("D-29_no_password_in_activity_log", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByText(/Длительность/i));

    expect(activityLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("testpass-SECRET-XYZ")
    );
  });

  // ─── 14: D-29 SECURITY no raw_stdout content in activity log ─────────────
  it("D-29_no_raw_stdout_content_in_activity_log", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByText(/Длительность/i));

    // D-29: raw_stdout content must not be logged
    expect(activityLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("1. Basic Information")
    );
  });

  // ─── 15: D-29 SECURITY no report URL in activity log ─────────────────────
  it("D-29_report_url_not_in_activity_log", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByText(/Длительность/i), { timeout: 3000 });

    // D-29 extension: report link URL must NOT appear in activity log
    expect(activityLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("Report.Check.Place")
    );
    expect(activityLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("TESTID.svg")
    );
  });

  // ─── 16: early_return_null_anti_pattern_absent (T-03) ────────────────────
  it("early_return_null_anti_pattern_absent", () => {
    const content = BenchmarkModalSource;
    expect(content).not.toContain("if (!isOpen) return null");
  });

  // ─── 17: no_stage_labels_in_source (B1 cleanup) ──────────────────────────
  it("B1_old_stage_labels_absent", () => {
    const content = BenchmarkModalSource;
    expect(content).not.toContain("Проверяем сеть");
    expect(content).not.toContain("Замеряем скорость");
    // No StepProgress or HorizontalProgressBar references
    expect(content).not.toContain("StepProgress");
    expect(content).not.toContain("HorizontalProgressBar");
    expect(content).not.toContain("BenchmarkLiveTail");
  });
});
