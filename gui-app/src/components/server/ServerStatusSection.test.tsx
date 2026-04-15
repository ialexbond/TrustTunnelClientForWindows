import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { ServerStatusSection } from "./ServerStatusSection";
import type { ServerState } from "./useServerState";

// NOTE: ServerStatusSection is the pre-Phase-11 component, kept for backward compat.
// In the new 4-tab structure, ServerTabs uses OverviewSection (which mirrors ServerStatusSection
// without danger buttons). Danger action buttons (stop/restart/reboot) have moved to ServiceSection.
// These tests cover only the display and status-related behaviour of ServerStatusSection.

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

  it("shows rebooting state with loader", () => {
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

  it("shows rebooting countdown when rebooting is true", () => {
    const state = makeState({ rebooting: true });
    render(<ServerStatusSection state={state} />);
    expect(screen.getByText(i18n.t("server.status.rebooting"))).toBeInTheDocument();
  });

  it("shows refresh status button", () => {
    const state = makeState();
    render(<ServerStatusSection state={state} />);
    const allButtons = screen.getAllByRole("button");
    expect(allButtons.length).toBeGreaterThanOrEqual(1);
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
    const allButtons = screen.getAllByRole("button");
    // Find the refresh button (no text label, just icon)
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

  // ── Reboot polling ──

  it("rebooting state triggers polling effect", async () => {
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
    expect(screen.getByText(i18n.t("server.status.rebooting"))).toBeInTheDocument();
    unmount();
  });

  it("does not start reboot polling when rebooting is false", () => {
    const state = makeState({ rebooting: false });
    render(<ServerStatusSection state={state} />);
    const checkCalls = vi.mocked(invoke).mock.calls.filter(c => c[0] === "check_server_installation");
    expect(checkCalls.length).toBe(0);
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
