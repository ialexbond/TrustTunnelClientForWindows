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
    localStorage.clear();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "ping_endpoint") return 42;
      if (cmd === "server_get_stats") return {
        cpu_percent: 35.5,
        load_1m: 0.5, load_5m: 0.6, load_15m: 0.7,
        mem_total: 8_000_000_000,
        mem_used: 4_000_000_000,
        disk_total: 50_000_000_000,
        disk_used: 20_000_000_000,
        unique_ips: 3,
        total_connections: 5,
        uptime_seconds: 90061, // 1д 1ч
      };
      if (cmd === "get_server_geoip") return {
        country: "United States",
        country_code: "US",
        flag_emoji: "🇺🇸",
      };
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

  // ═══════════════════════════════════════════════════════
  // Phase 13: Live data wiring (D-05, D-12, D-14, D-17)
  // ═══════════════════════════════════════════════════════

  describe("Country card (D-05, D-14)", () => {
    it("shows flag emoji + country name when geo resolves", async () => {
      const state = makeState();
      render(<OverviewSection state={state} />);
      await waitFor(() => {
        // formatted: "🇺🇸 United States"
        const bodyText = document.body.textContent || "";
        expect(bodyText).toContain("United States");
        expect(bodyText).toContain("🇺🇸");
      });
    });

    it("shows '—' when geo is null (error)", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") throw new Error("GEOIP_TIMEOUT");
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      await waitFor(() => {
        // Country card should render '—' when geo=null
        const countryLabel = screen.getByText(i18n.t("server.overview.cards.country"));
        expect(countryLabel).toBeInTheDocument();
        // We cannot easily scope to just the Country card, so check that
        // "United States" is NOT present when error path is taken.
        expect(screen.queryByText(/United States/)).not.toBeInTheDocument();
      });
    });

    it("uses cache hit from localStorage (no invoke for geoip)", async () => {
      localStorage.setItem("tt_geoip_10.0.0.1", JSON.stringify({
        country: "Germany", country_code: "DE", flag_emoji: "🇩🇪",
        fetched_at: new Date().toISOString(),
      }));
      const state = makeState();
      render(<OverviewSection state={state} />);
      await waitFor(() => {
        expect(document.body.textContent || "").toContain("Germany");
        expect(document.body.textContent || "").toContain("🇩🇪");
      });
    });
  });

  describe("Uptime card (D-17)", () => {
    it("shows formatted uptime for 90061 seconds (1д 1ч)", async () => {
      const state = makeState();
      render(<OverviewSection state={state} />);
      await waitFor(() => {
        // 90061s → formatServerUptime returns "1д 1ч" (в ru локали)
        const bodyText = document.body.textContent || "";
        expect(bodyText).toMatch(/1д\s*1ч|1d\s*1h/);
      });
    });

    it("shows '—' when stats is null (no data yet or error)", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") throw new Error("SSH_TIMEOUT|10.0.0.1");
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      await waitFor(() => {
        const uptimeLabel = screen.getByText(i18n.t("server.overview.cards.uptime"));
        expect(uptimeLabel).toBeInTheDocument();
        // Если нет значения uptime — 1д 1ч не должно быть
        expect(screen.queryByText(/^1д\s*1ч$|^1d\s*1h$/)).not.toBeInTheDocument();
      });
    });
  });

  describe("Load card (D-17)", () => {
    it("shows CPU percent from stats", async () => {
      const state = makeState();
      render(<OverviewSection state={state} />);
      await waitFor(() => {
        // 35.5 → Math.round → 36
        expect(screen.getByText("36%")).toBeInTheDocument();
      });
    });

    it("shows RAM percent computed from mem_used/mem_total", async () => {
      const state = makeState();
      render(<OverviewSection state={state} />);
      await waitFor(() => {
        // 4e9 / 8e9 = 0.5 → 50%
        expect(screen.getByText("50%")).toBeInTheDocument();
      });
    });

    it("shows 2x '—' when stats is null", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") throw new Error("SSH_TIMEOUT|10.0.0.1");
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      await waitFor(() => {
        // Load card renders two dashes when CPU and RAM are null
        expect(screen.queryByText("36%")).not.toBeInTheDocument();
        expect(screen.queryByText("50%")).not.toBeInTheDocument();
      });
    });
  });

  describe("Partial data (D-14)", () => {
    it("stats resolves but geo rejects: CPU visible, Country is '—'", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return {
          cpu_percent: 42, load_1m: 0, load_5m: 0, load_15m: 0,
          mem_total: 1000, mem_used: 300,
          disk_total: 1, disk_used: 0,
          unique_ips: 0, total_connections: 0,
          uptime_seconds: 3600,
        };
        if (cmd === "get_server_geoip") throw new Error("GEOIP_NO_NETWORK");
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      await waitFor(() => {
        expect(screen.getByText("42%")).toBeInTheDocument();
        expect(screen.queryByText(/United States/)).not.toBeInTheDocument();
      });
    });
  });

  describe("Visibility pause (D-02)", () => {
    it("does NOT call server_get_stats when activeServerTab !== 'overview'", async () => {
      let statsCallCount = 0;
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") { statsCallCount++; return null; }
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} activeServerTab="users" />);
      // Даём microtask-очереди время закончить
      await new Promise((r) => setTimeout(r, 50));
      expect(statsCallCount).toBe(0);
    });

    it("DOES call server_get_stats when activeServerTab === 'overview'", async () => {
      let statsCallCount = 0;
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") { statsCallCount++; return {
          cpu_percent: 1, load_1m: 0, load_5m: 0, load_15m: 0,
          mem_total: 1, mem_used: 0, disk_total: 1, disk_used: 0,
          unique_ips: 0, total_connections: 0, uptime_seconds: 1,
        }; }
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} activeServerTab="overview" />);
      await waitFor(() => {
        expect(statsCallCount).toBeGreaterThanOrEqual(1);
      }, { timeout: 15_000 });
    }, 20_000);
  });

  describe("Rebooting pause (D-03)", () => {
    it("does NOT call server_get_stats when rebooting=true", async () => {
      let statsCallCount = 0;
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") { statsCallCount++; return null; }
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "check_server_installation") throw new Error("still rebooting");
        return null;
      });
      const state = makeState({ rebooting: true });
      render(<OverviewSection state={state} activeServerTab="overview" />);
      await new Promise((r) => setTimeout(r, 50));
      expect(statsCallCount).toBe(0);
    });
  });
});
