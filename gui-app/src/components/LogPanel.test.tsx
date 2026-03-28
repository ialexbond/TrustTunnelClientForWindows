import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../shared/i18n";
import LogPanel from "./LogPanel";
import type { LogEntry } from "../shared/types";

describe("LogPanel", () => {
  const sampleLogs: LogEntry[] = [
    { timestamp: "12:00:01", level: "info", message: "Connected to server" },
    { timestamp: "12:00:02", level: "error", message: "Authentication failed" },
    { timestamp: "12:00:03", level: "warn", message: "High latency detected" },
    { timestamp: "12:00:04", level: "debug", message: "Sending keepalive" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders log panel title", () => {
    render(<LogPanel logs={[]} onClear={vi.fn()} />);
    expect(screen.getByText(i18n.t("sections.logs"))).toBeInTheDocument();
  });

  it("renders empty state when no logs", () => {
    render(<LogPanel logs={[]} onClear={vi.fn()} isConnected={false} />);
    expect(screen.getByText(i18n.t("logs_panel.logs_appear_on_connect"))).toBeInTheDocument();
  });

  it("renders connected empty state", () => {
    render(<LogPanel logs={[]} onClear={vi.fn()} isConnected={true} />);
    expect(screen.getByText(i18n.t("logs_panel.no_logs_yet"))).toBeInTheDocument();
  });

  it("renders log entries", () => {
    render(<LogPanel logs={sampleLogs} onClear={vi.fn()} />);
    expect(screen.getByText("Connected to server")).toBeInTheDocument();
    expect(screen.getByText("Authentication failed")).toBeInTheDocument();
    expect(screen.getByText("High latency detected")).toBeInTheDocument();
    expect(screen.getByText("Sending keepalive")).toBeInTheDocument();
  });

  it("renders timestamps for each log entry", () => {
    render(<LogPanel logs={sampleLogs} onClear={vi.fn()} />);
    expect(screen.getByText("12:00:01")).toBeInTheDocument();
    expect(screen.getByText("12:00:02")).toBeInTheDocument();
  });

  it("renders log levels in uppercase", () => {
    render(<LogPanel logs={sampleLogs} onClear={vi.fn()} />);
    expect(screen.getByText("INFO")).toBeInTheDocument();
    expect(screen.getByText("ERROR")).toBeInTheDocument();
    expect(screen.getByText("WARN")).toBeInTheDocument();
    expect(screen.getByText("DEBUG")).toBeInTheDocument();
  });

  it("calls onClear when clear button is clicked", () => {
    const onClear = vi.fn();
    render(<LogPanel logs={sampleLogs} onClear={onClear} />);
    fireEvent.click(screen.getByText(i18n.t("buttons.clear_logs")));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("disables clear button when no logs", () => {
    render(<LogPanel logs={[]} onClear={vi.fn()} />);
    const clearBtn = screen.getByText(i18n.t("buttons.clear_logs")).closest("button")!;
    expect(clearBtn).toBeDisabled();
  });

  it("shows log count badge", () => {
    render(<LogPanel logs={sampleLogs} onClear={vi.fn()} />);
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("filters logs by search query", () => {
    render(<LogPanel logs={sampleLogs} onClear={vi.fn()} />);
    const searchInput = screen.getByPlaceholderText(i18n.t("logs_panel.search_placeholder"));
    fireEvent.change(searchInput, { target: { value: "Authentication" } });
    expect(screen.getByText("Authentication failed")).toBeInTheDocument();
    expect(screen.queryByText("Connected to server")).not.toBeInTheDocument();
    // Badge should show filtered count
    expect(screen.getByText("1/4")).toBeInTheDocument();
  });

  it("renders level filter select with default 'all' option", () => {
    render(<LogPanel logs={sampleLogs} onClear={vi.fn()} />);
    // The custom Select shows "Все" (All) as the default selected label
    expect(screen.getByText(i18n.t("logs_panel.filter_all"))).toBeInTheDocument();
  });

  it("opens level filter dropdown and shows level options", () => {
    render(<LogPanel logs={sampleLogs} onClear={vi.fn()} />);
    const selectTrigger = screen.getByText(i18n.t("logs_panel.filter_all"));
    fireEvent.click(selectTrigger);
    // Dropdown should show level options (ERROR appears both in logs and dropdown)
    // TRACE only appears in dropdown options, not in sample logs
    expect(screen.getByText("TRACE")).toBeInTheDocument();
  });

  it("shows no-matching message when filter yields no results", () => {
    render(<LogPanel logs={sampleLogs} onClear={vi.fn()} />);
    const searchInput = screen.getByPlaceholderText(i18n.t("logs_panel.search_placeholder"));
    fireEvent.change(searchInput, { target: { value: "zzz_no_match_zzz" } });
    expect(screen.getByText(i18n.t("logs_panel.no_matching"))).toBeInTheDocument();
  });
});
