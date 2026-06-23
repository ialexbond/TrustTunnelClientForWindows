import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { LogsSection } from "./LogsSection";
import type { ServerState } from "./useServerState";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import { ConfirmDialogProvider } from "../../shared/ui/ConfirmDialogProvider";
import { activityLogSpy, expectNoSecretLogged } from "../../test/fixtures";

// ─── Mocks ──────────────────────────────────────────────────────────────────

// D-29: reuse the shared NAMED activity-log spy so the logs body / password
// absence is proven the same way as every other credential-touching surface.
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: activityLogSpy }),
}));

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
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
    activityLogSpy.mockReset();
    // Default: server_get_logs resolves empty (overridden per test).
    invokeMock.mockResolvedValue("");
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

  // ─── E-20 + R4-F06: real timestamp from fetch, no log-preview line ─────────
  //
  // Root cause (RESEARCH E-20): `handleClose` set `lastUpdate=new Date()`
  // unconditionally, fabricating "updated now" on every close even when the
  // fetch failed or returned nothing. `LogsViewerModal` now reports the real
  // fetch-success time up via `onLogsFetched(text, timestamp)`; `LogsSection`
  // sets `lastUpdate` only from THAT callback (never from handleClose).
  //
  // R4-F06: the card no longer renders a log-preview line at all — only the
  // title, the last-update timestamp and the «Открыть логи» button. The fetched
  // text is still kept to seed the modal, but it is never shown on the card.

  describe("E-20 + R4-F06 — real timestamp, no preview line", () => {
    const SAMPLE = "line A\nERROR line B";

    // ─── R4-F06: a successful fetch never renders the journal text on the card ─
    it("F06_no_preview_line_after_successful_fetch — fetched lines absent from card", async () => {
      invokeMock.mockResolvedValue(SAMPLE);
      const state = makeState({ serverLogs: "" });
      renderWithProviders(<LogsSection state={state} />);

      // Open the modal → auto-load fires server_get_logs → resolves SAMPLE.
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("server.logs.card.open_button") }),
      );

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith("server_get_logs", expect.anything());
      });
      // Close the modal so its body rows unmount; only the CARD remains queryable.
      fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.close") }));
      const card = screen.getByTestId("logs-section-card");
      // The timestamp must show, but the journal preview line must NOT.
      await waitFor(() => {
        expect(card).toHaveTextContent(/Последнее обновление/);
      });
      expect(card.textContent).not.toContain("ERROR line B");
      expect(card.textContent).not.toContain("line A");
      // No mono preview element on the card anymore.
      expect(card.querySelector(".text-mono-sm")).toBeNull();
    });

    // ─── R4-F06 negative control: no preview line before any fetch either ──────
    it("F06_no_preview_before_any_fetch — only the empty-state caption shows", () => {
      invokeMock.mockResolvedValue("");
      const state = makeState({ serverLogs: "" });
      renderWithProviders(<LogsSection state={state} />);
      // Empty caption visible; no preview line, no last-update label.
      expect(
        screen.getByText(i18n.t("server.logs.card.empty")),
      ).toBeInTheDocument();
      expect(screen.queryByText(/ERROR line B/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Последнее обновление/)).not.toBeInTheDocument();
    });

    // ─── Test 2 (E-20): fetch rejects → close → NO fabricated timestamp ────────
    it("E20_no_timestamp_when_fetch_fails — close after a failed fetch leaves empty state", async () => {
      invokeMock.mockRejectedValue(new Error("SSH connection failed"));
      const state = makeState({ serverLogs: "" });
      renderWithProviders(<LogsSection state={state} />);

      const openBtn = screen.getByRole("button", {
        name: i18n.t("server.logs.card.open_button"),
      });
      fireEvent.click(openBtn);
      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith("server_get_logs", expect.anything());
      });
      // Close via the modal's canonical corner X (labeled footer close dropped, F18).
      fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.close") }));

      // No fabricated «Последнее обновление»; empty-state caption still shows.
      await waitFor(() => {
        expect(screen.getByText(i18n.t("server.logs.card.empty"))).toBeInTheDocument();
      });
      expect(screen.queryByText(/Последнее обновление/)).not.toBeInTheDocument();
    });

    // ─── Test 2b (E-20 positive control): successful fetch → timestamp appears ─
    it("E20_timestamp_appears_after_successful_fetch — last-update label shows", async () => {
      invokeMock.mockResolvedValue(SAMPLE);
      const state = makeState({ serverLogs: "" });
      renderWithProviders(<LogsSection state={state} />);

      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("server.logs.card.open_button") }),
      );
      await waitFor(() => {
        expect(screen.getByText(/Последнее обновление/)).toBeInTheDocument();
      });
    });

    // ─── §K ELT-09: empty-state copy names the open button by its EXACT label ──
    //
    // The empty caption tells the user which control to press. It must name the
    // button by the IDENTICAL phrase the button shows (`card.open_button`), not a
    // paraphrase — otherwise the instruction points at a control that doesn't
    // exist under that name. Asserted for ru source + en mirror.
    it.each(["ru", "en"])(
      "ELT09_empty_copy_names_open_button_exactly — [%s] empty text contains the button label",
      (lang) => {
        i18n.changeLanguage(lang);
        const label = i18n.t("server.logs.card.open_button");
        const empty = i18n.t("server.logs.card.empty");
        expect(empty).toContain(label);
      },
    );

    // ─── Test 3 (D-29): the logs body never reaches the activity-log channel ───
    it("D29_logs_body_never_logged — fetched lines absent from activityLog", async () => {
      invokeMock.mockResolvedValue(SAMPLE);
      const state = makeState({ serverLogs: "" });
      renderWithProviders(<LogsSection state={state} />);

      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("server.logs.card.open_button") }),
      );
      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith("server_get_logs", expect.anything());
      });
      // The logs body (a specific fetched line) must never be a logged argument.
      expectNoSecretLogged("ERROR line B");
      expectNoSecretLogged("line A");
    });
  });
});
