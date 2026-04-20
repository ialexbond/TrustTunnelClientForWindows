import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { LogsSection } from "./LogsSection";
import type { ServerState } from "./useServerState";

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

describe("LogsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders logs title", () => {
    const state = makeState();
    render(<LogsSection state={state} />);
    expect(screen.getByText(i18n.t("server.logs.title"))).toBeInTheDocument();
  });

  it("shows load logs button when logs are not shown", () => {
    const state = makeState();
    render(<LogsSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.logs.load")) })).toBeInTheDocument();
  });

  it("shows refresh button when logs are already shown", () => {
    const state = makeState({ showLogs: true, serverLogs: "some log data" });
    render(<LogsSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.logs.refresh")) })).toBeInTheDocument();
  });

  it("shows copy and collapse buttons when logs are visible", () => {
    const state = makeState({ showLogs: true, serverLogs: "log line 1\nlog line 2" });
    render(<LogsSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.logs.copy")) })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.logs.collapse")) })).toBeInTheDocument();
  });

  it("does not show copy/collapse when logs are hidden", () => {
    const state = makeState();
    render(<LogsSection state={state} />);
    expect(screen.queryByRole("button", { name: new RegExp(i18n.t("server.logs.copy")) })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: new RegExp(i18n.t("server.logs.collapse")) })).not.toBeInTheDocument();
  });

  it("displays log content when showLogs is true", () => {
    const state = makeState({ showLogs: true, serverLogs: "2024-01-01 INFO started" });
    render(<LogsSection state={state} />);
    expect(screen.getByText("2024-01-01 INFO started")).toBeInTheDocument();
  });

  it("shows spinner when logsLoading is true", () => {
    const state = makeState({ showLogs: true, logsLoading: true });
    const { container } = render(<LogsSection state={state} />);
    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("shows no data text when showLogs is true but no logs", () => {
    const state = makeState({ showLogs: true, serverLogs: "" });
    render(<LogsSection state={state} />);
    expect(screen.getByText(i18n.t("server.logs.no_data"))).toBeInTheDocument();
  });

  it("colorizes error lines in red", () => {
    const state = makeState({ showLogs: true, serverLogs: "ERROR something failed" });
    render(<LogsSection state={state} />);
    const span = screen.getByText(/ERROR something failed/);
    expect(span.style.color).toBe("var(--color-danger-500)");
  });

  it("colorizes warning lines in yellow", () => {
    const state = makeState({ showLogs: true, serverLogs: "WARN low memory" });
    render(<LogsSection state={state} />);
    const span = screen.getByText(/WARN low memory/);
    expect(span.style.color).toBe("var(--color-warning-500)");
  });

  it("colorizes normal lines with muted color", () => {
    const state = makeState({ showLogs: true, serverLogs: "INFO startup complete" });
    render(<LogsSection state={state} />);
    const span = screen.getByText(/INFO startup complete/);
    expect(span.style.color).toBe("var(--color-text-muted)");
  });

  it("colorizes fatal lines in red", () => {
    const state = makeState({ showLogs: true, serverLogs: "FATAL crash" });
    render(<LogsSection state={state} />);
    const span = screen.getByText(/FATAL crash/);
    expect(span.style.color).toBe("var(--color-danger-500)");
  });

  it("colorizes panic lines in red", () => {
    const state = makeState({ showLogs: true, serverLogs: "panic: runtime error" });
    render(<LogsSection state={state} />);
    const span = screen.getByText(/panic: runtime error/);
    expect(span.style.color).toBe("var(--color-danger-500)");
  });

  it("calls setShowLogs and setLogsLoading when load button is clicked", () => {
    const state = makeState();
    render(<LogsSection state={state} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.logs.load")) }));
    expect(state.setShowLogs).toHaveBeenCalledWith(true);
    expect(state.setLogsLoading).toHaveBeenCalledWith(true);
  });

  it("calls pushSuccess when copy button is clicked", () => {
    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    const state = makeState({ showLogs: true, serverLogs: "some log data" });
    render(<LogsSection state={state} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.logs.copy")) }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("some log data");
    expect(state.pushSuccess).toHaveBeenCalled();
  });

  it("calls setShowLogs(false) and setServerLogs('') when collapse is clicked", () => {
    const state = makeState({ showLogs: true, serverLogs: "some log data" });
    render(<LogsSection state={state} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.logs.collapse")) }));
    expect(state.setShowLogs).toHaveBeenCalledWith(false);
    expect(state.setServerLogs).toHaveBeenCalledWith("");
  });

  it("splits multiline logs into separate spans", () => {
    const state = makeState({
      showLogs: true,
      serverLogs: "line1\nERROR line2\nWARN line3",
    });
    const { container } = render(<LogsSection state={state} />);
    const spans = container.querySelectorAll("pre span");
    expect(spans.length).toBe(3);
  });

  it("shows refresh label instead of load when logs are already shown", () => {
    const state = makeState({ showLogs: true, serverLogs: "some data" });
    render(<LogsSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.logs.refresh")) })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: new RegExp(i18n.t("server.logs.load")) })).not.toBeInTheDocument();
  });

  it("does not show copy button when showLogs true but serverLogs empty, but collapse is visible", () => {
    const state = makeState({ showLogs: true, serverLogs: "" });
    render(<LogsSection state={state} />);
    expect(screen.queryByRole("button", { name: new RegExp(i18n.t("server.logs.copy")) })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.logs.collapse")) })).toBeInTheDocument();
  });
});
