import { describe, it, expect, vi, beforeEach } from "vitest";
import LogsViewerModalSource from "./LogsViewerModal.tsx?raw";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { LogsViewerModal } from "./LogsViewerModal";
import { renderWithProviders as render } from "../../test/test-utils";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// D-29: activityLogSpy — security assertion (password / full-log body NEVER logged)
// vi.hoisted ensures mocks are defined before module factory runs.
const { activityLogSpy, invokeMock, saveMock } = vi.hoisted(() => ({
  activityLogSpy: vi.fn(),
  invokeMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: activityLogSpy }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: saveMock,
}));

// ─── Fixtures ───────────────────────────────────────────────────────────────

const SSH_PARAMS = {
  host: "logs-test.example.com",
  port: 22,
  user: "root",
  password: "testpass-LOGS-XYZ",
};

const SAMPLE_LOGS = [
  "May 17 10:00:01 INFO TrustTunnel started",
  "May 17 10:01:00 ERROR Failed to connect: timeout",
  "May 17 10:02:00 WARN High memory usage: 87%",
].join("\n");

// ─── Suite ──────────────────────────────────────────────────────────────────

describe("LogsViewerModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");

    // Default: invoke server_get_logs returns sample logs
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "server_get_logs") return Promise.resolve(SAMPLE_LOGS);
      if (cmd === "write_string_to_path") return Promise.resolve(undefined);
      return Promise.reject(new Error(`Unexpected invoke: ${cmd}`));
    });

    // Default: save dialog returns a path
    saveMock.mockResolvedValue("/tmp/trusttunnel-logs-test.txt");

    // Mock clipboard
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  // ─── Test 1: auto-loads on open ──────────────────────────────────────────

  it("auto_loads_on_open — invokes server_get_logs when no initialLogs", async () => {
    render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
      />,
    );
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("server_get_logs", SSH_PARAMS);
    });
  });

  // ─── Test 2: renders loaded logs in mono <pre> ───────────────────────────

  it("renders_loaded_logs_with_mono_class — pre element contains log lines", async () => {
    render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
        initialLogs={SAMPLE_LOGS}
        _forceState="loaded"
      />,
    );
    const pre = await screen.findByTestId("logs-pre");
    expect(pre).toBeInTheDocument();
    expect(pre.textContent).toContain("INFO TrustTunnel started");
    expect(pre.textContent).toContain("ERROR Failed to connect");
    expect(pre.textContent).toContain("WARN High memory");
  });

  // ─── Test 2b: per-line render (F13) — one row per non-empty line ──────────

  it("renders_one_row_per_line — each non-empty log line is its own data-testid=log-line row", async () => {
    render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
        initialLogs={SAMPLE_LOGS}
        _forceState="loaded"
      />,
    );
    const rows = await screen.findAllByTestId("log-line");
    // SAMPLE_LOGS has exactly 3 non-empty lines
    expect(rows.length).toBe(3);
  });

  // ─── Test 2c: severity as data attribute, not whole-line colour (F13) ─────

  it("error_line_carries_severity_attribute — severity read via data-severity, not CSS colour", async () => {
    render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
        initialLogs={SAMPLE_LOGS}
        _forceState="loaded"
      />,
    );
    const rows = await screen.findAllByTestId("log-line");
    // Find the ERROR line and assert its severity attribute.
    const errorRow = rows.find((r) =>
      (r.textContent ?? "").includes("ERROR Failed to connect"),
    );
    expect(errorRow).toBeDefined();
    expect(errorRow?.getAttribute("data-severity")).toBe("error");
    // The WARN line is classified as warn.
    const warnRow = rows.find((r) =>
      (r.textContent ?? "").includes("WARN High memory"),
    );
    expect(warnRow?.getAttribute("data-severity")).toBe("warn");
    // A plain info line carries the info severity.
    const infoRow = rows.find((r) =>
      (r.textContent ?? "").includes("INFO TrustTunnel started"),
    );
    expect(infoRow?.getAttribute("data-severity")).toBe("info");
  });

  // ─── Test 2d: corner X present, no labeled close button in footer (F18) ───

  it("has_corner_close_x_and_no_labeled_close_button — canonical close X, footer drops labeled close", async () => {
    render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
        initialLogs={SAMPLE_LOGS}
        _forceState="loaded"
      />,
    );
    // Canonical corner X exposes the buttons.close accessible name.
    const closeButtons = await screen.findAllByRole("button", {
      name: i18n.t("buttons.close"),
    });
    // Exactly ONE button carries the buttons.close name (the corner X) —
    // the redundant labeled footer close button is gone (F18).
    expect(closeButtons.length).toBe(1);
  });

  // ─── Test 2e: search highlight still wraps matches in <mark> ──────────────

  it("search_highlight_wraps_matches_in_mark — renderHighlighted still emits mark element", async () => {
    render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
        initialLogs={SAMPLE_LOGS}
        _forceState="loaded"
      />,
    );
    const searchInput = screen.getByPlaceholderText(
      i18n.t("server.logs.modal.search_placeholder"),
    );
    fireEvent.change(searchInput, { target: { value: "ERROR" } });
    // Modal renders into a portal on document.body, so query the document, not
    // the render container.
    await waitFor(() => {
      const marks = document.body.querySelectorAll("mark");
      expect(marks.length).toBeGreaterThan(0);
    });
  });

  // ─── Test 3: search filter shows only matching lines ─────────────────────

  it("search_filter_shows_only_matching_lines — filter by 'error' hides other lines", async () => {
    render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
        initialLogs={SAMPLE_LOGS}
        _forceState="loaded"
      />,
    );
    const searchInput = screen.getByPlaceholderText(
      i18n.t("server.logs.modal.search_placeholder"),
    );
    fireEvent.change(searchInput, { target: { value: "error" } });

    await waitFor(() => {
      const pre = screen.getByTestId("logs-pre");
      expect(pre.textContent).toContain("ERROR Failed to connect");
      expect(pre.textContent).not.toContain("INFO TrustTunnel started");
      expect(pre.textContent).not.toContain("WARN High memory");
    });
  });

  // ─── Test 4: case-insensitive search ─────────────────────────────────────

  it("case_insensitive_search — 'Error' matches same lines as 'error'", async () => {
    render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
        initialLogs={SAMPLE_LOGS}
        _forceState="loaded"
      />,
    );
    const searchInput = screen.getByPlaceholderText(
      i18n.t("server.logs.modal.search_placeholder"),
    );
    fireEvent.change(searchInput, { target: { value: "Error" } });

    await waitFor(() => {
      const pre = screen.getByTestId("logs-pre");
      expect(pre.textContent).toContain("ERROR Failed to connect");
      expect(pre.textContent).not.toContain("INFO TrustTunnel started");
    });
  });

  // ─── Test 5: refresh re-invokes server_get_logs ───────────────────────────

  it("refresh_re_invokes_server_get_logs — Refresh button triggers second invoke call", async () => {
    render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
        initialLogs={SAMPLE_LOGS}
        _forceState="loaded"
      />,
    );
    // Initial auto-load does NOT happen because _forceState suppresses it
    const refreshBtn = screen.getByText(i18n.t("server.logs.modal.refresh"));
    fireEvent.click(refreshBtn);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("server_get_logs", SSH_PARAMS);
    });
  });

  // ─── Test 6: copy writes full logs to clipboard ───────────────────────────

  it("copy_writes_full_logs_to_clipboard — clipboard.writeText called with full buffer", async () => {
    render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
        initialLogs={SAMPLE_LOGS}
        _forceState="loaded"
      />,
    );
    const copyBtn = screen.getByText(i18n.t("server.logs.modal.copy"));
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(SAMPLE_LOGS);
    });
  });

  // ─── Test 7: download calls save then write_string_to_path ───────────────

  it("download_calls_save_then_invoke_write_string_to_path", async () => {
    saveMock.mockResolvedValue("/tmp/trusttunnel-logs-logs-test_example_com-20260517-1200.txt");
    render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
        initialLogs={SAMPLE_LOGS}
        _forceState="loaded"
      />,
    );
    const downloadBtn = screen.getByText(i18n.t("server.logs.modal.download"));
    fireEvent.click(downloadBtn);

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: expect.stringMatching(/^trusttunnel-logs-/),
        }),
      );
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("write_string_to_path", {
        content: SAMPLE_LOGS,
        destination: "/tmp/trusttunnel-logs-logs-test_example_com-20260517-1200.txt",
      });
    });
  });

  // ─── Test 8: download cancelled — write NOT invoked ──────────────────────

  it("download_cancelled_does_not_invoke_write", async () => {
    saveMock.mockResolvedValue(null); // user cancelled native dialog
    render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
        initialLogs={SAMPLE_LOGS}
        _forceState="loaded"
      />,
    );
    const downloadBtn = screen.getByText(i18n.t("server.logs.modal.download"));
    fireEvent.click(downloadBtn);

    await waitFor(() => {
      expect(saveMock).toHaveBeenCalled();
    });
    // write_string_to_path should NOT have been called
    expect(invokeMock).not.toHaveBeenCalledWith("write_string_to_path", expect.anything());
  });

  // ─── Test 9: D-29 no password in activity log ────────────────────────────

  it("D-29_SECURITY_no_password_in_activity_log", async () => {
    render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
        initialLogs={SAMPLE_LOGS}
        _forceState="loaded"
      />,
    );
    // Trigger several actions
    const refreshBtn = screen.getByText(i18n.t("server.logs.modal.refresh"));
    fireEvent.click(refreshBtn);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalled();
    });

    // Verify password NEVER appears in any activityLog call
    expect(activityLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("testpass-LOGS-XYZ"),
    );
  });

  // ─── Test 10: D-29 no full logs content in activity log ──────────────────

  it("D-29_SECURITY_no_full_logs_content_in_activity_log", async () => {
    render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
        initialLogs={SAMPLE_LOGS}
        _forceState="loaded"
      />,
    );
    // Trigger refresh which logs metadata
    const refreshBtn = screen.getByText(i18n.t("server.logs.modal.refresh"));
    fireEvent.click(refreshBtn);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalled();
    });

    // Logs body content (specific log line) NEVER in activityLog — only metadata (lines=, host=)
    expect(activityLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("ERROR Failed to connect"),
    );
    expect(activityLogSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("INFO TrustTunnel started"),
    );
  });

  // ─── Test 11: T-03 no early-return null before Modal ─────────────────────

  it("T-03_SOURCE_early_return_null_absent — source must not contain if(!isOpen) return null pattern", () => {
    // Anti-pattern guard: T-03 — Modal lifecycle destroyed by early return null.
    // Strip comments before checking — JSDoc may legitimately reference the anti-pattern.
    const sourceWithoutComments = LogsViewerModalSource
      // Remove line comments (// ...)
      .replace(/\/\/[^\n]*/g, "")
      // Remove block comments (/* ... */)
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // Code (not comments) must NOT contain the anti-pattern
    expect(sourceWithoutComments).not.toMatch(/if\s*\(!isOpen\)\s+return\s+null/);
    expect(sourceWithoutComments).not.toMatch(/if\s*\(\s*!isOpen\s*\)\s*\{\s*return\s+null/);
    // Positive check: Modal IS always rendered (component renders <Modal isOpen={isOpen})
    expect(sourceWithoutComments).toMatch(/<Modal\s+isOpen=\{isOpen\}/);
  });

  // ─── Test 12: 30.1-05 — the search counter declines in Russian ────────────
  //
  // The reachable Russian grammar defect of phase 30.1. The milestone review's
  // item 5 named two OTHER keys (drop.configs_added,
  // server.security.summary.firewall_subtitle_active_rules) — both unreachable,
  // because all three of their call sites branch `i18n.language === "ru"` and
  // take pluralRu instead. This counter has NO such branch: it hands the raw
  // count straight to t(), so whatever the bundle says is what a Russian user
  // reads. Before the fix the key carried a single form and the screen said
  // «Найдено: 2 строк».
  //
  // Rendered through the component (not by calling t() directly) on purpose:
  // calling t() is exactly how the review reproduced a bug that the app cannot
  // reach, and this test must not repeat that mistake.

  /** N matching lines plus one that never matches, so the filter has to do work. */
  function logsWithMatches(n: number): string {
    const lines: string[] = ["May 17 09:59:59 INFO unrelated startup line"];
    for (let i = 0; i < n; i += 1) {
      lines.push(`May 17 10:00:00 INFO NEEDLE occurrence ${i}`);
    }
    return lines.join("\n");
  }

  async function counterTextFor(n: number): Promise<string> {
    const { unmount } = render(
      <LogsViewerModal
        isOpen={true}
        onClose={() => {}}
        sshParams={SSH_PARAMS}
        initialLogs={logsWithMatches(n)}
        _forceState="loaded"
      />,
    );
    fireEvent.change(
      screen.getByPlaceholderText(i18n.t("server.logs.modal.search_placeholder")),
      { target: { value: "NEEDLE" } },
    );
    const text = await waitFor(() => {
      const el = screen.getByTestId("logs-match-count");
      expect(el.textContent).toBeTruthy();
      return el.textContent as string;
    });
    unmount();
    return text;
  }

  it("match_count_declines_in_russian — counter reads correct Russian at 1/2/3/4/5/11/21/101", async () => {
    await i18n.changeLanguage("ru");
    // one → «строка», few (2-4) → «строки», many (5, 11) → «строк».
    // 21 and 101 end in 1 without being teens, so they take the «one» form —
    // they are here because a naive `count === 1` guard passes 1 and fails 21.
    const expected: Array<[number, string]> = [
      [1, "Найдено: 1 строка"],
      [2, "Найдено: 2 строки"],
      [3, "Найдено: 3 строки"],
      [4, "Найдено: 4 строки"],
      [5, "Найдено: 5 строк"],
      [11, "Найдено: 11 строк"],
      [21, "Найдено: 21 строка"],
      [101, "Найдено: 101 строка"],
    ];
    const actual: Array<[number, string]> = [];
    for (const [count] of expected) {
      actual.push([count, await counterTextFor(count)]);
    }
    expect(actual).toEqual(expected);
  });

  it("match_count_unchanged_in_english — counter still reads English under en", async () => {
    await i18n.changeLanguage("en");
    try {
      expect(await counterTextFor(1)).toBe("Found: 1 line");
      expect(await counterTextFor(3)).toBe("Found: 3 lines");
    } finally {
      await i18n.changeLanguage("ru");
    }
  });
});
