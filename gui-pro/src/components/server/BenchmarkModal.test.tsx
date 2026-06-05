import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { renderWithProviders as render } from "../../test/test-utils";
import { BenchmarkModal } from "./BenchmarkModal";
import { captureListeners } from "../../test/fixtures";

// ─── Mock: Tauri plugin-shell ─────────────────────────────────────────────────
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn().mockResolvedValue(undefined),
}));

// ─── Mock: Tauri event (listen) ───────────────────────────────────────────────
// Default no-op; tests that need real progress events re-point it with
// captureListeners() (Wave-0 event-capture helper) before render.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}), // returns unlisten no-op
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

  // Safety net: a fake-timer test that times out may skip its own
  // `vi.useRealTimers()` finally block, leaking fake timers into the next
  // (real-timer) test and hanging its userEvent interaction. Always restore.
  afterEach(() => {
    vi.useRealTimers();
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
    // New format: single object (not array)
    localStorage.setItem("tt_benchmark_192.168.1.100", JSON.stringify(record));
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

  // ─── 3: running_shows_progress_bar_and_hint ──────────────────────────────
  it("running_shows_progress_bar_and_hint", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => {
      expect(screen.getByText(/1-3 минуты/i)).toBeVisible();
    });
    // Generic running text (no stage labels — indeterminate progress bar)
    expect(screen.getByText(/Идёт проверка сервера/i)).toBeVisible();
    // Progress bar — aria-busy="true" when no percent received yet
    const bar = screen.getByRole("progressbar");
    expect(bar).toBeInTheDocument();
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

  // ─── 6: cancel_invoke_passes_ssh_params ──────────────────────────────────
  it("cancel_invoke_passes_ssh_params", async () => {
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
    // Cancel must pass SSH params (for kill-pgroup second channel)
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "server_cancel_benchmark",
      expect.objectContaining({ host: sshParams.host })
    );
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

  // ─── 8: completed_after_resolve_saves_last ───────────────────────────────
  it("completed_after_resolve_saves_last", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/Длительность/i).length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    const stored = localStorage.getItem("tt_benchmark_192.168.1.100");
    expect(stored).not.toBeNull();
    // New format: single object (not array)
    const parsed = JSON.parse(stored!) as unknown;
    expect(typeof parsed).toBe("object");
    expect(!Array.isArray(parsed)).toBe(true);
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

  // ─── 11: no_report_link_shows_banner_no_raw_accordion ────────────────────
  it("no_report_link_shows_banner_no_raw_accordion", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_NO_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => {
      expect(screen.getByText(/Ссылка на отчёт не найдена/i)).toBeVisible();
    }, { timeout: 3000 });

    // Raw accordion must NOT be present (removed per UAT 2026-05-20 round 4)
    expect(screen.queryByText(/Вывод скрипта/i)).toBeNull();
    // Raw content itself must NOT be in the DOM
    expect(screen.queryByText(/garbled text/i)).toBeNull();
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

  // ════════════════════════════════════════════════════════════════════════
  //  REWRITTEN false greens (was :352-387 `?raw` source-scan `.toContain`)
  //
  //  RESEARCH §3 stream 4: the old tests imported `BenchmarkModal.tsx?raw`
  //  and asserted on the SOURCE TEXT (`content.toContain("justify-end gap-2")`,
  //  `content.not.toContain("if (!isOpen) return null")`, etc.). A source-scan
  //  green proves nothing about the RENDERED DOM — it would stay green even if
  //  the component rendered nothing. These are rewritten to BEHAVIORAL
  //  assertions that exercise the real lifecycle / rendered output.
  // ════════════════════════════════════════════════════════════════════════

  // ─── 16 (rewrite of early_return_null_anti_pattern_absent): T-03 ─────────
  // The old test scanned source for `if (!isOpen) return null`. The behavioral
  // invariant it was protecting: BenchmarkModal renders <Modal> UNCONDITIONALLY,
  // so when isOpen flips true→false the Modal stays mounted long enough to play
  // its 200ms exit animation. If the anti-pattern existed, React would unmount
  // the whole subtree synchronously and the content would vanish immediately.
  it("T03_content_stays_mounted_during_exit_animation_when_closed", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <BenchmarkModal
          isOpen={true}
          onClose={vi.fn()}
          sshParams={sshParams}
        />
      );
      // Open → Modal mounts after the double-RAF enter flush.
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(
        screen.getByRole("heading", { level: 2, name: /проверка качества сервера/i })
      ).toBeInTheDocument();

      // Flip to closed — parent must NOT short-circuit to null.
      rerender(
        <BenchmarkModal
          isOpen={false}
          onClose={vi.fn()}
          sshParams={sshParams}
        />
      );
      // Immediately after close (before the 200ms exit timer fires) the modal
      // heading is STILL in the DOM — proves no `if (!isOpen) return null`.
      expect(
        screen.queryByRole("heading", { level: 2, name: /проверка качества сервера/i })
      ).toBeInTheDocument();

      // After the 200ms exit animation, Modal unmounts itself (mounted=false).
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(
        screen.queryByRole("heading", { level: 2, name: /проверка качества сервера/i })
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── 17 (rewrite of B1_old_stage_labels_absent): no stage labels rendered ─
  // The old test scanned source for the strings "Проверяем сеть" /
  // "Замеряем скорость". Behavioral: while running, NO stage labels are shown —
  // only the generic running text + an indeterminate progress bar.
  it("running_renders_no_stage_labels", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByText(/Идёт проверка сервера/i));

    // The removed per-stage labels must NOT appear in the rendered DOM.
    expect(screen.queryByText(/Проверяем сеть/i)).toBeNull();
    expect(screen.queryByText(/Замеряем скорость/i)).toBeNull();
    // Only the generic running text + bar remain.
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  // ─── 18 (rewrite of no_raw_accordion_in_completed_view): behavioral ──────
  // The old test scanned source for `"raw-output"` / `rawOutputAccordion`.
  // Behavioral: the completed view shows NO raw-output accordion control and
  // does NOT render the raw stdout text into the DOM (UAT 2026-05-20 round 4).
  it("completed_view_has_no_raw_output_accordion", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByText(/Длительность/i), { timeout: 3000 });

    // No accordion toggle labelled with the raw-output title.
    expect(screen.queryByRole("button", { name: /Вывод скрипта/i })).toBeNull();
    expect(screen.queryByText(/Вывод скрипта/i)).toBeNull();
    // The raw stdout content itself is never rendered.
    expect(screen.queryByText(/1\. Basic Information/i)).toBeNull();
    expect(screen.queryByText(/AS41745/i)).toBeNull();
  });

  // ─── 19 (rewrite of cancel_button_follows_modal_footer_convention) ───────
  // The old test scanned source for `"justify-end gap-2"` (a CSS class) — both
  // a source-scan AND a CSS coupling (double D-04 violation). Behavioral: the
  // running view shows exactly ONE actionable control — the Cancel button — and
  // no other footer button competes with it. We assert by ROLE/accessible name,
  // not by class.
  it("running_footer_shows_only_cancel_button", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByRole("button", { name: /Отменить/i }));

    // The only button in the running view is Cancel — no Close / rerun / retry.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAccessibleName(/Отменить/i);
    expect(screen.queryByRole("button", { name: /Закрыть/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Проверить ещё раз/i })).toBeNull();
  });

  // ════════════════════════════════════════════════════════════════════════
  //  NEW characterization cases (RESEARCH §3 stream 4 — Benchmark gaps ~7)
  //  Progress / timers / events — fake timers + Wave-0 event-capture helper.
  // ════════════════════════════════════════════════════════════════════════

  // ─── 20: aria-valuenow updates from benchmark-progress event ─────────────
  it("progress_event_sets_aria_valuenow", async () => {
    const events = captureListeners();
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "running" } });

    // Initially indeterminate — aria-busy, no aria-valuenow.
    const barBefore = screen.getByRole("progressbar");
    expect(barBefore).toHaveAttribute("aria-busy", "true");
    expect(barBefore).not.toHaveAttribute("aria-valuenow");

    // Listener registered while running.
    await waitFor(() => expect(events.count("benchmark-progress")).toBeGreaterThan(0));

    act(() => {
      events.emitEvent("benchmark-progress", { percent: 37 });
    });

    const barAfter = screen.getByRole("progressbar");
    expect(barAfter).toHaveAttribute("aria-valuenow", "37");
    expect(barAfter).toHaveAttribute("aria-busy", "false");
    // Percent label rendered.
    expect(screen.getByText("37%")).toBeInTheDocument();
  });

  // ─── 21: progress is monotonic — a lower percent is ignored ──────────────
  it("progress_event_is_monotonic", async () => {
    const events = captureListeners();
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "running" } });
    await waitFor(() => expect(events.count("benchmark-progress")).toBeGreaterThan(0));

    act(() => {
      events.emitEvent("benchmark-progress", { percent: 60 });
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60");

    // A regressive value must NOT lower the bar (Math.max guard).
    act(() => {
      events.emitEvent("benchmark-progress", { percent: 25 });
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "60");

    // A higher value advances it.
    act(() => {
      events.emitEvent("benchmark-progress", { percent: 88 });
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "88");
  });

  // ─── 22: _forcePercent overrides the live percent (Storybook hook) ───────
  it("forcePercent_renders_given_percent", () => {
    renderModal({ _forceState: { kind: "running" }, _forcePercent: 42 });

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  // ─── 23: 5s idle without progress reverts to indeterminate ───────────────
  it("progress_reverts_to_indeterminate_after_5s_idle", async () => {
    vi.useFakeTimers();
    try {
      const events = captureListeners();
      vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

      render(
        <BenchmarkModal
          isOpen={true}
          onClose={vi.fn()}
          sshParams={sshParams}
          _forceState={{ kind: "running" }}
        />
      );

      // Flush the `listen().then(...)` microtask that registers the listener.
      // Under fake timers `waitFor`'s real-timer polling never advances, so we
      // flush microtasks via an empty async act instead.
      await act(async () => {});
      expect(events.count("benchmark-progress")).toBeGreaterThan(0);

      act(() => {
        events.emitEvent("benchmark-progress", { percent: 50 });
      });
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");

      // 5s pass with no further progress → fallback timer fires → setPercent(null).
      act(() => {
        vi.advanceTimersByTime(5000);
      });

      const bar = screen.getByRole("progressbar");
      expect(bar).not.toHaveAttribute("aria-valuenow");
      expect(bar).toHaveAttribute("aria-busy", "true");
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── 24: cancelled → restart resets to idle ──────────────────────────────
  it("cancelled_restart_resets_to_idle", async () => {
    renderModal({ _forceState: { kind: "cancelled" } });

    expect(screen.getByText(/Проверка была отменена/i)).toBeVisible();

    // "Запустить снова" returns to the idle view (no auto re-invoke).
    await userEvent.click(screen.getByRole("button", { name: /Запустить снова/i }));

    expect(screen.getByText(/Нажмите «Проверить качество»/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /Запустить проверку/i })).toBeVisible();
    // Restart is local state-only — no benchmark invoked.
    expect(
      vi.mocked(invoke).mock.calls.filter((c) => c[0] === "server_run_benchmark")
    ).toHaveLength(0);
  });

  // ─── 25: error → retry resets to idle ────────────────────────────────────
  it("error_retry_resets_to_idle", async () => {
    renderModal({ _forceState: { kind: "error", message: "boom-network-fail" } });

    expect(screen.getByText(/boom-network-fail/i)).toBeVisible();
    expect(screen.getByText(/Ошибка:/i)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: /Повторить/i }));

    // Retry goes back to idle (NOT an automatic re-run).
    expect(screen.getByText(/Нажмите «Проверить качество»/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /Запустить проверку/i })).toBeVisible();
  });

  // ─── 26: backdrop click blocked while running ────────────────────────────
  it("backdrop_click_does_not_close_while_running", async () => {
    const onClose = vi.fn();
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    render(
      <BenchmarkModal
        isOpen={true}
        onClose={onClose}
        sshParams={sshParams}
        _forceState={{ kind: "idle" }}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));
    await waitFor(() => screen.getByText(/Идёт проверка сервера/i));

    // The backdrop is the portal root's flex container — simulate a full
    // mousedown+mouseup gesture on it. While running closeOnBackdrop=false, so
    // onClose must NOT fire and the running view stays mounted.
    const heading = screen.getByRole("heading", { level: 2, name: /проверка качества сервера/i });
    // The backdrop is the outermost fixed-inset div in the portal.
    const backdrop = heading.closest("div.fixed");
    expect(backdrop).not.toBeNull();
    fireEvent.mouseDown(backdrop!);
    fireEvent.mouseUp(backdrop!);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/Идёт проверка сервера/i)).toBeVisible();
  });

  // ─── 27: T-03 delayed cleanup — running state reset 200ms after close ─────
  it("T03_delayed_cleanup_resets_running_state_after_close", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

      const { rerender } = render(
        <BenchmarkModal
          isOpen={true}
          onClose={vi.fn()}
          sshParams={sshParams}
          _forceState={{ kind: "running" }}
        />
      );

      // Modal enter flush.
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(screen.getByText(/Идёт проверка сервера/i)).toBeInTheDocument();

      // Close the modal — both Modal exit (200ms) and the parent's T-03 cleanup
      // (200ms) timers start.
      rerender(
        <BenchmarkModal
          isOpen={false}
          onClose={vi.fn()}
          sshParams={sshParams}
          _forceState={{ kind: "running" }}
        />
      );

      // Advance past both 200ms timers.
      act(() => {
        vi.advanceTimersByTime(250);
      });

      // Modal subtree fully gone.
      expect(screen.queryByText(/Идёт проверка сервера/i)).not.toBeInTheDocument();

      // Re-open the modal: because the parent reset running→idle during cleanup,
      // the modal now shows the idle view (NOT the stale running view).
      rerender(
        <BenchmarkModal
          isOpen={true}
          onClose={vi.fn()}
          sshParams={sshParams}
          _forceState={{ kind: "running" }}
        />
      );
      act(() => {
        vi.advanceTimersByTime(50);
      });

      // Idle start button is shown — proves the stale running state was reset.
      expect(
        screen.getByRole("button", { name: /запустить проверку/i })
      ).toBeInTheDocument();
      expect(screen.queryByText(/Идёт проверка сервера/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
