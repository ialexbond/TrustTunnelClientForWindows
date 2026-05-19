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
    const btn = screen.getByRole("button", { name: /check quality/i });
    expect(btn).toBeVisible();
  });

  it("has_history_shows_open_results_button", () => {
    const record = makeRecord("2026-05-18T14:30:00.000Z");
    localStorage.setItem(LS_KEY, JSON.stringify([record]));

    render(<BenchmarkSection sshParams={mockSshParams} />);

    // Button should say "Open results"
    const btn = screen.getByRole("button", { name: /open results/i });
    expect(btn).toBeVisible();

    // Subtitle should contain formatted time
    const subtitle = screen.getByText(/last check/i);
    expect(subtitle).toBeVisible();
    // Time formatted as HH:MM DD.MM.YYYY — e.g. "17:30 18.05.2026"
    expect(subtitle.textContent).toMatch(/\d{2}:\d{2} \d{2}\.\d{2}\.\d{4}/);
  });

  it("click_button_opens_modal", async () => {
    const user = userEvent.setup();
    render(<BenchmarkSection sshParams={mockSshParams} />);

    const btn = screen.getByRole("button", { name: /check quality/i });
    await user.click(btn);

    // Modal should appear — it renders the title as <h2>
    const modalTitle = screen.getByRole("heading", { level: 2, name: /server quality check/i });
    expect(modalTitle).toBeVisible();
  });

  it("card_has_testid", () => {
    render(<BenchmarkSection sshParams={mockSshParams} />);
    const card = screen.getByTestId("benchmark-section-card");
    expect(card).toBeInTheDocument();
  });
});
