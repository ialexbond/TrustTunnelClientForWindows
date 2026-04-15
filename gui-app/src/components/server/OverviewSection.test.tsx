import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { OverviewSection } from "./OverviewSection";
import type { ServerState } from "./useServerState";

// Mock CertSection to isolate OverviewSection rendering
vi.mock("./CertSection", () => ({
  CertSection: () => <div data-testid="cert-section" />,
}));

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    serverInfo: {
      installed: true,
      version: "1.0.20",
      serviceActive: true,
      users: ["user1", "user2"],
      protocol: "WireGuard",
      listenPort: 51820,
      dns: "1.1.1.1",
      mtu: 1280,
    } as ServerState["serverInfo"],
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

describe("OverviewSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "ping_endpoint") return 42;
      return null;
    });
  });

  it("renders status indicator when server is running", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    expect(screen.getByText(i18n.t("server.status.running"))).toBeInTheDocument();
  });

  it("renders stopped status when service is inactive", () => {
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.0.20",
        serviceActive: false,
        users: ["user1"],
      } as ServerState["serverInfo"],
    });
    render(<OverviewSection state={state} />);
    expect(screen.getByText(i18n.t("server.status.stopped"))).toBeInTheDocument();
  });

  it("renders 4 StatCards with server metrics", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    // Check all 4 StatCard labels are present
    expect(screen.getByText(i18n.t("server.overview.version"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.overview.protocol"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.overview.port"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.overview.users"))).toBeInTheDocument();
  });

  it("renders CertSection sub-component", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    expect(screen.getByTestId("cert-section")).toBeVisible();
  });

  it("does NOT render danger/action buttons (stop, restart, reboot)", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    expect(screen.queryByText(new RegExp(i18n.t("server.actions.stop")))).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(i18n.t("server.actions.restart")))).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(i18n.t("server.actions.reboot_server")))).not.toBeInTheDocument();
  });

  it("does NOT show host IP in status row", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    // IP should not be displayed in the status area (DC-03 fix)
    expect(screen.queryByText("10.0.0.1")).not.toBeInTheDocument();
  });

  it("shows skeleton/null state when serverInfo is null", () => {
    const state = makeState({ serverInfo: null });
    const { container } = render(<OverviewSection state={state} />);
    // When serverInfo is null, component returns null
    expect(container.innerHTML).toBe("");
  });

  it("shows ping badge when service is active and ping resolves", async () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    await waitFor(() => {
      expect(screen.getByText("42ms")).toBeInTheDocument();
    });
  });

  it("shows rebooting state with loader", () => {
    const state = makeState({ rebooting: true });
    render(<OverviewSection state={state} />);
    expect(screen.getByText(i18n.t("server.status.rebooting"))).toBeInTheDocument();
  });

  it("refresh button calls loadServerInfo", async () => {
    const loadServerInfo = vi.fn().mockResolvedValue(undefined);
    const state = makeState({ loadServerInfo });
    render(<OverviewSection state={state} />);
    const refreshBtn = screen.getByRole("button", {
      name: i18n.t("server.status.refresh_aria"),
    });
    expect(refreshBtn).toBeInTheDocument();
    fireEvent.click(refreshBtn);
    await waitFor(() => {
      expect(loadServerInfo).toHaveBeenCalledWith(true);
    });
  });

  it("shows StatCard version value", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    expect(screen.getByText("1.0.20")).toBeInTheDocument();
  });

  it("shows user count in StatCard", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    // 2 users in makeState
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
