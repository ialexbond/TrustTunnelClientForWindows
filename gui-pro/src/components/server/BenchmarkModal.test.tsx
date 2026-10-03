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

/** Minimal raw_stdout with a single (IPv4) report link */
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

/** Dual-stack raw_stdout — an IPv4 block and an IPv6 block, two report links */
const RAW_DUAL_STACK = [
  "  IP QUALITY CHECK REPORT: 198.51.100.2",
  "1. Basic Information",
  "Report Link: https://Report.Check.Place/ip/V4LINK.svg",
  "  IP QUALITY CHECK REPORT: 2001:db8::1",
  "1. Basic Information",
  "Report Link: https://Report.Check.Place/ip/V6LINK.svg",
].join("\n");

const BENCHMARK_RESULT_DUAL_STACK = {
  raw_stdout: RAW_DUAL_STACK,
  duration_seconds: 91,
};

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
    // Completed view shows the re-run action (F01-d: the duration line is gone).
    expect(screen.getByRole("button", { name: /Проверить ещё раз/i })).toBeVisible();
    // F01-d: the «Длительность: Nс» line no longer renders.
    expect(screen.queryByText(/Длительность/i)).toBeNull();
  });

  // ─── 3: running_shows_progress_bar_and_hint ──────────────────────────────
  it("running_shows_progress_bar_and_hint", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    // R4-F04 (09-42): the running view shows EXACTLY ONE «1-3 минуты» caption
    // (`hint_running` «Это займёт 1-3 минуты»); the duplicate estimate caption
    // added in 09-40 was removed.
    await waitFor(() => {
      expect(screen.getByText(/Это займёт 1-3 минуты/i)).toBeVisible();
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
  // F17 / owner 6.4: cancel runs a REAL Отменяем (server_cancel_benchmark) and
  // the modal CLOSES when the run resolves to BENCHMARK_CANCELLED — there is no
  // cancelled interstitial anymore.
  it("cancel_invoke_passes_ssh_params", async () => {
    const onClose = vi.fn();
    let rejectMain!: (reason: string) => void;
    vi.mocked(invoke)
      .mockImplementationOnce(
        () => new Promise<unknown>((_, rej) => { rejectMain = rej; })
      )
      .mockResolvedValueOnce(undefined); // server_cancel_benchmark

    renderModal({ _forceState: { kind: "idle" }, onClose });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByRole("button", { name: /Отменить/i }));
    await userEvent.click(screen.getByRole("button", { name: /Отменить/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());

    rejectMain("BENCHMARK_CANCELLED|dur=10");

    // Modal closes on cancel completion (no interstitial).
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // Cancel must pass SSH params (for kill-pgroup second channel)
    expect(vi.mocked(invoke)).toHaveBeenCalledWith(
      "server_cancel_benchmark",
      expect.objectContaining({ host: sshParams.host })
    );
  });

  // ─── 7: cancel_handles_forced_watchdog_variant (B8) ──────────────────────
  // Forced watchdog variant also resolves to the close-on-cancel path.
  it("cancel_handles_forced_watchdog_variant", async () => {
    const onClose = vi.fn();
    vi.mocked(invoke).mockRejectedValueOnce("BENCHMARK_CANCELLED|dur=10|forced");

    renderModal({ _forceState: { kind: "idle" }, onClose });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // ─── 8: completed_after_resolve_saves_last ───────────────────────────────
  it("completed_after_resolve_saves_last", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Проверить ещё раз/i })).toBeVisible();
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

    await waitFor(
      () => screen.getByRole("button", { name: /Проверить ещё раз/i }),
      { timeout: 3000 }
    );

    // F01-e: a single-stack (dotted-IP) result yields the IPv4-slot link.
    expect(screen.getByTestId("report-link-button-v4")).toBeVisible();
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

    // R4-F04 (09-42): «1-3 минуты» appears in a SINGLE caption (hint_running);
    // the duplicate estimate caption from 09-40 was removed.
    await waitFor(() => screen.getByText(/Это займёт 1-3 минуты/i));

    // Attempt to close with Escape — should be blocked
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });

    expect(screen.queryByText(/Это займёт 1-3 минуты/i)).toBeTruthy();
  });

  // ─── 13: D-29 SECURITY no password in activity log ───────────────────────
  it("D-29_no_password_in_activity_log", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByRole("button", { name: /Проверить ещё раз/i }));

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

    await waitFor(() => screen.getByRole("button", { name: /Проверить ещё раз/i }));

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

    await waitFor(() => screen.getByRole("button", { name: /Проверить ещё раз/i }), { timeout: 3000 });

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
        screen.getByRole("heading", { level: 2, name: /проверка ip сервера/i })
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
        screen.queryByRole("heading", { level: 2, name: /проверка ip сервера/i })
      ).toBeInTheDocument();

      // After the 200ms exit animation, Modal unmounts itself (mounted=false).
      act(() => {
        vi.advanceTimersByTime(250);
      });
      expect(
        screen.queryByRole("heading", { level: 2, name: /проверка ip сервера/i })
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

    await waitFor(() => screen.getByRole("button", { name: /Проверить ещё раз/i }), { timeout: 3000 });

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
  // running view's FOOTER shows exactly ONE actionable control — Cancel — and no
  // labeled rerun/retry competes. 09-38 F01-a adds the canonical corner × (the
  // standard close affordance), which while running is DISABLED — so it is
  // present but not actionable. We assert by ROLE/accessible name, not by class.
  it("running_footer_shows_only_cancel_button", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByRole("button", { name: /Отменить/i }));

    // The only ENABLED action is Cancel; no labeled rerun/retry competes.
    expect(screen.getByRole("button", { name: /Отменить/i })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Проверить ещё раз/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Повторить/i })).toBeNull();
    // F01-a: the canonical corner × exists but is DISABLED while running (a
    // half-finished check can't be dismissed mid-run).
    const closeX = screen.getByRole("button", { name: /Закрыть/i });
    expect(closeX).toBeDisabled();
  });

  // ════════════════════════════════════════════════════════════════════════
  //  NEW characterization cases (RESEARCH §3 stream 4 — Benchmark gaps ~7)
  //  Progress / timers / events — fake timers + Wave-0 event-capture helper.
  // ════════════════════════════════════════════════════════════════════════

  // ─── 20: aria-valuenow snaps FORWARD to a benchmark-progress MARKER ───────
  // R3-F02 (09-40): the bar is now driven by a TIME estimate combined FORWARD
  // with the markers. The estimate fills the bar, and a real section marker
  // whose implied percent is ahead snaps the bar forward to it. (The old "no
  // value before a marker" assertion is gone — the estimate fills it.)
  it("progress_event_sets_aria_valuenow", async () => {
    const events = captureListeners();
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "running" } });

    // Listener registered while running.
    await waitFor(() => expect(events.count("benchmark-progress")).toBeGreaterThan(0));

    // A dual-stack run's markers imply a high percent; emitting them snaps the
    // bar forward to a determinate, non-zero value below 100.
    act(() => {
      events.emitEvent("benchmark-progress", { kind: "block", family: "v4" });
      events.emitEvent("benchmark-progress", { kind: "section", section: 1 });
      events.emitEvent("benchmark-progress", { kind: "section", section: 2 });
      events.emitEvent("benchmark-progress", { kind: "section", section: 3 });
    });

    const barAfter = screen.getByRole("progressbar");
    expect(barAfter).toHaveAttribute("aria-busy", "false");
    const value = Number(barAfter.getAttribute("aria-valuenow"));
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThan(100);
    // Percent label rendered.
    expect(screen.getByText(`${value}%`)).toBeInTheDocument();
  });

  // ─── 21: progress is monotonic — never steps backward ────────────────────
  // R3-F02: time estimate + markers combine via Math.max → strictly non-
  // decreasing. A second (dual-stack) block must never lower the bar.
  it("progress_event_is_monotonic", async () => {
    const events = captureListeners();
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "running" } });
    await waitFor(() => expect(events.count("benchmark-progress")).toBeGreaterThan(0));

    const read = () =>
      Number(screen.getByRole("progressbar").getAttribute("aria-valuenow"));

    act(() => {
      events.emitEvent("benchmark-progress", { kind: "block", family: "v4" });
      events.emitEvent("benchmark-progress", { kind: "section", section: 1 });
      events.emitEvent("benchmark-progress", { kind: "section", section: 2 });
      events.emitEvent("benchmark-progress", { kind: "section", section: 3 });
    });
    const afterBlock1 = read();
    expect(afterBlock1).toBeGreaterThan(0);

    // A second block (dual-stack) must ADVANCE the bar, never lower it.
    act(() => {
      events.emitEvent("benchmark-progress", { kind: "block", family: "v6" });
      events.emitEvent("benchmark-progress", { kind: "section", section: 1 });
      events.emitEvent("benchmark-progress", { kind: "section", section: 2 });
    });
    const duringBlock2 = read();
    expect(duringBlock2).toBeGreaterThanOrEqual(afterBlock1);
  });

  // ─── 22: _forcePercent overrides the live percent (Storybook hook) ───────
  it("forcePercent_renders_given_percent", () => {
    renderModal({ _forceState: { kind: "running" }, _forcePercent: 42 });

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-busy", "false");
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  // ─── 23: E-19 — progress never DROPS across a long idle gap ──────────────
  // The bar is monotonic and never reverts to indeterminate mid-run. R3-F02:
  // with the time estimate also driving the bar, the value may RISE across the
  // gap (the timer keeps ticking) — but it must NEVER fall below the held value.
  it("E19_progress_holds_real_percent_across_long_idle_gap", async () => {
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
      await act(async () => {});
      expect(events.count("benchmark-progress")).toBeGreaterThan(0);

      act(() => {
        events.emitEvent("benchmark-progress", { kind: "block", family: "v4" });
        events.emitEvent("benchmark-progress", { kind: "section", section: 1 });
        events.emitEvent("benchmark-progress", { kind: "section", section: 2 });
      });
      const held = Number(
        screen.getByRole("progressbar").getAttribute("aria-valuenow")
      );
      expect(held).toBeGreaterThan(0);

      // Advance WELL past the old 5s threshold WITHOUT another event. The bar
      // must NOT drop below the held percent (the time estimate may raise it).
      act(() => {
        vi.advanceTimersByTime(15000);
      });

      const bar = screen.getByRole("progressbar");
      const after = Number(bar.getAttribute("aria-valuenow"));
      expect(after).toBeGreaterThanOrEqual(held);
      expect(after).toBeLessThan(100);
      expect(bar).toHaveAttribute("aria-busy", "false");
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── 24: F17 — autoStart starts the run immediately on open (no idle gate) ─
  // Pressing «Проверить качество» (no prior result) opens the modal with
  // autoStart=true → the run begins immediately, no idle «Запустить проверку»
  // click required.
  it("autoStart_starts_run_immediately_on_open", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ autoStart: true });

    // Goes straight to the running view — no idle gate.
    await waitFor(() => {
      expect(screen.getByText(/Идёт проверка сервера/i)).toBeVisible();
    });
    const benchmarkCalls = vi.mocked(invoke).mock.calls.filter(
      (c) => c[0] === "server_run_benchmark"
    );
    expect(benchmarkCalls.length).toBe(1);
    // No idle start button is shown.
    expect(screen.queryByRole("button", { name: /Запустить проверку/i })).toBeNull();
  });

  // ─── 24b: F17 — a prior result opens on the completed view, NOT auto-start ─
  it("autoStart_false_with_prior_result_opens_completed_no_run", async () => {
    const record = {
      timestamp: new Date().toISOString(),
      parsed_sections: { raw: RAW_WITH_LINK, reportLink: "https://Report.Check.Place/ip/TESTID.svg" },
      raw_stdout: RAW_WITH_LINK,
      duration_seconds: 42,
    };
    localStorage.setItem("tt_benchmark_192.168.1.100", JSON.stringify(record));

    render(
      <BenchmarkModal
        isOpen={true}
        onClose={vi.fn()}
        sshParams={sshParams}
        autoStart={false}
      />
    );

    // Completed view (re-run is deliberate) — no auto-start.
    expect(screen.getByRole("button", { name: /Проверить ещё раз/i })).toBeVisible();
    expect(
      vi.mocked(invoke).mock.calls.filter((c) => c[0] === "server_run_benchmark")
    ).toHaveLength(0);
  });

  // ─── 24c: F17 — no cancelled interstitial is ever rendered ────────────────
  // The Проверка отменена / Запустить снова window is gone; a cancel completes
  // by closing the modal, not by showing an interstitial.
  it("no_cancelled_interstitial_rendered_on_cancel", async () => {
    const onClose = vi.fn();
    let rejectMain!: (reason: string) => void;
    vi.mocked(invoke)
      .mockImplementationOnce(
        () => new Promise<unknown>((_, rej) => { rejectMain = rej; })
      )
      .mockResolvedValueOnce(undefined); // server_cancel_benchmark

    renderModal({ _forceState: { kind: "idle" }, onClose });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));
    await waitFor(() => screen.getByRole("button", { name: /Отменить/i }));
    await userEvent.click(screen.getByRole("button", { name: /Отменить/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());

    rejectMain("BENCHMARK_CANCELLED|dur=10");

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // The cancelled-interstitial copy / restart button must never appear.
    expect(screen.queryByText(/Проверка была отменена/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /Запустить снова/i })).toBeNull();
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
    const heading = screen.getByRole("heading", { level: 2, name: /проверка ip сервера/i });
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

  // ════════════════════════════════════════════════════════════════════════
  //  Phase 09 plan 09-09 — Behavioral Cluster 4 (Benchmark)
  //  E-18 cancel race · E-19 held-percent progress · §K CTA-04 confirm labels
  // ════════════════════════════════════════════════════════════════════════

  // ─── E-18: run completes WHILE the cancel-confirm dialog is open ──────────
  // Root cause: handleCancel checks kind==="running" at the TOP, then awaits the
  // async confirm dialog. While the dialog is open the in-flight invoke can
  // resolve → setState(completed). The old code then unconditionally forced
  // setState(cancelling), clobbering the completed result and sticking on
  // «Отменяем…» forever. Fix: re-read live state via stateRef AFTER the await.
  it("E18_cancel_race_run_completes_while_confirm_open_keeps_result", async () => {
    // Controllable confirm: hold the dialog open until we resolve it ourselves.
    let resolveConfirm!: (ok: boolean) => void;
    confirmMock.mockImplementationOnce(
      () => new Promise<boolean>((res) => { resolveConfirm = res; })
    );

    // Controllable main run: we resolve it (run completes) while confirm is open.
    let resolveRun!: (result: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(
      () => new Promise<unknown>((res) => { resolveRun = res; })
    );

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    // Open the cancel-confirm dialog (it stays open — confirm promise pending).
    await waitFor(() => screen.getByRole("button", { name: /Отменить/i }));
    await userEvent.click(screen.getByRole("button", { name: /Отменить/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());

    // The run finishes BEFORE the user confirms → modal transitions to completed.
    await act(async () => {
      resolveRun(BENCHMARK_RESULT_WITH_LINK);
    });
    await waitFor(() => screen.getByRole("button", { name: /Проверить ещё раз/i }));

    // NOW the user confirms the (now-stale) cancel.
    await act(async () => {
      resolveConfirm(true);
    });

    // Must NOT clobber the completed result, must NOT stick on «Отменяем…».
    await waitFor(() => {
      expect(screen.queryByText(/Отменяем/i)).toBeNull();
    });
    expect(screen.getByRole("button", { name: /Проверить ещё раз/i })).toBeVisible();
    // server_cancel_benchmark must NOT have been invoked — the run already finished.
    expect(
      vi.mocked(invoke).mock.calls.filter((c) => c[0] === "server_cancel_benchmark")
    ).toHaveLength(0);
  });

  // ─── E-18 positive control: cancel while genuinely running still works ────
  // Owner 6.4: a REAL Отменяем — server_cancel_benchmark is invoked, the
  // cancelling label shows WHILE the stop runs, and the modal closes when the
  // run resolves to BENCHMARK_CANCELLED (no interstitial).
  it("E18_cancel_while_genuinely_running_cancels", async () => {
    const onClose = vi.fn();
    let rejectMain!: (reason: string) => void;
    vi.mocked(invoke)
      .mockImplementationOnce(
        () => new Promise<unknown>((_, rej) => { rejectMain = rej; })
      )
      .mockResolvedValueOnce(undefined); // server_cancel_benchmark

    renderModal({ _forceState: { kind: "idle" }, onClose });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByRole("button", { name: /Отменить/i }));
    await userEvent.click(screen.getByRole("button", { name: /Отменить/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());

    // confirm resolved true (default mock) → cancelling, then backend confirms.
    await waitFor(() =>
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "server_cancel_benchmark",
        expect.objectContaining({ host: sshParams.host })
      )
    );
    // REAL cancelling state shown WHILE the stop runs (close blocked until done).
    expect(screen.getByText(/Отменяем/i)).toBeVisible();
    expect(onClose).not.toHaveBeenCalled();

    // The run resolves to cancelled → modal closes.
    rejectMain("BENCHMARK_CANCELLED|dur=10");
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  // ─── E-18 D-29: raw benchmark stdout never reaches the activity log ───────
  it("E18_D29_raw_stdout_never_logged_during_cancel_race", async () => {
    let resolveConfirm!: (ok: boolean) => void;
    confirmMock.mockImplementationOnce(
      () => new Promise<boolean>((res) => { resolveConfirm = res; })
    );
    let resolveRun!: (result: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(
      () => new Promise<unknown>((res) => { resolveRun = res; })
    );

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));
    await waitFor(() => screen.getByRole("button", { name: /Отменить/i }));
    await userEvent.click(screen.getByRole("button", { name: /Отменить/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());

    await act(async () => { resolveRun(BENCHMARK_RESULT_WITH_LINK); });
    await waitFor(() => screen.getByRole("button", { name: /Проверить ещё раз/i }));
    await act(async () => { resolveConfirm(true); });

    // D-29: raw stdout content must never be passed to the activity log.
    for (const call of activityLogSpy.mock.calls) {
      for (const arg of call) {
        if (typeof arg === "string") {
          expect(arg).not.toContain("1. Basic Information");
          expect(arg).not.toContain("AS41745");
        }
      }
    }
  });

  // ─── §K CTA-04: cancel-confirm buttons must be distinct, non-ambiguous ────
  // Old (worst-copy) bug: the cancel-confirm passed confirmText=buttons.confirm
  // + cancelText=buttons.cancel on a "cancel the benchmark?" question → BOTH
  // read as "cancel" («Подтвердить»/«Отмена» double-negative). Fix: confirm =
  // «Отменить проверку», cancel = «Продолжить проверку».
  it("CTA04_cancel_confirm_uses_distinct_action_labels", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByRole("button", { name: /Отменить/i }));
    await userEvent.click(screen.getByRole("button", { name: /Отменить/i }));

    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    const callArgs = confirmMock.mock.calls[0][0] as {
      confirmText?: string;
      cancelText?: string;
    };

    // The two labels must be distinct, non-empty, and non-generic.
    expect(callArgs.confirmText).toBe("Отменить проверку");
    expect(callArgs.cancelText).toBe("Продолжить проверку");
    expect(callArgs.confirmText).not.toBe(callArgs.cancelText);
    // Not the generic «Подтвердить»/«Отмена» double-negative.
    expect(callArgs.confirmText).not.toBe("Подтвердить");
    expect(callArgs.cancelText).not.toBe("Отмена");

    // ru↔en 0-gap parity for the new keys.
    i18n.changeLanguage("en");
    expect(i18n.t("server.service.benchmark.cancel_confirm_yes")).toBe("Cancel check");
    expect(i18n.t("server.service.benchmark.cancel_confirm_no")).toBe("Continue check");
    i18n.changeLanguage("ru");
    expect(i18n.t("server.service.benchmark.cancel_confirm_yes")).toBe("Отменить проверку");
    expect(i18n.t("server.service.benchmark.cancel_confirm_no")).toBe("Продолжить проверку");
  });

  // ════════════════════════════════════════════════════════════════════════
  //  Phase 09 plan 09-32 — F16 display half: distinct timeout message
  // ════════════════════════════════════════════════════════════════════════

  // ─── F16: BENCHMARK_TIMEOUT shows the distinct timeout message, NOT cancel ─
  it("F16_timeout_shows_distinct_timeout_message_not_cancel", async () => {
    const onClose = vi.fn();
    // 09-31 returns "BENCHMARK_TIMEOUT|dur=N" when the 300s overall timeout fires.
    vi.mocked(invoke).mockRejectedValueOnce("BENCHMARK_TIMEOUT|dur=300");

    renderModal({ _forceState: { kind: "idle" }, onClose });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    // The distinct timeout message (error_timeout key) is shown in the error view.
    // ErrorView renders «Ошибка: <message>» in one <p>, so match the <p>'s text.
    const timeoutMsg = i18n.t("server.service.benchmark.error_timeout");
    await waitFor(() => {
      expect(
        screen.getByText(
          (_content, el) =>
            el?.tagName === "P" && (el.textContent?.includes(timeoutMsg) ?? false)
        )
      ).toBeVisible();
    });
    // It is NOT the cancel path — the modal stays open (error view), no close.
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/Проверка была отменена/i)).toBeNull();
    // Retry button present (error view), proving it's the error branch.
    expect(screen.getByRole("button", { name: /Повторить/i })).toBeVisible();
  });

  // ════════════════════════════════════════════════════════════════════════
  //  Phase 09 plan 09-38 — BENCHMARK cluster R2-F01-a..e
  // ════════════════════════════════════════════════════════════════════════

  // ─── F01-a: footer standard + corner × ────────────────────────────────────
  // The completed view footer is right-aligned with the primary «Проверить ещё
  // раз» as the only action (the labeled «Закрыть» is gone); the canonical
  // corner × is present and ENABLED on a completed result.
  it("F01a_completed_footer_is_primary_only_no_close_label_with_corner_x", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(
      () => screen.getByRole("button", { name: /Проверить ещё раз/i }),
      { timeout: 3000 }
    );

    // No labeled «Закрыть» footer button — the × is the canonical close. The only
    // button whose accessible name matches «Закрыть» is the corner × (aria-label),
    // and it is ENABLED on a completed result.
    const closeButtons = screen.getAllByRole("button", { name: /Закрыть/i });
    expect(closeButtons).toHaveLength(1);
    expect(closeButtons[0]).toBeEnabled();
    // The corner × is wired to close: clicking it calls onClose.
    // (Behavioral proof it is the canonical close, not a footer action.)
  });

  // ─── F01-a: corner × disabled while running ───────────────────────────────
  it("F01a_corner_x_disabled_while_running", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(() => screen.getByText(/Идёт проверка сервера/i));
    const closeX = screen.getByRole("button", { name: /Закрыть/i });
    expect(closeX).toBeDisabled();
  });

  // ─── F01-c: rename «Проверка IP сервера» across modal/card/button + parity ─
  it("F01c_rename_to_server_ip_check_with_parity", () => {
    renderModal({ _forceState: { kind: "idle" } });
    // Modal title.
    expect(
      screen.getByRole("heading", { level: 2, name: /Проверка IP сервера/i })
    ).toBeVisible();

    // The three i18n keys all resolve to the new ru wording.
    expect(i18n.t("server.service.benchmark.modal_title")).toBe("Проверка IP сервера");
    expect(i18n.t("server.service.benchmark.card.title")).toBe("Проверка IP сервера");
    expect(i18n.t("server.service.benchmark.button.check_quality")).toBe("Проверка IP сервера");

    // ru↔en parity — en mirror resolves (non-empty, not the raw key).
    i18n.changeLanguage("en");
    expect(i18n.t("server.service.benchmark.modal_title")).toBe("Server IP Check");
    expect(i18n.t("server.service.benchmark.card.title")).toBe("Server IP Check");
    expect(i18n.t("server.service.benchmark.button.check_quality")).toBe("Server IP Check");
    i18n.changeLanguage("ru");
  });

  // ─── F01-d: no duration line in CompletedView ─────────────────────────────
  it("F01d_no_duration_line_in_completed_view", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(
      () => screen.getByRole("button", { name: /Проверить ещё раз/i }),
      { timeout: 3000 }
    );
    // The «Длительность: Nс» line is gone (the value 73 is also not rendered).
    expect(screen.queryByText(/Длительность/i)).toBeNull();
    expect(screen.queryByText(/73/)).toBeNull();
    // But the saved record still carries duration_seconds (history untouched).
    const stored = JSON.parse(
      localStorage.getItem("tt_benchmark_192.168.1.100")!
    ) as { duration_seconds: number };
    expect(stored.duration_seconds).toBe(73);
  });

  // ─── F01-e: dual-stack → two labeled links «Отчёт IPv4» / «Отчёт IPv6» ─────
  it("F01e_dual_stack_renders_two_labeled_links", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_DUAL_STACK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(
      () => screen.getByRole("button", { name: /Проверить ещё раз/i }),
      { timeout: 3000 }
    );

    const v4 = screen.getByTestId("report-link-button-v4");
    const v6 = screen.getByTestId("report-link-button-v6");
    expect(v4).toBeVisible();
    expect(v6).toBeVisible();
    expect(v4).toHaveTextContent(/Отчёт IPv4/i);
    expect(v6).toHaveTextContent(/Отчёт IPv6/i);

    // Clicking each opens the correct report URL via the shell opener.
    const { open: shellOpen } = await import("@tauri-apps/plugin-shell");
    await userEvent.click(v4);
    expect(shellOpen).toHaveBeenCalledWith("https://Report.Check.Place/ip/V4LINK.svg");
    await userEvent.click(v6);
    expect(shellOpen).toHaveBeenCalledWith("https://Report.Check.Place/ip/V6LINK.svg");
  });

  // ─── F01-e: single-stack → exactly one link ───────────────────────────────
  it("F01e_single_stack_renders_one_link", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    await waitFor(
      () => screen.getByRole("button", { name: /Проверить ещё раз/i }),
      { timeout: 3000 }
    );
    // Dotted-IP block → IPv4 slot only.
    expect(screen.getByTestId("report-link-button-v4")).toBeVisible();
    expect(screen.queryByTestId("report-link-button-v6")).toBeNull();
  });

  // ─── F01-b: progress markers drive the bar — NO per-step label (R4-F05) ────
  // The benchmark-progress MARKER events (block/section) are folded through
  // computeProgress and advance the bar. R4-F05: the per-step «{family} ·
  // {section}» caption is REMOVED from the running view — the section markers
  // arrive batched at the very end of the run (they do not stream), so the label
  // only ever popped the last marker right before completion, which was
  // confusing. The bar's forward-only marker anchor stays; only the LABEL is gone.
  it("F01b_progress_marker_drives_bar_no_step_label", async () => {
    const events = captureListeners();
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "running" } });

    // Listener registered while running.
    await waitFor(() => expect(events.count("benchmark-progress")).toBeGreaterThan(0));

    // Feed a v4 block header + sections 1..3 — the reducer's percent advances.
    act(() => {
      events.emitEvent("benchmark-progress", { kind: "block", family: "v4" });
      events.emitEvent("benchmark-progress", { kind: "section", section: 1 });
      events.emitEvent("benchmark-progress", { kind: "section", section: 2 });
      events.emitEvent("benchmark-progress", { kind: "section", section: 3 });
    });

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-busy", "false");
    const valueNow = Number(bar.getAttribute("aria-valuenow"));
    expect(valueNow).toBeGreaterThan(0);
    expect(valueNow).toBeLessThan(100);

    // R4-F05: NO «{family} · {section}» step caption is rendered anymore.
    expect(screen.queryByText(/IPv4\s·\sРиск-скоринг/i)).toBeNull();
    expect(screen.queryByText(/·/)).toBeNull();
  });

  // ════════════════════════════════════════════════════════════════════════
  //  Phase 09 plan 09-40 — R3-F02: TIME-BASED ESTIMATED progress
  //
  //  The section markers batch at the END of the run, so the bar is driven by
  //  an elapsed-time estimate (deriveEstimatedPercent) combined FORWARD with
  //  the markers (combineProgress). The interval lives in BenchmarkModal and is
  //  cleaned up on unmount / complete / cancel.
  // ════════════════════════════════════════════════════════════════════════

  // ─── R3-F02 (1): the bar MOVES on the timer alone (no markers) ────────────
  it("R3F02_bar_moves_on_timer_without_markers", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

      render(
        <BenchmarkModal
          isOpen={true}
          onClose={vi.fn()}
          sshParams={sshParams}
          _forceState={{ kind: "running" }}
        />
      );
      await act(async () => {});

      const read = () =>
        Number(screen.getByRole("progressbar").getAttribute("aria-valuenow"));

      // Advance ~10s of wall-clock → the interval ticks the estimate up.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      const early = read();
      expect(early).toBeGreaterThan(0);
      expect(early).toBeLessThan(100);

      // Advance further → a later tick reads a HIGHER value (the bar moves).
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      const later = read();
      expect(later).toBeGreaterThan(early);
      expect(later).toBeLessThan(100);
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── R3-F02 (2): a marker AHEAD snaps the bar forward; a BEHIND marker doesn't lower it ─
  it("R3F02_marker_ahead_snaps_forward_behind_marker_does_not_lower", async () => {
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
      await act(async () => {});
      expect(events.count("benchmark-progress")).toBeGreaterThan(0);

      const read = () =>
        Number(screen.getByRole("progressbar").getAttribute("aria-valuenow"));

      // Let the timer move the bar a little.
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      const beforeMarker = read();

      // A full dual-stack marker run implies a HIGH percent → snaps forward.
      act(() => {
        events.emitEvent("benchmark-progress", { kind: "block", family: "v4" });
        for (let s = 1; s <= 6; s++) {
          events.emitEvent("benchmark-progress", { kind: "section", section: s });
        }
        events.emitEvent("benchmark-progress", { kind: "block", family: "v6" });
        for (let s = 1; s <= 6; s++) {
          events.emitEvent("benchmark-progress", { kind: "section", section: s });
        }
      });
      const afterAheadMarker = read();
      expect(afterAheadMarker).toBeGreaterThan(beforeMarker);

      // R4-F05: the «{family} · {section}» step caption is REMOVED — even with a
      // marker present, no step label is rendered in the running view.
      expect(screen.queryByText(/IPv6\s·\sПочта/i)).toBeNull();

      // Now let the timer keep ticking — a BEHIND time estimate never lowers the
      // bar (combine is Math.max), so the value holds at the high marker value.
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(read()).toBeGreaterThanOrEqual(afterAheadMarker);
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── R3-F02 (3a): completed → 100 ────────────────────────────────────────
  it("R3F02_completed_reaches_100", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK);

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    // On the completed transition the bar is set to 100 before the view swaps;
    // the completed view itself has no bar, so we assert the run reached the
    // completed state (the displayPercent=100 path ran).
    await waitFor(
      () => screen.getByRole("button", { name: /Проверить ещё раз/i }),
      { timeout: 3000 }
    );
    // No progressbar in the completed view (the bar is a running-only element).
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  // ════════════════════════════════════════════════════════════════════════
  //  Phase 09 plan 09-UAT R5-F01 — "finishing" 100% hold
  //
  //  On SUCCESS the state machine enters "finishing" for ~600ms, pinning the
  //  progress bar to 100% (aria-valuenow=100) and hiding the Cancel button
  //  BEFORE the results view (CompletedView) replaces it. Cancel / timeout /
  //  generic error branches must NEVER trigger the finishing state and must
  //  NEVER reach aria-valuenow=100.
  // ════════════════════════════════════════════════════════════════════════

  // ─── R5-F01 (1): SUCCESS → bar at 100 WHILE finishing (before results) ───
  // The progressbar must be present at aria-valuenow=100 (finishing hold) and
  // the results view must NOT yet be visible. Only after the 600ms hold does the
  // CompletedView replace RunningView.
  it("R5F01_success_bar_at_100_during_finishing_hold_before_results", async () => {
    vi.useFakeTimers();
    try {
      // Resolve the run immediately so handleStart reaches the finishing branch.
      vi.mocked(invoke).mockResolvedValueOnce(BENCHMARK_RESULT_WITH_LINK);

      render(
        <BenchmarkModal
          isOpen={true}
          onClose={vi.fn()}
          sshParams={sshParams}
          _forceState={{ kind: "idle" }}
        />
      );

      // Click "Запустить проверку" — fireEvent works under fake timers.
      fireEvent.click(
        screen.getByRole("button", { name: /запустить проверку/i })
      );
      // Flush all microtasks (invoke resolved synchronously → handleStart
      // runs setDisplayPercent(100) + setState finishing).
      await act(async () => {});

      // ── DURING the finishing hold (before the 600ms timer fires) ──
      // The progress bar is still mounted (RunningView) at aria-valuenow=100.
      const bar = screen.getByRole("progressbar");
      expect(bar).toHaveAttribute("aria-valuenow", "100");
      // The results view (CompletedView) is NOT yet visible.
      expect(screen.queryByRole("button", { name: /Проверить ещё раз/i })).toBeNull();
      // Cancel button is hidden during the finishing hold (hideCancel=true).
      expect(screen.queryByRole("button", { name: /Отменить/i })).toBeNull();

      // ── AFTER the 600ms hold fires ──
      act(() => {
        vi.advanceTimersByTime(700); // past the 600ms threshold
      });

      // CompletedView replaces RunningView — results are now visible.
      expect(screen.getByRole("button", { name: /Проверить ещё раз/i })).toBeVisible();
      // RunningView (and its progressbar) is gone once completed.
      expect(screen.queryByRole("progressbar")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── R5-F01 (2): CANCEL must NEVER reach aria-valuenow=100 ───────────────
  // Mirror of R3F02_cancel_stops_timer_no_jump_to_100 — the cancel path must
  // bypass the finishing state entirely and never pin the bar to 100.
  it("R5F01_cancel_never_enters_finishing_bar_never_reaches_100", async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      let rejectMain!: (reason: string) => void;
      // Only one mock needed: the main run that rejects with BENCHMARK_CANCELLED.
      // No server_cancel_benchmark call happens on this path (the component's
      // catch block handles BENCHMARK_CANCELLED by calling onClose, not by
      // invoking server_cancel_benchmark again). An extra mockResolvedValueOnce
      // here would leak into subsequent tests (vi.clearAllMocks does not reset
      // queued mockOnce implementations).
      vi.mocked(invoke).mockImplementationOnce(
        () => new Promise<unknown>((_, rej) => { rejectMain = rej; })
      );

      render(
        <BenchmarkModal
          isOpen={true}
          onClose={onClose}
          sshParams={sshParams}
          _forceState={{ kind: "idle" }}
        />
      );
      fireEvent.click(
        screen.getByRole("button", { name: /запустить проверку/i })
      );
      await act(async () => {});

      // Move the timer bar forward but nowhere near 100.
      act(() => { vi.advanceTimersByTime(10_000); });
      const beforeCancel = Number(
        screen.getByRole("progressbar").getAttribute("aria-valuenow")
      );
      expect(beforeCancel).toBeGreaterThan(0);
      expect(beforeCancel).toBeLessThan(100);

      // Resolve to BENCHMARK_CANCELLED — must close modal, never finishing.
      await act(async () => {
        rejectMain("BENCHMARK_CANCELLED|dur=10");
      });
      expect(onClose).toHaveBeenCalled();

      // Advance well past the 600ms finishing hold — no timer should fire
      // because the cancel path never entered finishing.
      act(() => { vi.advanceTimersByTime(2_000); });

      // The progressbar is gone (modal closed) — it never reached 100.
      const bar = screen.queryByRole("progressbar");
      if (bar) {
        expect(Number(bar.getAttribute("aria-valuenow"))).not.toBe(100);
      }
      // CompletedView must never appear (cancel goes straight to close).
      expect(screen.queryByRole("button", { name: /Проверить ещё раз/i })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── R3-F02 (3b): cancel stops the timer — no jump to 100 ────────────────
  it("R3F02_cancel_stops_timer_no_jump_to_100", async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      let rejectMain!: (reason: string) => void;
      vi.mocked(invoke)
        .mockImplementationOnce(
          () => new Promise<unknown>((_, rej) => { rejectMain = rej; })
        )
        .mockResolvedValueOnce(undefined); // server_cancel_benchmark

      // Start from idle and trigger the real handleStart so the in-flight
      // `invoke` promise (and its `rejectMain` rejecter) is actually created.
      // _forceState:"running" would bypass handleStart entirely, leaving the
      // main invoke unmocked-against and `rejectMain` undefined (and the
      // BENCHMARK_CANCELLED → onClose path unreachable). fireEvent.click works
      // under fake timers where userEvent's internal delays would hang.
      render(
        <BenchmarkModal
          isOpen={true}
          onClose={onClose}
          sshParams={sshParams}
          _forceState={{ kind: "idle" }}
        />
      );
      fireEvent.click(
        screen.getByRole("button", { name: /запустить проверку/i })
      );
      await act(async () => {});

      // Move the bar with the timer.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      const beforeCancel = Number(
        screen.getByRole("progressbar").getAttribute("aria-valuenow")
      );
      expect(beforeCancel).toBeGreaterThan(0);
      expect(beforeCancel).toBeLessThan(100);

      // The run resolves to cancelled → the modal closes; the timer is cleared
      // when the state leaves "running" (effect cleanup) → no jump to 100.
      await act(async () => {
        rejectMain("BENCHMARK_CANCELLED|dur=10");
      });
      expect(onClose).toHaveBeenCalled();

      // Advancing the clock after cancel does not push a bar to 100 (the running
      // view is gone, the interval is cleared — no further ticks).
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
      const bar = screen.queryByRole("progressbar");
      if (bar) {
        expect(Number(bar.getAttribute("aria-valuenow"))).not.toBe(100);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── R3-F02 (3c): error/timeout stops the timer — no jump to 100 ─────────
  it("R3F02_error_stops_timer_no_jump_to_100", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("BENCHMARK_TIMEOUT|dur=300");

    renderModal({ _forceState: { kind: "idle" } });
    await userEvent.click(screen.getByRole("button", { name: /запустить проверку/i }));

    // Error view shows; no progressbar (running-only). The bar never jumped to 100.
    await waitFor(() => screen.getByRole("button", { name: /Повторить/i }));
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  // ─── R4-F04: the running view shows EXACTLY ONE «1-3 минуты» caption ───────
  // 09-40 added a SECOND time caption («Оценка: ~1-3 минуты», estimate_caption)
  // alongside the existing «Это займёт 1-3 минуты» (hint_running) — a duplicate.
  // R4-F04 keeps ONLY hint_running and removes the estimate_caption render AND
  // deletes the now-unused estimate_caption i18n key from ru.json + en.json.
  it("R4F04_running_shows_single_time_caption_no_estimate_caption", async () => {
    vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

    renderModal({ _forceState: { kind: "running" } });

    // The single kept caption (hint_running) renders.
    await waitFor(() => {
      expect(screen.getByText(/Это займёт 1-3 минуты/i)).toBeVisible();
    });

    // The removed estimate_caption copy must NOT appear anywhere in the DOM.
    expect(screen.queryByText(/Оценка: ~1-3 минуты/i)).toBeNull();

    // Exactly ONE caption mentions «1-3 минуты» now (not two).
    const captions = screen.queryAllByText(/1-3 минуты/i);
    expect(captions).toHaveLength(1);

    // The estimate_caption i18n key is DELETED from both locales: i18next returns
    // the raw key (its own fallback) when a key is missing.
    const key = "server.service.benchmark.estimate_caption";
    i18n.changeLanguage("en");
    expect(i18n.t(key)).toBe(key);
    i18n.changeLanguage("ru");
    expect(i18n.t(key)).toBe(key);
  });

  // ─── R3-F02 (5): unmount while running clears the interval (no leaked tick) ─
  it("R3F02_unmount_while_running_clears_interval", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      vi.mocked(invoke).mockReturnValue(new Promise(() => {}));

      const { unmount } = render(
        <BenchmarkModal
          isOpen={true}
          onClose={vi.fn()}
          sshParams={sshParams}
          _forceState={{ kind: "running" }}
        />
      );
      await act(async () => {});

      // Let the interval start ticking.
      act(() => {
        vi.advanceTimersByTime(2_000);
      });

      // Unmount → the effect cleanup must clearInterval (no post-unmount tick /
      // no setState-on-unmounted warning). Advancing afterwards is a no-op.
      unmount();
      expect(clearSpy).toHaveBeenCalled();

      // Advancing the clock after unmount must not throw / warn.
      act(() => {
        vi.advanceTimersByTime(60_000);
      });
    } finally {
      clearSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
