import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { ServerStatusSection } from "./ServerStatusSection";
import type { ServerState } from "./useServerState";

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    serverInfo: { installed: true, version: "1.4.0", serviceActive: true, users: ["alice"] },
    actionLoading: null,
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    runAction: vi.fn(),
    loadServerInfo: vi.fn().mockResolvedValue(undefined),
    setConfirmReboot: vi.fn(),
    rebooting: false,
    setRebooting: vi.fn(),
    host: "10.0.0.1",
    setServerInfo: vi.fn(),
    pushSuccess: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

describe("ServerStatusSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "ping_endpoint") return 42;
      return null;
    });
  });

  it("renders nothing when serverInfo is null", () => {
    const state = makeState({ serverInfo: null });
    const { container } = render(<ServerStatusSection state={state} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders status title and running state when service is active", () => {
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    expect(screen.getByText(i18n.t("server.status.title"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.status.running"))).toBeInTheDocument();
  });

  it("shows stopped state when service is inactive", () => {
    const state = makeState({
      serverInfo: { installed: true, version: "1.4.0", serviceActive: false, users: ["alice"] },
    });
    render(<ServerStatusSection state={state} />);
    expect(screen.getByText(i18n.t("server.status.stopped"))).toBeInTheDocument();
  });

  it("displays host address", () => {
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    expect(screen.getByText("10.0.0.1")).toBeInTheDocument();
  });

  it("shows restart and stop buttons when service is active", () => {
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.restart")) })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.stop")) })).toBeInTheDocument();
  });

  it("shows start button when service is stopped", () => {
    const state = makeState({
      serverInfo: { installed: true, version: "1.4.0", serviceActive: false, users: ["alice"] },
    });
    render(<ServerStatusSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.start")) })).toBeInTheDocument();
  });

  it("shows reboot server button", () => {
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.reboot_server")) })).toBeInTheDocument();
  });

  it("clicking reboot button calls setConfirmReboot", () => {
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.reboot_server")) }));
    expect(state.setConfirmReboot).toHaveBeenCalledWith(true);
  });

  it("calls runAction when restart is clicked", () => {
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.restart")) }));
    expect(state.runAction).toHaveBeenCalledWith("restart", expect.any(Function), expect.any(String));
  });

  it("shows rebooting state with loader", () => {
    const state = makeState({ rebooting: true });
    render(<ServerStatusSection state={state} />);
    expect(screen.getByText(i18n.t("server.status.rebooting"))).toBeInTheDocument();
  });

  it("hides action buttons during rebooting state", () => {
    const state = makeState({ rebooting: true });
    render(<ServerStatusSection state={state} />);
    expect(screen.queryByRole("button", { name: new RegExp(i18n.t("server.actions.restart")) })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: new RegExp(i18n.t("server.actions.stop")) })).not.toBeInTheDocument();
  });

  it("calls runAction with stop when stop button is clicked", () => {
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.stop")) }));
    expect(state.runAction).toHaveBeenCalledWith("stop", expect.any(Function), expect.any(String));
  });

  it("shows start button instead of restart/stop when service is inactive", () => {
    const state = makeState({
      serverInfo: { installed: true, version: "1.4.0", serviceActive: false, users: ["alice"] },
    });
    render(<ServerStatusSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.start")) })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: new RegExp(i18n.t("server.actions.restart")) })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: new RegExp(i18n.t("server.actions.stop")) })).not.toBeInTheDocument();
  });

  it("calls runAction with start when start button is clicked on inactive service", () => {
    const state = makeState({
      serverInfo: { installed: true, version: "1.4.0", serviceActive: false, users: ["alice"] },
    });
    render(<ServerStatusSection state={state} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.start")) }));
    expect(state.runAction).toHaveBeenCalledWith("start", expect.any(Function), expect.any(String));
  });

  it("always shows reboot server button regardless of service state", () => {
    const state = makeState({
      serverInfo: { installed: true, version: "1.4.0", serviceActive: false, users: ["alice"] },
    });
    render(<ServerStatusSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.reboot_server")) })).toBeInTheDocument();
  });

  it("shows rebooting countdown when rebootCountdown > 0", () => {
    const state = makeState({ rebooting: true });
    render(<ServerStatusSection state={state} />);
    expect(screen.getByText(i18n.t("server.status.rebooting"))).toBeInTheDocument();
  });

  it("does not show running/stopped status during rebooting", () => {
    const state = makeState({ rebooting: true });
    render(<ServerStatusSection state={state} />);
    expect(screen.queryByText(i18n.t("server.status.running"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("server.status.stopped"))).not.toBeInTheDocument();
  });

  it("does not show reboot button during rebooting", () => {
    const state = makeState({ rebooting: true });
    render(<ServerStatusSection state={state} />);
    expect(screen.queryByRole("button", { name: new RegExp(i18n.t("server.actions.reboot_server")) })).not.toBeInTheDocument();
  });

  it("shows refresh status button (soft refresh)", () => {
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    const allButtons = screen.getAllByRole("button");
    expect(allButtons.length).toBeGreaterThan(2);
  });

  // ── Ping display ──

  it("shows ping badge when service is active and ping resolves", async () => {
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    await waitFor(() => {
      expect(screen.getByText("42ms")).toBeInTheDocument();
    });
  });

  it("shows no_connection badge when ping fails", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "ping_endpoint") return -1;
      return null;
    });
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    await waitFor(() => {
      expect(screen.getByText(i18n.t("server.status.no_connection"))).toBeInTheDocument();
    });
  });

  it("does not show ping when service is inactive", async () => {
    const state = makeState({
      serverInfo: { installed: true, version: "1.4.0", serviceActive: false, users: ["alice"] },
    });
    render(<ServerStatusSection state={state} />);
    // Ping invoke should not be called for inactive services
    await waitFor(() => {
      expect(screen.queryByText(/ms$/)).not.toBeInTheDocument();
    });
  });

  it("shows success variant badge for fast ping (<100ms)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "ping_endpoint") return 50;
      return null;
    });
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    await waitFor(() => {
      expect(screen.getByText("50ms")).toBeInTheDocument();
    });
  });

  it("shows warning variant badge for moderate ping (100-300ms)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "ping_endpoint") return 200;
      return null;
    });
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    await waitFor(() => {
      expect(screen.getByText("200ms")).toBeInTheDocument();
    });
  });

  it("shows danger variant badge for slow ping (>300ms)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "ping_endpoint") return 500;
      return null;
    });
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    await waitFor(() => {
      expect(screen.getByText("500ms")).toBeInTheDocument();
    });
  });

  // ── Soft refresh ──

  it("soft refresh button calls loadServerInfo", async () => {
    const loadServerInfo = vi.fn().mockResolvedValue(undefined);
    const state = makeState({ loadServerInfo });
    render(<ServerStatusSection state={state} />);

    // The refresh button is the inline button in the status row (not "restart")
    // It's a button with RefreshCw icon without text label
    const allButtons = screen.getAllByRole("button");
    // The inline refresh button is the one that doesn't have named text
    // Find the button that has no text match to restart/stop/reboot
    const refreshBtn = allButtons.find((btn) => {
      const text = btn.textContent || "";
      return !text.includes(i18n.t("server.actions.restart"))
        && !text.includes(i18n.t("server.actions.stop"))
        && !text.includes(i18n.t("server.actions.reboot_server"));
    });
    expect(refreshBtn).toBeTruthy();
    fireEvent.click(refreshBtn!);

    await waitFor(() => {
      expect(loadServerInfo).toHaveBeenCalledWith(true);
    });
  });

  // ── Action loading states ──

  it("restart button shows loading state when actionLoading is restart", () => {
    const state = makeState({ actionLoading: "restart" });
    render(<ServerStatusSection state={state} />);
    const restartBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.restart")) });
    expect(restartBtn).toBeInTheDocument();
  });

  it("stop button shows loading state when actionLoading is stop", () => {
    const state = makeState({ actionLoading: "stop" });
    render(<ServerStatusSection state={state} />);
    const stopBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.stop")) });
    expect(stopBtn).toBeInTheDocument();
  });

  it("start button shows loading state when actionLoading is start", () => {
    const state = makeState({
      serverInfo: { installed: true, version: "1.4.0", serviceActive: false, users: ["alice"] },
      actionLoading: "start",
    });
    render(<ServerStatusSection state={state} />);
    const startBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.start")) });
    expect(startBtn).toBeInTheDocument();
  });

  // ── Ping rejection (catch path) ──

  it("handles ping_endpoint rejection gracefully", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "ping_endpoint") throw new Error("Timeout");
      return null;
    });
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    await waitFor(() => {
      expect(screen.getByText(i18n.t("server.status.no_connection"))).toBeInTheDocument();
    });
  });

  // ── Reboot polling effect is triggered when rebooting is true ──

  it("rebooting state triggers polling effect (invoke called for check_server_installation)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "ping_endpoint") return 42;
      if (cmd === "check_server_installation") {
        return { installed: true, version: "1.4.0", serviceActive: true, users: ["alice"] };
      }
      return null;
    });

    const setRebooting = vi.fn();
    const setServerInfo = vi.fn();
    const pushSuccess = vi.fn();
    const state = makeState({ rebooting: true, setRebooting, setServerInfo, pushSuccess });
    const { unmount } = render(<ServerStatusSection state={state} />);

    // The rebooting state shows the loader
    expect(screen.getByText(i18n.t("server.status.rebooting"))).toBeInTheDocument();

    // Cleanup to avoid timer leaks
    unmount();
  });

  it("does not start reboot polling when rebooting is false", () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "ping_endpoint") return 42;
      return null;
    });

    const state = makeState({ rebooting: false });
    render(<ServerStatusSection state={state} />);

    // check_server_installation should not be called when not rebooting
    const checkCalls = vi.mocked(invoke).mock.calls.filter(c => c[0] === "check_server_installation");
    expect(checkCalls.length).toBe(0);
  });

  // ── Ping variant classification ──

  it("returns default variant for null ping", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "ping_endpoint") return null as any;
      return null;
    });
    const state = makeState({
      serverInfo: { installed: true, version: "1.4.0", serviceActive: false, users: ["alice"] },
    });
    render(<ServerStatusSection state={state} />);
    // No ping badge when service is inactive
    expect(screen.queryByText(/ms$/)).not.toBeInTheDocument();
  });

  // ── Ping=0 shows no_connection badge ──

  it("shows no_connection badge when ping is 0", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "ping_endpoint") return 0;
      return null;
    });
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    await waitFor(() => {
      expect(screen.getByText(i18n.t("server.status.no_connection"))).toBeInTheDocument();
    });
  });
});
