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
});
