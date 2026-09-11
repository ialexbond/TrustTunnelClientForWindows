import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { renderWithProviders as render } from "../../test/test-utils";
import { BenchmarkSection } from "./BenchmarkSection";
import type { BenchmarkRecord } from "./benchmark/history";

// ── Mock Tauri invoke (BenchmarkModal uses it) ──
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// ── Mock useActivityLog ──
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: vi.fn() }),
}));

const mockSshParams = {
  host: "192.168.1.100",
  port: 22,
  user: "admin",
  password: "secret",
  keyPath: undefined,
  keyData: undefined,
};

const LS_KEY = "tt_benchmark_192.168.1.100";

function makeRecord(ts: string): BenchmarkRecord {
  return {
    timestamp: ts,
    parsed_sections: { basic: { IP: "1.2.3.4" } },
    raw_stdout: "1. Basic Information\nIP: 1.2.3.4",
    duration_seconds: 42,
  };
}

describe("BenchmarkSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    i18n.changeLanguage("ru");
  });

  it("empty_state_shows_check_button", () => {
    render(<BenchmarkSection sshParams={mockSshParams} />);
    const btn = screen.getByRole("button", { name: /проверка ip сервера/i });
    expect(btn).toBeVisible();
  });

  it("has_history_shows_open_results_button", () => {
    const record = makeRecord("2026-05-18T14:30:00.000Z");
    localStorage.setItem(LS_KEY, JSON.stringify([record]));

    render(<BenchmarkSection sshParams={mockSshParams} />);

    // Button should say "Open results"
    const btn = screen.getByRole("button", { name: /открыть результаты/i });
    expect(btn).toBeVisible();

    // Subtitle should contain formatted time
    const subtitle = screen.getByText(/последняя проверка/i);
    expect(subtitle).toBeVisible();
    // Time formatted as DD.MM.YYYY HH:MM — e.g. "18.05.2026 17:30" (date-first, round-6)
    expect(subtitle.textContent).toMatch(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/);
  });

  it("click_button_opens_modal", async () => {
    const user = userEvent.setup();
    render(<BenchmarkSection sshParams={mockSshParams} />);

    const btn = screen.getByRole("button", { name: /проверка ip сервера/i });
    await user.click(btn);

    // Modal should appear — it renders the title as <h2> (09-38 rename).
    const modalTitle = screen.getByRole("heading", { level: 2, name: /проверка ip сервера/i });
    expect(modalTitle).toBeVisible();
  });

  it("card_has_testid", () => {
    render(<BenchmarkSection sshParams={mockSshParams} />);
    const card = screen.getByTestId("benchmark-section-card");
    expect(card).toBeInTheDocument();
  });

  // ─── Variant: empty state shows the "not yet run" subtitle ───────────────
  // RESEARCH §3 stream 4 — BenchmarkSection variants. The empty state was only
  // asserted via the button; pin its subtitle copy too (asserted by i18n text,
  // not CSS, per D-04).
  it("empty_state_shows_not_run_subtitle", () => {
    render(<BenchmarkSection sshParams={mockSshParams} />);

    expect(
      screen.getByText(i18n.t("server.service.benchmark.card.empty"))
    ).toBeVisible();
    // The card title is always present regardless of state.
    expect(
      screen.getByRole("heading", {
        name: i18n.t("server.service.benchmark.card.title"),
      })
    ).toBeVisible();
    // No "last run" subtitle leaks into the empty state.
    expect(screen.queryByText(/последняя проверка/i)).toBeNull();
  });

  // ─── Variant: modern single-object history format renders open-results ───
  // The pre-existing has-history test stores the OLD v17.x array format
  // (migration path). Pin the CURRENT single-object format too — loadLast must
  // accept it and the section must switch to the "Open results" affordance.
  it("modern_single_object_history_shows_open_results", () => {
    const record = makeRecord("2026-05-18T14:30:00.000Z");
    // Current saveLast format: a single object (NOT wrapped in an array).
    localStorage.setItem(LS_KEY, JSON.stringify(record));

    render(<BenchmarkSection sshParams={mockSshParams} />);

    expect(
      screen.getByRole("button", { name: /открыть результаты/i })
    ).toBeVisible();
    // The empty-state button must NOT be shown.
    expect(
      screen.queryByRole("button", { name: /проверка ip сервера/i })
    ).toBeNull();
    // Subtitle reflects the last-run timestamp.
    const subtitle = screen.getByText(/последняя проверка/i);
    expect(subtitle.textContent).toMatch(/\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/);
  });
});
