import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { OverviewSection } from "./OverviewSection";
import type { ServerState } from "./useServerState";

// OverviewSection was redesigned in Phase 11 to a 10-card flex-wrap layout.
// Phase 12.5-followup: all user-facing strings moved from hardcoded Russian
// literals to i18n keys under server.overview.* and server.status.*. Tests
// resolve labels through the i18n instance so they work for every locale.

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    serverInfo: {
      installed: true,
      version: "1.0.20",
      serviceActive: true,
      users: ["user1", "user2"],
      protocol: "WireGuard",
      listenPort: 51820,
    } as ServerState["serverInfo"],
    actionLoading: null,
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    runAction: vi.fn(),
    loadServerInfo: vi.fn().mockResolvedValue(undefined),
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

  it("renders a Status card with running state when service is active", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    expect(screen.getByText(i18n.t("server.overview.cards.status"))).toBeInTheDocument();
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

  it("renders the 10 overview card titles via i18n", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    const keys = [
      "server.overview.cards.status",
      "server.overview.cards.ping",
      "server.overview.cards.speed",
      "server.overview.cards.userCount",
      "server.overview.cards.ip",
      "server.overview.cards.country",
      "server.overview.cards.uptime",
      "server.overview.cards.protocolVersion",
      "server.overview.cards.security",
      "server.overview.cards.load",
    ];
    for (const key of keys) {
      expect(screen.getByText(i18n.t(key))).toBeInTheDocument();
    }
  });

  it("does NOT render danger/action buttons (stop, restart, reboot)", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    expect(screen.queryByText(new RegExp(i18n.t("server.actions.stop")))).not.toBeInTheDocument();
    expect(screen.queryByText(new RegExp(i18n.t("server.actions.restart")))).not.toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(i18n.t("server.actions.reboot_server"))),
    ).not.toBeInTheDocument();
  });

  it("shows host IP only in the dedicated IP card (DC-03 scope)", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    const matches = screen.getAllByText("10.0.0.1");
    expect(matches).toHaveLength(1);
    const ipCard = screen
      .getByText(i18n.t("server.overview.cards.ip"))
      .closest('[class*="Card"], [style*="flex"]');
    expect(ipCard?.textContent).toContain("10.0.0.1");
  });

  it("renders a Skeleton grid when serverInfo is null", () => {
    const state = makeState({ serverInfo: null });
    const { container } = render(<OverviewSection state={state} />);
    expect(container.innerHTML.length).toBeGreaterThan(0);
    // Skeleton grid renders card titles (via i18n) but no status value.
    expect(screen.getByText(i18n.t("server.overview.cards.status"))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("server.status.running"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("server.status.stopped"))).not.toBeInTheDocument();
  });

  it("shows ping value (ms) when service is active and ping resolves", async () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    await waitFor(() => {
      expect(screen.getByText("42")).toBeInTheDocument();
    });
  });

  it("shows rebooting countdown label when rebooting", () => {
    const state = makeState({ rebooting: true });
    render(<OverviewSection state={state} />);
    // Label is "Перезагрузка" / "Rebooting" (i18n) followed by countdown suffix.
    const rebootLabel = i18n.t("server.overview.rebootingCountdown");
    // partial text match — the render appends "..." or " {N}s" to the label.
    expect(
      screen.getByText((content) => content.startsWith(rebootLabel)),
    ).toBeInTheDocument();
  });

  it("refresh button uses localized aria-label", async () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    const refreshAria = i18n.t("server.overview.refreshAria");
    const refreshBtns = screen.getAllByRole("button", { name: refreshAria });
    expect(refreshBtns.length).toBeGreaterThan(0);
    fireEvent.click(refreshBtns[0]);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("ping_endpoint", expect.any(Object));
    });
  });

  it("shows server version in the protocol-version card", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    const allText = document.body.textContent || "";
    expect(allText).toMatch(/1\.0\.20/);
  });

  it("shows user count of 2 in the Users card", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("renders correctly in English locale (i18n switch)", async () => {
    await i18n.changeLanguage("en");
    const state = makeState();
    render(<OverviewSection state={state} />);
    // Status card title and running state must appear in English now.
    expect(screen.getByText(i18n.t("server.overview.cards.status"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.status.running"))).toBeInTheDocument();
    // Explicit English check so a regression (hardcoded RU) would fail here.
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("IP address")).toBeInTheDocument();
    expect(screen.getByText("Protocol version")).toBeInTheDocument();
    expect(screen.getByText("Security")).toBeInTheDocument();
  });
});
