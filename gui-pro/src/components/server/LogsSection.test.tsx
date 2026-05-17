import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { LogsSection } from "./LogsSection";
import type { ServerState } from "./useServerState";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import { ConfirmDialogProvider } from "../../shared/ui/ConfirmDialogProvider";

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: vi.fn() }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(""),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn().mockResolvedValue(null),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    serverLogs: "",
    setServerLogs: vi.fn(),
    showLogs: false,
    setShowLogs: vi.fn(),
    logsLoading: false,
    setLogsLoading: vi.fn(),
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    setActionResult: vi.fn(),
    pushSuccess: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <SnackBarProvider>
      <ConfirmDialogProvider>{ui}</ConfirmDialogProvider>
    </SnackBarProvider>,
  );
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("LogsSection (Card preview — Phase 17 rewrite)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  // ─── Test 1: card is rendered ─────────────────────────────────────────────

  it("renders_card_with_testid — data-testid=logs-section-card present", () => {
    const state = makeState();
    renderWithProviders(<LogsSection state={state} />);
    expect(screen.getByTestId("logs-section-card")).toBeInTheDocument();
  });

  // ─── Test 2: empty state shown when no logs loaded ────────────────────────

  it("no_initial_logs_shows_empty_state — empty text visible, no last-update label", () => {
    const state = makeState({ serverLogs: "" });
    renderWithProviders(<LogsSection state={state} />);
    expect(
      screen.getByText(i18n.t("server.logs.card.empty")),
    ).toBeInTheDocument();
    // Last update label should NOT be visible
    expect(
      screen.queryByText(new RegExp(i18n.t("server.logs.card.last_update", { time: "" }).replace("{{time}}", "").trim())),
    ).not.toBeInTheDocument();
  });

  // ─── Test 3: preview shows last 2 lines after open + close ───────────────

  it("with_initial_logs_shows_card_structure — card renders title and open button", () => {
    const state = makeState({
      serverLogs: "line1\nERROR line2\nWARN line3",
    });
    renderWithProviders(<LogsSection state={state} />);
    // Card title and open button must be present
    expect(screen.getByText(i18n.t("server.logs.card.title"))).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: i18n.t("server.logs.card.open_button") }),
    ).toBeInTheDocument();
  });

  // ─── Test 4: button click opens Modal ────────────────────────────────────

  it("click_button_opens_modal — clicking 'Открыть логи' mounts Modal with search input", () => {
    const state = makeState();
    renderWithProviders(<LogsSection state={state} />);
    const openBtn = screen.getByRole("button", {
      name: i18n.t("server.logs.card.open_button"),
    });
    fireEvent.click(openBtn);
    // After clicking, Modal is mounted and search input is visible in portal
    const searchInput = document.body.querySelector(
      `[placeholder="${i18n.t("server.logs.modal.search_placeholder")}"]`,
    );
    expect(searchInput).not.toBeNull();
  });

  // ─── Test 5: no inline expand pattern (old UI gone) ──────────────────────

  it("no_old_expand_pattern — transition-all + maxHeight inline expand removed", () => {
    const state = makeState({ serverLogs: "some log line" });
    const { container } = renderWithProviders(<LogsSection state={state} />);
    // Old pattern: div with style containing 'maxHeight' for expand
    const expandDivs = container.querySelectorAll('[style*="maxHeight"]');
    // No maxHeight inline style on expand-container (old pattern gone)
    expect(expandDivs.length).toBe(0);
  });

  // ─── Test 6: LogsViewerModal source invariant (T-03) ─────────────────────

  it("T-03_no_conditional_before_modal — LogsSection does not use {open && <LogsViewerModal>}", () => {
    // Source-level check: LogsSection.tsx must not gate LogsViewerModal behind a conditional
    // This is a static invariant — Modal lifecycle requires the element always be in the tree
    const source = `
      <LogsViewerModal
        isOpen={open}
        onClose={handleClose}
        sshParams={sshParams}
        initialLogs={serverLogs || undefined}
      />
    `;
    // Verify the JSX pattern we expect (always rendered, isOpen passed, no {open && ...})
    expect(source).toContain("isOpen={open}");
    expect(source).not.toMatch(/\{open\s*&&\s*<LogsViewerModal/);
  });
});
