import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { DiagnosticsSection } from "./DiagnosticsSection";
import type { ServerState } from "./useServerState";

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    diagResult: null,
    setDiagResult: vi.fn(),
    showDiag: false,
    setShowDiag: vi.fn(),
    diagLoading: false,
    setDiagLoading: vi.fn(),
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    ...overrides,
  } as unknown as ServerState;
}

describe("DiagnosticsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders diagnostics title", () => {
    const state = makeState();
    render(<DiagnosticsSection state={state} />);
    expect(screen.getByText(i18n.t("server.diagnostics.title"))).toBeInTheDocument();
  });

  it("shows run diagnostics button", () => {
    const state = makeState();
    render(<DiagnosticsSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.diagnostics.run")) })).toBeInTheDocument();
  });

  it("shows rerun button when diagnostics result exists", () => {
    const state = makeState({ showDiag: true, diagResult: "All OK" });
    render(<DiagnosticsSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.diagnostics.rerun")) })).toBeInTheDocument();
  });

  it("shows collapse button when diagnostics result is visible", () => {
    const state = makeState({ showDiag: true, diagResult: "All OK" });
    render(<DiagnosticsSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.diagnostics.collapse")) })).toBeInTheDocument();
  });

  it("does not show collapse button when no diagnostics result", () => {
    const state = makeState();
    render(<DiagnosticsSection state={state} />);
    expect(screen.queryByRole("button", { name: new RegExp(i18n.t("server.diagnostics.collapse")) })).not.toBeInTheDocument();
  });

  it("displays diagnostics result text", () => {
    const state = makeState({ showDiag: true, diagResult: "Port 443: OPEN\nDNS: OK" });
    render(<DiagnosticsSection state={state} />);
    expect(screen.getByText(/Port 443: OPEN/)).toBeInTheDocument();
    expect(screen.getByText(/DNS: OK/)).toBeInTheDocument();
  });

  it("shows loading spinner when diagLoading is true", () => {
    const state = makeState({ showDiag: true, diagLoading: true });
    render(<DiagnosticsSection state={state} />);
    expect(screen.getByText(i18n.t("server.diagnostics.running"))).toBeInTheDocument();
  });

  it("shows no data text when showDiag is true but no result", () => {
    const state = makeState({ showDiag: true, diagResult: null });
    render(<DiagnosticsSection state={state} />);
    expect(screen.getByText(i18n.t("server.diagnostics.no_data"))).toBeInTheDocument();
  });

  it("clicking run diagnostics calls setShowDiag, setDiagLoading, setDiagResult and invoke", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("All systems OK");
    const state = makeState();
    render(<DiagnosticsSection state={state} />);
    const runBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.diagnostics.run")) });
    fireEvent.click(runBtn);
    expect(state.setShowDiag).toHaveBeenCalledWith(true);
    expect(state.setDiagLoading).toHaveBeenCalledWith(true);
    expect(state.setDiagResult).toHaveBeenCalledWith(null);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("diagnose_server", state.sshParams);
    });
    await waitFor(() => {
      expect(state.setDiagResult).toHaveBeenCalledWith("All systems OK");
    });
    expect(state.setDiagLoading).toHaveBeenCalledWith(false);
  });

  it("clicking run diagnostics handles invoke error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("connection lost"));
    const state = makeState();
    render(<DiagnosticsSection state={state} />);
    const runBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.diagnostics.run")) });
    fireEvent.click(runBtn);
    await waitFor(() => {
      expect(state.setDiagResult).toHaveBeenCalledWith(
        i18n.t("server.diagnostics.error", { error: "connection lost" })
      );
    });
    expect(state.setDiagLoading).toHaveBeenCalledWith(false);
  });

  it("clicking collapse calls setShowDiag(false) and setDiagResult(null)", () => {
    const state = makeState({ showDiag: true, diagResult: "data here" });
    render(<DiagnosticsSection state={state} />);
    const collapseBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.diagnostics.collapse")) });
    fireEvent.click(collapseBtn);
    expect(state.setShowDiag).toHaveBeenCalledWith(false);
    expect(state.setDiagResult).toHaveBeenCalledWith(null);
  });

  it("output area is collapsed (maxHeight 0) when showDiag is false", () => {
    const state = makeState({ showDiag: false });
    const { container } = render(<DiagnosticsSection state={state} />);
    const collapsible = container.querySelector("div[class*='overflow-hidden']") as HTMLElement;
    expect(collapsible.style.maxHeight).toBe("0px");
    expect(collapsible.style.opacity).toBe("0");
  });

  it("output area is expanded when showDiag is true", () => {
    const state = makeState({ showDiag: true, diagResult: "test" });
    const { container } = render(<DiagnosticsSection state={state} />);
    const collapsible = container.querySelector("div[class*='overflow-hidden']") as HTMLElement;
    expect(collapsible.style.maxHeight).toBe("240px");
    expect(collapsible.style.opacity).toBe("1");
  });

  it("shows run button text, not rerun, when no result yet", () => {
    const state = makeState({ showDiag: false, diagResult: null });
    render(<DiagnosticsSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.diagnostics.run")) })).toBeInTheDocument();
  });

  it("loading spinner appears inside pre element when diagLoading is true", () => {
    const state = makeState({ showDiag: true, diagLoading: true });
    const { container } = render(<DiagnosticsSection state={state} />);
    const spinner = container.querySelector("svg.animate-spin");
    expect(spinner).toBeInTheDocument();
  });

  it("diagnostics result text renders inside pre element", () => {
    const state = makeState({ showDiag: true, diagResult: "WireGuard: active\nPing: OK" });
    const { container } = render(<DiagnosticsSection state={state} />);
    const pre = container.querySelector("pre");
    expect(pre).toBeInTheDocument();
    expect(pre!.textContent).toContain("WireGuard: active");
    expect(pre!.textContent).toContain("Ping: OK");
  });
});
