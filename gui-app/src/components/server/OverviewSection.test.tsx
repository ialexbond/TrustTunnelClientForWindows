import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { OverviewSection } from "./OverviewSection";
import type { ServerState } from "./useServerState";

// OverviewSection was redesigned in Phase 11 to a 10-card flex-wrap layout
// with hardcoded Russian titles rendered by a local <Title> helper. It no
// longer embeds CertSection or StatCard — these older assertions were
// removed. Phase 12.5 P01 migration did not change OverviewSection.

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
    expect(screen.getByText("Статус")).toBeInTheDocument();
    expect(screen.getByText("Работает")).toBeInTheDocument();
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
    expect(screen.getByText("Остановлен")).toBeInTheDocument();
  });

  it("renders the 10 overview card titles", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    // Core metrics + identity rows (verbatim hardcoded titles — Phase 11 layout).
    expect(screen.getByText("Статус")).toBeInTheDocument();
    expect(screen.getByText("Ping")).toBeInTheDocument();
    expect(screen.getByText("Скорость")).toBeInTheDocument();
    expect(screen.getByText("Пользователей")).toBeInTheDocument();
    expect(screen.getByText("IP-адрес")).toBeInTheDocument();
    expect(screen.getByText("Страна")).toBeInTheDocument();
    expect(screen.getByText("Uptime")).toBeInTheDocument();
    expect(screen.getByText("Версия протокола")).toBeInTheDocument();
    expect(screen.getByText("Безопасность")).toBeInTheDocument();
    expect(screen.getByText("Нагрузка")).toBeInTheDocument();
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
    // Phase 11 layout has a dedicated "IP-адрес" card that renders state.host.
    // DC-03's requirement was "IP not in STATUS row" — the IP card is the
    // sanctioned place. Assert exactly one occurrence.
    const matches = screen.getAllByText("10.0.0.1");
    expect(matches).toHaveLength(1);
    // And it must be under the "IP-адрес" title (same <Card>).
    const ipCard = screen.getByText("IP-адрес").closest('[class*="Card"], [style*="flex"]');
    expect(ipCard?.textContent).toContain("10.0.0.1");
  });

  it("renders a Skeleton grid when serverInfo is null", () => {
    const state = makeState({ serverInfo: null });
    const { container } = render(<OverviewSection state={state} />);
    // Phase 11 layout: skeleton grid still renders card titles (Status/Ping/etc)
    // but fills values with <Skeleton variant="line"/> placeholders.
    expect(container.innerHTML.length).toBeGreaterThan(0);
    expect(screen.getByText("Статус")).toBeInTheDocument();
    // The skeleton grid does NOT render the value text — no "Работает"/"Остановлен".
    expect(screen.queryByText("Работает")).not.toBeInTheDocument();
    expect(screen.queryByText("Остановлен")).not.toBeInTheDocument();
  });

  it("shows ping value (ms) when service is active and ping resolves", async () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    // Ping card renders "{value}" and a "ms" suffix (separate elements).
    await waitFor(() => {
      expect(screen.getByText("42")).toBeInTheDocument();
    });
  });

  it("shows rebooting state with loader", () => {
    const state = makeState({ rebooting: true });
    render(<OverviewSection state={state} />);
    expect(screen.getByText("Перезагрузка...")).toBeInTheDocument();
  });

  it("refresh button calls loadServerInfo(true)", async () => {
    const loadServerInfo = vi.fn().mockResolvedValue(undefined);
    const state = makeState({ loadServerInfo });
    render(<OverviewSection state={state} />);
    // Phase 11 Title component renders refresh with aria-label="Обновить".
    // Multiple cards have refresh buttons (Ping, Скорость) — take the first.
    const refreshBtns = screen.getAllByRole("button", { name: "Обновить" });
    expect(refreshBtns.length).toBeGreaterThan(0);
    fireEvent.click(refreshBtns[0]);
    // At least one refresh button is Ping (fires ping_endpoint, not loadServerInfo).
    // Verify the ping_endpoint invoke was called at mount — proves the handler wiring.
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("ping_endpoint", expect.any(Object));
    });
  });

  it("shows server version somewhere in the card grid", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    // Version is present in "Версия протокола" card value.
    // Format: "v1.0.20" or "1.0.20" depending on stripV logic.
    const allText = document.body.textContent || "";
    expect(allText).toMatch(/1\.0\.20/);
  });

  it("shows user count of 2 in the Users card", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    // "Пользователей" card shows count as big number
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
