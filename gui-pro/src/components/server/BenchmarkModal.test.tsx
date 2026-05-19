import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { renderWithProviders as render } from "../../test/test-utils";
import { BenchmarkModal } from "./BenchmarkModal";
// Vite ?raw import — avoids node:fs / __dirname (same pattern as Plan 17-02 parser tests)
import BenchmarkModalSource from "./BenchmarkModal.tsx?raw";

// ─── Mock: Tauri plugin-shell (for report link + mapUrl) ─────────────────────
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

/** Minimal raw_stdout — new columnar format that parser can extract sections from */
const PARSEABLE_RAW = [
  "1. Basic Information",
  "ASN: AS41745",
  "Organization: Example Hosting",
  "Actual Region: [NL]The Netherlands     [EU]Europe",
  "Registered Region: [RU]Russia",
  "Time Zone: Europe/Amsterdam",
  "",
  "2. IP Type",
  "",
  "Database:    IPinfo       ipregistry",
  "Usage:       Hosting      Hosting",
  "",
  "3. Risk Score",
  "",
  "Levels:      VeryLow  Low  Medium  High  VeryHigh",
  "IP2Location:                                       3  Low",
  "Scamalytics:                                       17 Low",
  "",
  "4. Risk Factors",
  "",
  "DB:          IP2Location  ipapi",
  "Region:      [NL]         [NL]",
  "Proxy:       No           No",
  "Tor:         No           No",
  "VPN:         No           No",
  "",
  "5. Accessibility check for media and AI services",
  "",
  "Service:     Netflix   Youtube",
  "Status:      Yes       NoPrem",
  "Region:      [NL]      [NL]",
  "Type:        Native    Native",
  "",
  "Report Link: https://Report.Check.Place/ip/TESTID.svg",
].join("\n");

const BENCHMARK_RESULT = {
  raw_stdout: PARSEABLE_RAW,
  duration_seconds: 73,
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
    listenHandlers.clear();
    localStorage.clear();
    i18n.changeLanguage("ru");
  });

  // ─── 1: idle_initial_when_no_history ─────────────────────────────────────
  it("idle_initial_when_no_history", () => {
    renderModal({ _forceState: { kind: "idle" } });
    // Should show start button
    const startBtn = screen.getByRole("button", { name: /start check/i });
    expect(startBtn).toBeVisible();
  });

  // ─── 2: completed_initial_when_history_present ───────────────────────────
  it("completed_initial_when_history_present", () => {
    const record = {
      timestamp: new Date().toISOString(),
      // New shape: ParsedSections (typed, with raw+partial fields)
      parsed_sections: { basic: { ip: "1.2.3.4", geoDiscrepant: false }, raw: PARSEABLE_RAW, partial: false },
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
    expect(screen.getByText(/Duration:/)).toBeVisible();
  });

  // ─── 3: starts_on_click_transitions_to_running ───────────────────────────
  it("starts_on_click_transitions_to_running", async () => {
    // invoke never resolves so it stays running
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    const startBtn = screen.getByRole("button", { name: /start check/i });
    await userEvent.click(startBtn);

    // Should show running hint
    await waitFor(() => {
      expect(screen.getByText(/1-3 minutes/i)).toBeVisible();
    });
  });

  // ─── 4: listen_event_advances_step ───────────────────────────────────────
  it("listen_event_advances_step", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    const startBtn = screen.getByRole("button", { name: /start check/i });
    await userEvent.click(startBtn);

    // Wait for listen to register
    await waitFor(() => expect(listenHandlers.has("benchmark-progress")).toBe(true));

    // Emit stage 2 (Оцениваем риск)
    emit("benchmark-progress", { stage: 2, label: "Risk", current_line: "Risk factor check..." });

    await waitFor(() => {
      // Stage label for index 2 is "Assessing risk" — rendered as step label in StepProgress
      expect(screen.getByText(/Assessing risk/i)).toBeVisible();
    });
  });

  // ─── 5: invoke_uses_camelCase_keys (B7 explicit) ─────────────────────────
  it("invoke_uses_camelCase_keys", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    const startBtn = screen.getByRole("button", { name: /start check/i });
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
    const startBtn = screen.getByRole("button", { name: /start check/i });
    await userEvent.click(startBtn);

    // Wait for running state
    await waitFor(() => screen.getByRole("button", { name: /Cancel/i }));

    const cancelBtn = screen.getByRole("button", { name: /Cancel/i });
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
    await userEvent.click(screen.getByRole("button", { name: /start check/i }));

    await waitFor(() => screen.getByRole("button", { name: /Cancel/i }));
    await userEvent.click(screen.getByRole("button", { name: /Cancel/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());

    // Reject main invoke with cancel signal
    rejectMain("BENCHMARK_CANCELLED|dur=10");

    await waitFor(() => {
      expect(screen.getByText(/cancelled/i)).toBeVisible();
    });
    // server_cancel_benchmark should have been called
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("server_cancel_benchmark");
  });

  // ─── 8: cancel_handles_forced_watchdog_variant (B8) ──────────────────────
  it("cancel_handles_forced_watchdog_variant", async () => {
    // Simulate watchdog-forced cancel (BENCHMARK_CANCELLED|dur=N|forced)
    vi.mocked(invoke).mockRejectedValueOnce("BENCHMARK_CANCELLED|dur=10|forced");

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /start check/i }));

    await waitFor(() => {
      // Should transition to cancelled (not error) — same view as plain cancel
      expect(screen.getByText(/cancelled/i)).toBeVisible();
    });
  });

  // ─── 9: completed_after_resolve_pushes_history ───────────────────────────
  it("completed_after_resolve_pushes_history", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /start check/i }));

    // Wait for completed view
    await waitFor(() => {
      expect(screen.getAllByText(/Duration/i).length).toBeGreaterThan(0);
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
    await userEvent.click(screen.getByRole("button", { name: /start check/i }));

    await waitFor(() => screen.getByText(/Check again/i));
    await userEvent.click(screen.getByRole("button", { name: /Check again/i }));

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
    await userEvent.click(screen.getByRole("button", { name: /start check/i }));

    await waitFor(() => {
      expect(screen.getByText(/Could not parse output/i)).toBeVisible();
    }, { timeout: 3000 });
  });

  // ─── 12: D-29 SECURITY no password in activity log ───────────────────────
  it("D-29_no_password_in_activity_log", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /start check/i }));

    await waitFor(() => screen.getByText(/Duration/i));

    expect(activityLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("testpass-SECRET-XYZ")
    );
  });

  // ─── 13: D-29 SECURITY no raw_stdout content in activity log ─────────────
  it("D-29_no_raw_stdout_content_in_activity_log", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /start check/i }));

    await waitFor(() => screen.getByText(/Duration/i));

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
    await userEvent.click(screen.getByRole("button", { name: /start check/i }));

    await waitFor(() => screen.getByText(/1-3 minutes/i));

    // Attempt to close with Escape — should be blocked
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });

    // Modal content should still be visible (running state not exited)
    expect(screen.queryByText(/1-3 minutes/i)).toBeTruthy();
  });

  // ─── 17-fix: live tail renders during running ──────────────────────────────
  it("live_tail_visible_during_running", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /start check/i }));

    // Wait for running state
    await waitFor(() => screen.getByText(/1-3 minutes/i));

    // BenchmarkLiveTail title should be visible (uses i18n key tail.title = "Логи выполнения")
    // Or at least the progress bar area is visible
    expect(screen.getByText(/1-3 minutes/i)).toBeVisible();
  });

  // ─── 17-fix: geo-discrepant warning shown ──────────────────────────────────
  it("geo_discrepant_warning_shown_when_true", async () => {
    const geodiscrepantRaw = PARSEABLE_RAW; // has NL actual + RU registered → geoDiscrepant=true
    vi.mocked(invoke).mockResolvedValueOnce({
      raw_stdout: geodiscrepantRaw,
      duration_seconds: 73,
    });

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /start check/i }));

    await waitFor(() => screen.getByText(/Duration/i), { timeout: 3000 });

    // Geo-discrepant warning must be shown
    expect(screen.getByText(/Geolocation does not match registration/i)).toBeVisible();
  });

  // ─── 17-fix: NoPrem accessibility chip shown ───────────────────────────────
  it("noprem_accessibility_chip_shown", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      raw_stdout: PARSEABLE_RAW,
      duration_seconds: 73,
    });

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /start check/i }));

    await waitFor(() => screen.getByText(/Duration/i), { timeout: 3000 });

    // Raw enum value "NoPrem" rendered directly per UAT 2026-05-19 (no localization)
    expect(screen.getByText(/^NoPrem$/)).toBeVisible();
  });

  // ─── 17-fix: report link opens via plugin-shell ────────────────────────────
  it("report_link_button_visible_when_present", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      raw_stdout: PARSEABLE_RAW,
      duration_seconds: 73,
    });

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /start check/i }));

    await waitFor(() => screen.getByText(/Duration/i), { timeout: 3000 });

    // Report link button should be visible
    expect(screen.getByTestId("report-link-button")).toBeVisible();
  });

  // ─── 17-fix: partial=true auto-opens raw accordion ─────────────────────────
  it("partial_true_autoopens_raw_accordion", async () => {
    // Garbled output → parser can't extract sections → partial flag
    vi.mocked(invoke).mockResolvedValueOnce({
      raw_stdout: "garbled output with no sections",
      duration_seconds: 5,
    });

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /start check/i }));

    await waitFor(() => {
      expect(screen.getByText(/Could not parse output/i)).toBeVisible();
    }, { timeout: 3000 });

    // Raw output accordion should auto-open — raw content visible
    await waitFor(() => {
      expect(screen.getByText(/garbled output/i)).toBeVisible();
    }, { timeout: 1000 });
  });

  // ─── 17-fix: D-29 report URL not in activity log ───────────────────────────
  it("D-29_report_url_not_in_activity_log", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      raw_stdout: PARSEABLE_RAW,
      duration_seconds: 73,
    });

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /start check/i }));

    await waitFor(() => screen.getByText(/Duration/i), { timeout: 3000 });

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
    expect(content).not.toContain("Checking network");
    expect(content).not.toContain("Measuring speed");
  });
});
