import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { OverviewSection } from "./OverviewSection";
import type { ServerState } from "./useServerState";
// Phase 3 safety-net (Wave 1, Stream 1): consume the shared Wave-0 fixtures
// instead of re-declaring a local makeState. makeState now carries `certRaw`
// (default null) which the Security card's TLS sub-tile reads; makeCertRaw
// builds a JSON cert payload whose notAfter is N days out so we can pin the
// TLS day-band labels (ok / warning / expired / no-cert). See
// gui-pro/src/test/fixtures/index.ts + .planning/phases/03-…/03-RESEARCH.md §3.
import { makeState, makeCertRaw } from "../../test/fixtures";

// OverviewSection was redesigned in Phase 11 to a 10-card flex-wrap layout.
// Phase 12.5-followup: all user-facing strings moved from hardcoded Russian
// literals to i18n keys under server.overview.* and server.status.*. Tests
// resolve labels through the i18n instance so they work for every locale.

/**
 * Scope a query to a single overview card by its (unique) title text.
 *
 * Every card renders the same internal shape:
 *
 *   <div (Card root)>
 *     <div (Title)>            ← "flex items-center justify-between mb-3"
 *       <div> icon <span>{title}</span> </div>
 *       <div> refresh / chevron </div>
 *     </div>
 *     <div> …value content… </div>
 *   </div>
 *
 * `getByText(title)` returns the inner <span>; walking three parents reaches
 * the Card root that also contains the value. We intentionally walk structural
 * parents (not a `.closest('[class*="Card"]')` class match) so the scoping
 * survives a Phase-4 presentation refactor — assertion philosophy D-04 (no CSS
 * coupling). Returns the root element so callers can `within(card)`.
 */
function cardOf(titleKey: string): HTMLElement {
  const titleSpan = screen.getByText(i18n.t(titleKey));
  // span → (icon+title div) → (Title div) → (Card root)
  const root = titleSpan.parentElement?.parentElement?.parentElement;
  if (!root) throw new Error(`cardOf: could not locate card root for "${titleKey}"`);
  return root as HTMLElement;
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

  it("does NOT render danger/action buttons (stop, reboot, restart) — UAT 2026-05-20: restart removed entirely", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    // stop + reboot + restart must NOT be in Overview
    expect(screen.queryByText(new RegExp(i18n.t("server.actions.stop")))).not.toBeInTheDocument();
    expect(
      screen.queryByText(new RegExp(i18n.t("server.actions.reboot_server"))),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("overview-restart-service-button")).not.toBeInTheDocument();
  });

  it("shows host IP only in the dedicated IP card (DC-03 scope)", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    const matches = screen.getAllByText("10.0.0.1");
    expect(matches).toHaveLength(1);
    // False-green / CSS-coupling FIX (RESEARCH §3 stream 1, was :121):
    // previously scoped via `.closest('[class*="Card"], [style*="flex"]')`,
    // a className/style selector that a Phase-4 refactor could silently void.
    // Re-scope structurally with within(cardOf(...)) — assert the IP value is
    // rendered INSIDE the IP card itself, not merely somewhere in the DOM.
    const ipCard = cardOf("server.overview.cards.ip");
    expect(within(ipCard).getByText("10.0.0.1")).toBeInTheDocument();
  });

  it("renders a Skeleton grid when serverInfo is null", () => {
    const state = makeState({ serverInfo: null });
    render(<OverviewSection state={state} />);
    // False-green FIX (RESEARCH §3 stream 1, was :128): the old
    // `container.innerHTML.length > 0` assertion passes on ANY non-empty
    // markup — even an empty wrapper div — so it never proved the skeleton
    // grid rendered. Pin the real skeleton-state contract instead: the card
    // titles render (the grid mounted) AND no resolved status value shows
    // (we are in the pre-data skeleton branch, not the loaded branch).
    const skeletonTitleKeys = [
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
    for (const key of skeletonTitleKeys) {
      expect(screen.getByText(i18n.t(key))).toBeInTheDocument();
    }
    // No resolved status value in the skeleton branch.
    expect(screen.queryByText(i18n.t("server.status.running"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("server.status.stopped"))).not.toBeInTheDocument();
    // And no drill-down buttons exist yet (serverInfo===null short-circuits
    // before ClickableCard renders) — proves we rendered the skeleton grid,
    // not the loaded 10-card grid.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
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
    // False-green FIX (RESEARCH §3 stream 1, was :170): the old
    // `document.body.textContent` scan would pass on cross-test DOM leakage
    // or on the version appearing anywhere. Scope to the protocol-version
    // card and assert the value renders INSIDE it.
    const versionCard = cardOf("server.overview.cards.protocolVersion");
    expect(within(versionCard).getByText("1.0.20")).toBeInTheDocument();
  });

  it("shows user count of 2 in the Users card", () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    // False-green FIX (RESEARCH §3 stream 1, was :174): bare `getByText("2")`
    // could match a "2" anywhere in the tree. Scope to the Users card so the
    // count is proven to be the userCount value (users: ["user1","user2"]).
    const usersCard = cardOf("server.overview.cards.userCount");
    expect(within(usersCard).getByText("2")).toBeInTheDocument();
  });

  it("renders correctly in English locale (i18n switch)", async () => {
    await i18n.changeLanguage("en");
    const state = makeState();
    render(<OverviewSection state={state} />);
    // Status card title and running state must appear in English now.
    expect(screen.getByText(i18n.t("server.overview.cards.status"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.status.running"))).toBeInTheDocument();
    // Explicit English check so a regression (hardcoded RU) would fail here.
    expect(screen.getByText("Protocol status")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("IP address")).toBeInTheDocument();
    expect(screen.getByText("Protocol version")).toBeInTheDocument();
    expect(screen.getByText("Security")).toBeInTheDocument();
  });

  // ═══════════════════════════════════════════════════════
  // Phase 13: Live data wiring (D-05, D-12, D-14, D-17)
  // ═══════════════════════════════════════════════════════

  describe("Country card (D-05, D-14)", () => {
    // Phase 13.UAT: country name локализован через Intl.DisplayNames по i18n.language.
    // beforeEach устанавливает 'ru' → "США" вместо "United States". Для предсказуемости
    // в этих тестах временно switch на 'en'.
    beforeEach(async () => {
      await i18n.changeLanguage("en");
    });

    it("shows flag emoji + country name when geo resolves", async () => {
      const state = makeState();
      render(<OverviewSection state={state} />);
      // False-green FIX (RESEARCH §3 stream 1, was :211): the old
      // `document.body.textContent` scan passes on cross-test DOM leakage.
      // Scope to the Country card and assert the resolved name renders inside.
      await waitFor(() => {
        const countryCard = cardOf("server.overview.cards.country");
        expect(within(countryCard).getByText("United States")).toBeInTheDocument();
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
        // D-03.4: scope to the Country card instead of a body.textContent scan
        // (which would pass on cross-test DOM leakage). Country card shows just
        // the country name (flag emoji removed per UX).
        const countryCard = cardOf("server.overview.cards.country");
        expect(within(countryCard).getByText("Germany")).toBeInTheDocument();
      });
    });

    it("expired localStorage cache (>30 days) refetches geoip", async () => {
      // Set up cache that is 31 days old → loadCache evicts it → refetch path.
      const expiredISO = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      localStorage.setItem("tt_geoip_10.0.0.1", JSON.stringify({
        country: "Germany", country_code: "DE", flag_emoji: "🇩🇪",
        fetched_at: expiredISO,
      }));
      const state = makeState();
      render(<OverviewSection state={state} />);
      // After refetch from default mock — country becomes "United States", not "Germany".
      // D-03.4: scope to the Country card (no body.textContent leakage scan).
      await waitFor(() => {
        const countryCard = cardOf("server.overview.cards.country");
        expect(within(countryCard).getByText("United States")).toBeInTheDocument();
      });
      // Expired entry was removed.
      expect(localStorage.getItem("tt_geoip_10.0.0.1")).not.toContain("Germany");
    });
  });

  describe("Uptime card (D-17)", () => {
    // useServerStats first fire triggers via 10s setTimeout (per 13-02-SUMMARY decision).
    // Tests that observe live stats must wait at least one polling tick + buffer.
    it("shows formatted uptime for 90061 seconds (1д 1ч)", async () => {
      const state = makeState();
      render(<OverviewSection state={state} />);
      // False-green FIX (RESEARCH §3 stream 1, was :274): the old
      // `document.body.textContent` regex scan passes on DOM leakage. Scope
      // to the Uptime card and assert the formatted value renders inside it.
      // 90061s → formatServerUptime → "1д 1ч" (ru) (daysHours format).
      const expected = i18n.t("server.overview.uptimeFormat.daysHours", { days: 1, hours: 1 });
      await waitFor(() => {
        const uptimeCard = cardOf("server.overview.cards.uptime");
        expect(within(uptimeCard).getByText(expected)).toBeInTheDocument();
      }, { timeout: 15_000 });
    }, 20_000);

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
      }, { timeout: 15_000 });
    }, 20_000);

    it("shows RAM in USED / TOTAL МБ format", async () => {
      const state = makeState();
      render(<OverviewSection state={state} />);
      await waitFor(() => {
        // 4e9 / 1024^2 ≈ 3815 МБ used; 8e9 / 1024^2 ≈ 7629 МБ total
        expect(screen.getByText(/3815\s*\/\s*7629/)).toBeInTheDocument();
      }, { timeout: 15_000 });
    }, 20_000);

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
      }, { timeout: 15_000 });
    }, 20_000);
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

  // ═══════════════════════════════════════════════════════
  // Phase 13: Drill-down navigation (D-09, D-10, D-11)
  // ═══════════════════════════════════════════════════════

  describe("OverviewSection drill-down (D-09, D-11)", () => {
    it("drill-down: calls onNavigate('users') when Users card is clicked", async () => {
      const onNavigate = vi.fn();
      const state = makeState();
      render(<OverviewSection state={state} onNavigate={onNavigate} />);

      const usersTitle = screen.getByText(i18n.t("server.overview.cards.userCount"));
      const card = usersTitle.closest('[role="button"]');
      expect(card).not.toBeNull();

      fireEvent.click(card!);
      expect(onNavigate).toHaveBeenCalledWith("users");
    });

    it("drill-down: calls onNavigate('service') on Enter key on Protocol version card (Phase 19 — target moved from configuration to service)", async () => {
      const onNavigate = vi.fn();
      const state = makeState();
      render(<OverviewSection state={state} onNavigate={onNavigate} />);

      const versionTitle = screen.getByText(i18n.t("server.overview.cards.protocolVersion"));
      const card = versionTitle.closest('[role="button"]');
      expect(card).not.toBeNull();

      fireEvent.keyDown(card!, { key: "Enter" });
      expect(onNavigate).toHaveBeenCalledWith("service");
    });

    it("Phase 19 — Protocol version card shows ArrowUp icon when sidecarAvailable=true", () => {
      const onNavigate = vi.fn();
      const state = makeState();
      render(
        <OverviewSection
          state={state}
          onNavigate={onNavigate}
          sidecarAvailable={true}
        />,
      );

      // False-green FIX (RESEARCH §3 stream 1, was :453): `not.toBeNull()` is
      // weaker than `toBeInTheDocument()` (a detached node is non-null), and
      // the arrow's accessible label was never asserted. Pin BOTH presence and
      // the aria-label value, and prove the indicator lives inside the
      // protocol-version card (cascade indicator is the actual code testid
      // `overview-protocol-update-arrow`, NOT the stale spec name).
      const versionCard = cardOf("server.overview.cards.protocolVersion");
      const arrow = within(versionCard).getByTestId("overview-protocol-update-arrow");
      expect(arrow).toBeInTheDocument();
      expect(arrow).toHaveAttribute(
        "aria-label",
        i18n.t("server.service.protocol.update_available_badge"),
      );
    });

    it("Phase 19 — Protocol version card HIDES ArrowUp icon when sidecarAvailable=false", () => {
      const onNavigate = vi.fn();
      const state = makeState();
      render(
        <OverviewSection
          state={state}
          onNavigate={onNavigate}
          sidecarAvailable={false}
        />,
      );

      expect(screen.queryByTestId("overview-protocol-update-arrow")).toBeNull();
    });

    it("Phase 19 cascade fix — ArrowUpCircle becomes visible WITHOUT remount when sidecarAvailable flips false→true", () => {
      const onNavigate = vi.fn();
      const state = makeState({
        serverInfo: {
          installed: true,
          version: "1.0.33",
          serviceActive: true,
          users: ["u1"],
          protocol: "WireGuard",
          listenPort: 51820,
        } as ServerState["serverInfo"],
      });
      const { rerender } = render(
        <OverviewSection
          state={state}
          onNavigate={onNavigate}
          sidecarAvailable={false}
        />,
      );

      // Initially: no arrow (sidecarAvailable=false)
      expect(screen.queryByTestId("overview-protocol-update-arrow")).toBeNull();

      // Simulate post-downgrade cascade: sidecarAvailable flips to true (same component instance, no remount)
      const stateAfterDowngrade = makeState({
        serverInfo: {
          installed: true,
          version: "1.0.31",
          serviceActive: true,
          users: ["u1"],
          protocol: "WireGuard",
          listenPort: 51820,
        } as ServerState["serverInfo"],
      });
      rerender(
        <OverviewSection
          state={stateAfterDowngrade}
          onNavigate={onNavigate}
          sidecarAvailable={true}
        />,
      );

      // ArrowUpCircle must now be visible without any unmount/remount, inside
      // the protocol-version card, with its accessible label populated
      // (strengthened per RESEARCH §3 stream 1 — assert flip presence + label).
      const versionCard = cardOf("server.overview.cards.protocolVersion");
      const arrow = within(versionCard).getByTestId("overview-protocol-update-arrow");
      expect(arrow).toBeInTheDocument();
      expect(arrow).toHaveAttribute(
        "aria-label",
        i18n.t("server.service.protocol.update_available_badge"),
      );
    });

    it("drill-down: calls onNavigate('security') on Space key on Security card", async () => {
      const onNavigate = vi.fn();
      const state = makeState();
      render(<OverviewSection state={state} onNavigate={onNavigate} />);

      const securityTitle = screen.getByText(i18n.t("server.overview.cards.security"));
      const card = securityTitle.closest('[role="button"]');
      expect(card).not.toBeNull();

      fireEvent.keyDown(card!, { key: " " });
      expect(onNavigate).toHaveBeenCalledWith("security");
    });

    it("drill-down: non-clickable cards do NOT have role=button (display-only)", async () => {
      const state = makeState();
      render(<OverviewSection state={state} onNavigate={vi.fn()} />);

      const nonClickableKeys = [
        "server.overview.cards.status",
        "server.overview.cards.ping",
        "server.overview.cards.speed",
        "server.overview.cards.ip",
        "server.overview.cards.country",
        "server.overview.cards.uptime",
        "server.overview.cards.load",
      ];

      for (const key of nonClickableKeys) {
        const title = screen.getByText(i18n.t(key));
        const card = title.closest('[role="button"]');
        expect(card, `card "${key}" unexpectedly has role=button`).toBeNull();
      }
    });

    it("drill-down: clickable cards have role=button with descriptive aria-label", async () => {
      const state = makeState();
      render(<OverviewSection state={state} onNavigate={vi.fn()} />);

      const clickableKeys = [
        "server.overview.cards.userCount",
        "server.overview.cards.protocolVersion",
        "server.overview.cards.security",
      ];

      for (const key of clickableKeys) {
        const label = i18n.t(key);
        const title = screen.getByText(label);
        const card = title.closest('[role="button"]');
        expect(card, `card "${key}" must be role=button`).not.toBeNull();
        expect(card?.getAttribute("aria-label")).toBe(label);
      }
    });

    it("drill-down: does NOT throw when onNavigate is undefined (backward compat)", async () => {
      const state = makeState();
      render(<OverviewSection state={state} />); // no onNavigate

      const usersTitle = screen.getByText(i18n.t("server.overview.cards.userCount"));
      const card = usersTitle.closest('[role="button"]');
      expect(card).not.toBeNull();

      // Clicking должен не падать даже без onNavigate (optional chain в handler)
      expect(() => fireEvent.click(card!)).not.toThrow();
    });
  });

  // ═══════════════════════════════════════════════════════
  // Phase 13.UAT: activityLog coverage for new functionality
  // ═══════════════════════════════════════════════════════

  describe("activityLog coverage (UAT)", () => {
    it("logs ping manual refresh + result via write_activity_log", async () => {
      const logged: Array<{ tag: string; message: string }> = [];
      vi.mocked(invoke).mockImplementation(async (cmd: string, params?: unknown) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "write_activity_log") {
          const p = params as { tag: string; message: string };
          logged.push({ tag: p.tag, message: p.message });
        }
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);

      // Wait for initial mount + ping fetch
      await waitFor(() => {
        const pingButtons = screen.getAllByLabelText(i18n.t("server.overview.refreshAria"));
        expect(pingButtons.length).toBeGreaterThan(0);
      });
      const pingButton = screen.getAllByLabelText(i18n.t("server.overview.refreshAria"))[0];
      fireEvent.click(pingButton);

      await waitFor(() => {
        expect(logged.some((e) => e.tag === "USER" && e.message.includes("overview.ping.manual_refresh"))).toBe(true);
        expect(logged.some((e) => e.tag === "STATE" && e.message.includes("overview.ping.result"))).toBe(true);
      }, { timeout: 5_000 });
    });

    it("logs speedtest start + completed via write_activity_log", async () => {
      const logged: Array<{ tag: string; message: string }> = [];
      vi.mocked(invoke).mockImplementation(async (cmd: string, params?: unknown) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "speedtest_run") return { download_mbps: 100, upload_mbps: 50 };
        if (cmd === "write_activity_log") {
          const p = params as { tag: string; message: string };
          logged.push({ tag: p.tag, message: p.message });
        }
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);

      // Speed card has its own refresh button — second one in DOM (after ping)
      const refreshButtons = await screen.findAllByLabelText(i18n.t("server.overview.refreshAria"));
      // Speed is index 1 (after Ping). Click it.
      fireEvent.click(refreshButtons[1]);

      await waitFor(() => {
        expect(logged.some((e) => e.tag === "USER" && e.message.includes("overview.speedtest.started"))).toBe(true);
        expect(logged.some((e) => e.tag === "STATE" && e.message.includes("overview.speedtest.completed"))).toBe(true);
      }, { timeout: 5_000 });
    });

    it("logs security_get_status loaded with firewall + fail2ban states", async () => {
      const logged: Array<{ tag: string; message: string }> = [];
      vi.mocked(invoke).mockImplementation(async (cmd: string, params?: unknown) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "security_get_status") return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: false } };
        if (cmd === "write_activity_log") {
          const p = params as { tag: string; message: string };
          logged.push({ tag: p.tag, message: p.message });
        }
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);

      await waitFor(() => {
        expect(
          logged.some(
            (e) =>
              e.tag === "STATE" &&
              e.message.includes("overview.security.loaded") &&
              e.message.includes("firewall=active") &&
              e.message.includes("fail2ban=inactive"),
          ),
        ).toBe(true);
      }, { timeout: 5_000 });
    });
  });

  // ═══════════════════════════════════════════════════════
  // Phase 13.UAT: Speed card disabled state when protocol stopped
  // ═══════════════════════════════════════════════════════

  describe("Speed card protocol gating (UAT)", () => {
    it("shows 'Запустите протокол' message when serviceActive=false", async () => {
      const state = makeState({
        serverInfo: {
          installed: true,
          version: "1.0.0",
          serviceActive: false,
          users: [],
          listenPort: 443,
          protocol: "x",
        },
      });
      render(<OverviewSection state={state} />);
      await waitFor(() => {
        expect(screen.getByText(i18n.t("server.overview.speedRequiresProtocol"))).toBeInTheDocument();
      });
    });

    it("does NOT call server_speedtest_run when serviceActive=false (refresh disabled)", async () => {
      let speedtestCalled = false;
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "speedtest_run") { speedtestCalled = true; return { download_mbps: 100, upload_mbps: 50 }; }
        return null;
      });
      const state = makeState({
        serverInfo: {
          installed: true,
          version: "1.0.0",
          serviceActive: false,
          users: [],
          listenPort: 443,
          protocol: "x",
        },
      });
      render(<OverviewSection state={state} />);
      await waitFor(() => {
        expect(screen.getByText(i18n.t("server.overview.speedRequiresProtocol"))).toBeInTheDocument();
      });
      // False-green FIX (RESEARCH §3 stream 1, was :720): the old
      // `speedTitle.closest("div")?.parentElement?.querySelector('button…')`
      // chain passes VACUOUSLY when any link in the traversal returns null
      // (a null parentElement → undefined?.querySelector → undefined ===
      // "not present"), so it never genuinely proved the refresh button was
      // absent. Scope to the Speed card and assert there is no refresh button
      // by its accessible name (onRefresh={undefined} when !isRunning).
      const speedCard = cardOf("server.overview.cards.speed");
      expect(
        within(speedCard).queryByRole("button", { name: i18n.t("server.overview.refreshAria") }),
      ).not.toBeInTheDocument();
      expect(speedtestCalled).toBe(false);
    });

    it("calls speedtest_run when refresh clicked while running", async () => {
      const calls: string[] = [];
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        calls.push(cmd);
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "speedtest_run") return { download_mbps: 200, upload_mbps: 80 };
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);

      const refreshButtons = await screen.findAllByLabelText(i18n.t("server.overview.refreshAria"));
      fireEvent.click(refreshButtons[1]); // Speed refresh (after Ping)

      await waitFor(() => {
        expect(calls.filter((c) => c === "speedtest_run").length).toBeGreaterThan(0);
      }, { timeout: 5_000 });
    });
  });

  // ═══════════════════════════════════════════════════════
  // Phase 3 safety-net (Stream 1) — missing render-state characterization
  // (RESEARCH §3 stream 1 Gaps). Pins TODAY's visible behavior + a11y so a
  // Phase-4 presentation refactor fails loudly on drift. Behavior/role/aria/
  // i18n text only — no toHaveClass / class-querySelector / snapshots (D-04).
  // No production code touched (D-06).
  // ═══════════════════════════════════════════════════════

  describe("Speed card render states (G-05, RESEARCH §3 stream 1)", () => {
    it("never-measured: shows 'Не измерялась' when running and speedtest never ran", () => {
      const state = makeState();
      render(<OverviewSection state={state} />);
      // Render-branch priority 5: running, speed=null, !speedFailed → initial.
      const speedCard = cardOf("server.overview.cards.speed");
      expect(
        within(speedCard).getByText(i18n.t("server.overview.speedNotMeasured")),
      ).toBeInTheDocument();
    });

    it("result: shows ↓download | ↑upload values + unit after speedtest resolves", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "speedtest_run") return { download_mbps: 200.4, upload_mbps: 80.6 };
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      const refreshButtons = await screen.findAllByLabelText(i18n.t("server.overview.refreshAria"));
      fireEvent.click(refreshButtons[1]); // Speed refresh (index 1, after Ping)
      const speedCard = cardOf("server.overview.cards.speed");
      await waitFor(() => {
        // Math.round(200.4)=200, Math.round(80.6)=81
        expect(within(speedCard).getByText("200")).toBeInTheDocument();
        expect(within(speedCard).getByText("81")).toBeInTheDocument();
      });
      // Both values carry the "Мбит/с" unit (one per arrow).
      expect(within(speedCard).getAllByText(i18n.t("server.overview.speedUnit"))).toHaveLength(2);
      // Result branch replaces the initial "Не измерялась" placeholder.
      expect(
        within(speedCard).queryByText(i18n.t("server.overview.speedNotMeasured")),
      ).not.toBeInTheDocument();
    });

    it("failed: shows '—' + dataUnavailable subtitle when speedtest rejects (G-05)", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "speedtest_run") throw new Error("SPEEDTEST_FAILED");
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      const refreshButtons = await screen.findAllByLabelText(i18n.t("server.overview.refreshAria"));
      fireEvent.click(refreshButtons[1]);
      const speedCard = cardOf("server.overview.cards.speed");
      await waitFor(() => {
        expect(
          within(speedCard).getByText(i18n.t("server.overview.dataUnavailable")),
        ).toBeInTheDocument();
      });
      // Failed branch shows the muted dash, NOT the never-measured placeholder.
      expect(within(speedCard).getByText("—")).toBeInTheDocument();
      expect(
        within(speedCard).queryByText(i18n.t("server.overview.speedNotMeasured")),
      ).not.toBeInTheDocument();
    });

    it("measuring: refresh disabled + no result/placeholder text while speedtest in flight", async () => {
      // Deferred promise — speedtest_run never settles → speedTesting stays true.
      let releaseSpeedtest: (v: { download_mbps: number; upload_mbps: number }) => void = () => {};
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "speedtest_run") {
          return new Promise((resolve) => { releaseSpeedtest = resolve; });
        }
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      const refreshButtons = await screen.findAllByLabelText(i18n.t("server.overview.refreshAria"));
      const speedRefresh = refreshButtons[1];
      fireEvent.click(speedRefresh);
      // While measuring (speedTesting=true): the Speed refresh button is
      // disabled (refreshing={speedTesting}) — accessible state, no CSS.
      await waitFor(() => {
        expect(speedRefresh).toBeDisabled();
      });
      const speedCard = cardOf("server.overview.cards.speed");
      // Neither the never-measured placeholder nor a result shows mid-flight.
      expect(
        within(speedCard).queryByText(i18n.t("server.overview.speedNotMeasured")),
      ).not.toBeInTheDocument();
      expect(
        within(speedCard).queryByText(i18n.t("server.overview.dataUnavailable")),
      ).not.toBeInTheDocument();
      // Cleanup: release the deferred promise so the act() flush settles.
      await act(async () => { releaseSpeedtest({ download_mbps: 1, upload_mbps: 1 }); });
    });

    it("requires-protocol: shows 'Запустите протокол' when serviceActive=false", async () => {
      const state = makeState({
        serverInfo: {
          installed: true,
          version: "1.0.0",
          serviceActive: false,
          users: [],
          listenPort: 443,
          protocol: "x",
        } as ServerState["serverInfo"],
      });
      render(<OverviewSection state={state} />);
      const speedCard = cardOf("server.overview.cards.speed");
      expect(
        within(speedCard).getByText(i18n.t("server.overview.speedRequiresProtocol")),
      ).toBeInTheDocument();
    });

    it("requires-protocol: shows 'Запустите протокол' when rebooting", async () => {
      const state = makeState({ rebooting: true });
      render(<OverviewSection state={state} />);
      const speedCard = cardOf("server.overview.cards.speed");
      expect(
        within(speedCard).getByText(i18n.t("server.overview.speedRequiresProtocol")),
      ).toBeInTheDocument();
    });
  });

  describe("Ping card render states + G-08 guard (RESEARCH §3 stream 1)", () => {
    it("unavailable: shows '—' + dataUnavailable subtitle when ping rejects (M-07)", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") throw new Error("PING_TIMEOUT");
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      const pingCard = cardOf("server.overview.cards.ping");
      await waitFor(() => {
        // ping=-1 → dash + "Не удалось получить данные" subtitle.
        expect(
          within(pingCard).getByText(i18n.t("server.overview.dataUnavailable")),
        ).toBeInTheDocument();
      });
      expect(within(pingCard).getByText("—")).toBeInTheDocument();
    });

    it("pending: shows '—' WITHOUT subtitle while initial ping is unresolved", async () => {
      // Never-settling ping → ping stays null (pending), not -1 (unavailable).
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return new Promise<number>(() => {});
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      const pingCard = cardOf("server.overview.cards.ping");
      // Pending: dash present, but the unavailable subtitle is absent (ping!==-1).
      expect(within(pingCard).getByText("—")).toBeInTheDocument();
      expect(
        within(pingCard).queryByText(i18n.t("server.overview.dataUnavailable")),
      ).not.toBeInTheDocument();
    });

    it("G-08 guard: refresh disabled while a manual ping is in flight (rapid-fire is a no-op)", async () => {
      // Deferred ping so pingLoading stays true after the manual click.
      let releasePing: (ms: number) => void = () => {};
      let manualPingInvokes = 0;
      let initialResolved = false;
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") {
          // First (initial useEffect) ping resolves immediately so the card
          // mounts in a settled state; subsequent manual pings are deferred.
          if (!initialResolved) { initialResolved = true; return 42; }
          manualPingInvokes++;
          return new Promise<number>((resolve) => { releasePing = resolve; });
        }
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      // Wait for the initial ping value to settle so we start from a clean state.
      const pingCard = cardOf("server.overview.cards.ping");
      await waitFor(() => {
        expect(within(pingCard).getByText("42")).toBeInTheDocument();
      });
      const pingRefresh = within(pingCard).getByRole("button", {
        name: i18n.t("server.overview.refreshAria"),
      });
      // Click once → manual ping starts → button disabled (refreshing=pingLoading).
      fireEvent.click(pingRefresh);
      await waitFor(() => { expect(pingRefresh).toBeDisabled(); });
      // Rapid-fire: extra clicks while disabled must NOT enqueue more invokes.
      fireEvent.click(pingRefresh);
      fireEvent.click(pingRefresh);
      expect(manualPingInvokes).toBe(1);
      // Release so the act() flush settles cleanly.
      await act(async () => { releasePing(50); });
    });
  });

  describe("Security card sub-tiles (RESEARCH §3 stream 1)", () => {
    function mockSecurity(
      firewall: { installed: boolean; active: boolean },
      fail2ban: { installed: boolean; active: boolean },
    ) {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "security_get_status") return { firewall, fail2ban };
        return null;
      });
    }

    /** Locate the sub-tile that carries `name` (e.g. "Брандмауэр") and assert its label. */
    function tileLabel(securityCard: HTMLElement, name: string): string {
      const nameNode = within(securityCard).getByText(name);
      // tile = <div><div>{name}</div><div>{label}</div></div>
      const tile = nameNode.parentElement as HTMLElement;
      const labelNode = tile.children[1] as HTMLElement;
      return labelNode.textContent ?? "";
    }

    it("firewall active + fail2ban inactive: shows 'Активен' / 'Выключен'", async () => {
      mockSecurity({ installed: true, active: true }, { installed: true, active: false });
      const state = makeState();
      render(<OverviewSection state={state} />);
      const securityCard = cardOf("server.overview.cards.security");
      await waitFor(() => {
        expect(tileLabel(securityCard, i18n.t("server.overview.security.firewall")))
          .toBe(i18n.t("server.overview.security.active"));
      });
      expect(tileLabel(securityCard, i18n.t("server.overview.security.fail2ban")))
        .toBe(i18n.t("server.overview.security.inactive"));
    });

    it("firewall not-installed: shows 'Не установлен'", async () => {
      mockSecurity({ installed: false, active: false }, { installed: true, active: true });
      const state = makeState();
      render(<OverviewSection state={state} />);
      const securityCard = cardOf("server.overview.cards.security");
      await waitFor(() => {
        expect(tileLabel(securityCard, i18n.t("server.overview.security.firewall")))
          .toBe(i18n.t("server.overview.security.notInstalled"));
      });
      expect(tileLabel(securityCard, i18n.t("server.overview.security.fail2ban")))
        .toBe(i18n.t("server.overview.security.active"));
    });

    it("skeleton: while security_get_status is in flight, no firewall/fail2ban label text shows", async () => {
      // Deferred security status → securityLoading stays true → skeleton branch.
      let releaseSecurity: (v: unknown) => void = () => {};
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "security_get_status") {
          return new Promise((resolve) => { releaseSecurity = resolve; });
        }
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      const securityCard = cardOf("server.overview.cards.security");
      // Skeleton branch renders 3 placeholder tiles — no firewall/fail2ban
      // NAMES (those only render in the loaded grid). Title still shows.
      expect(
        within(securityCard).getByText(i18n.t("server.overview.cards.security")),
      ).toBeInTheDocument();
      expect(
        within(securityCard).queryByText(i18n.t("server.overview.security.firewall")),
      ).not.toBeInTheDocument();
      expect(
        within(securityCard).queryByText(i18n.t("server.overview.security.fail2ban")),
      ).not.toBeInTheDocument();
      // Release so the loaded grid renders and act() flush settles.
      await act(async () => {
        releaseSecurity({ firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } });
      });
      await waitFor(() => {
        expect(
          within(securityCard).getByText(i18n.t("server.overview.security.firewall")),
        ).toBeInTheDocument();
      });
    });

    it("refetches security_get_status on a tt:security-changed window event", async () => {
      let securityCalls = 0;
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "security_get_status") {
          securityCalls++;
          return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } };
        }
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      await waitFor(() => { expect(securityCalls).toBeGreaterThanOrEqual(1); });
      const callsAfterMount = securityCalls;
      // Cross-component change signal — SecuritySection / FirewallModal /
      // Fail2banModal dispatch this after every toggle.
      await act(async () => {
        window.dispatchEvent(new Event("tt:security-changed"));
      });
      await waitFor(() => {
        expect(securityCalls).toBe(callsAfterMount + 1);
      });
    });
  });

  describe("Security card — TLS sub-tile day-bands (RESEARCH §3 stream 1)", () => {
    /**
     * Read the TLS tile label inside the Security card AFTER the loaded grid
     * renders. The TLS tile only mounts once securityLoading flips false (the
     * skeleton branch shows placeholder tiles with no sub-tile names), so the
     * helper waits for the "TLS" name to appear before reading its label.
     */
    async function tlsLabel(): Promise<string> {
      const securityCard = cardOf("server.overview.cards.security");
      const tlsName = await within(securityCard).findByText(
        i18n.t("server.overview.security.tls"),
      );
      const tile = tlsName.parentElement as HTMLElement;
      return (tile.children[1] as HTMLElement).textContent ?? "";
    }

    it("no-cert: TLS tile shows '—' placeholder when certRaw is null", async () => {
      const state = makeState({ certRaw: null } as Partial<ServerState>);
      render(<OverviewSection state={state} />);
      expect(await tlsLabel()).toBe(i18n.t("server.overview.security.placeholder"));
    });

    it("ok: TLS tile shows '{N} дн.' for a cert well in the future (>14 days)", async () => {
      const state = makeState({ certRaw: makeCertRaw(40) } as Partial<ServerState>);
      render(<OverviewSection state={state} />);
      // daysUntil uses Math.ceil → ~40 or 41 days; assert the days-label shape.
      const label = await tlsLabel();
      expect(label).toMatch(/\d+\s*дн\./);
      expect(label).not.toBe(i18n.t("server.overview.security.tlsExpired"));
      expect(label).not.toBe(i18n.t("server.overview.security.placeholder"));
    });

    it("warning: TLS tile shows '{N} дн.' for a cert 8–14 days out", async () => {
      const state = makeState({ certRaw: makeCertRaw(10) } as Partial<ServerState>);
      render(<OverviewSection state={state} />);
      // Warning band shares the "{N} дн." label (only colour differs — not
      // assertable per D-04). Pin the label shape + that it's not expired.
      const label = await tlsLabel();
      expect(label).toMatch(/\d+\s*дн\./);
      expect(label).not.toBe(i18n.t("server.overview.security.tlsExpired"));
    });

    it("expired: TLS tile shows 'Истёк' for a past-due cert", async () => {
      const state = makeState({ certRaw: makeCertRaw(-2) } as Partial<ServerState>);
      render(<OverviewSection state={state} />);
      expect(await tlsLabel()).toBe(i18n.t("server.overview.security.tlsExpired"));
    });
  });

  describe("fastUptime poller (G-01, RESEARCH §3 stream 1)", () => {
    it("fires server_get_uptime immediately on mount when service is active", async () => {
      let uptimeInvokes = 0;
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "server_get_uptime") { uptimeInvokes++; return { uptime_seconds: 3661 }; }
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      // G-01: immediate first fire (not waiting for the 10s interval).
      await waitFor(() => { expect(uptimeInvokes).toBeGreaterThanOrEqual(1); });
    });

    it("prefers fastUptime value over stats: shows the server_get_uptime result", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        // stats says 1д 1ч (90061s); fast uptime says 1ч 1м (3661s).
        if (cmd === "server_get_stats") return {
          cpu_percent: 1, load_1m: 0, load_5m: 0, load_15m: 0,
          mem_total: 1, mem_used: 0, disk_total: 1, disk_used: 0,
          unique_ips: 0, total_connections: 0, uptime_seconds: 90061,
        };
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "server_get_uptime") return { uptime_seconds: 3661 };
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      const uptimeCard = cardOf("server.overview.cards.uptime");
      // 3661s → "1ч 1м" (hoursMins) from fastUptime, taking priority over stats.
      const fast = i18n.t("server.overview.uptimeFormat.hoursMins", { hours: 1, mins: 1 });
      await waitFor(() => {
        expect(within(uptimeCard).getByText(fast)).toBeInTheDocument();
      });
    });
  });

  describe("Drill-down by CLICK (RESEARCH §3 stream 1 — was keyboard-only)", () => {
    it("version card CLICK navigates to the 'service' tab (Phase 19 target)", () => {
      const onNavigate = vi.fn();
      const state = makeState();
      render(<OverviewSection state={state} onNavigate={onNavigate} />);
      const versionTitle = screen.getByText(i18n.t("server.overview.cards.protocolVersion"));
      const card = versionTitle.closest('[role="button"]');
      expect(card).not.toBeNull();
      fireEvent.click(card!);
      expect(onNavigate).toHaveBeenCalledWith("service");
    });

    it("security card CLICK navigates to the 'security' tab", () => {
      const onNavigate = vi.fn();
      const state = makeState();
      render(<OverviewSection state={state} onNavigate={onNavigate} />);
      const securityTitle = screen.getByText(i18n.t("server.overview.cards.security"));
      const card = securityTitle.closest('[role="button"]');
      expect(card).not.toBeNull();
      fireEvent.click(card!);
      expect(onNavigate).toHaveBeenCalledWith("security");
    });
  });

  // ═══════════════════════════════════════════════════════
  // Plan 04-14 — Overview bug cluster (each regression-test-first).
  // Fixes C-01 (refetchSecurity stale closure / double-fire),
  // H-01/SAFETY-02 (password spread into server_get_uptime IPC),
  // C-02 (silent reboot-timeout credential drop with no user error).
  // These FAIL on the pre-fix code and PASS after.
  // ═══════════════════════════════════════════════════════

  describe("C-01: refetchSecurity stable / single-fire (Plan 04-14)", () => {
    it("uses the CURRENT sshParams (not a stale closure) when a tt:security-changed event fires after a non-host param change", async () => {
      // Pre-fix bug: `refetchSecurity` was a plain (non-memoized) function and
      // the window-listener effect suppressed it from its deps, re-registering
      // only on [sshParams.host, serviceActive, rebooting]. So when a NON-host
      // SSH param changed (e.g. the SSH port after a port change), the listener
      // kept a stale closure that invoked security_get_status with the OLD port.
      // The useCallback/depend-on-primitives fix re-registers the listener when
      // ANY primitive changes, so the event refetches with the CURRENT params.
      const portsSeen: number[] = [];
      vi.mocked(invoke).mockImplementation(async (cmd: string, params?: unknown) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "server_get_uptime") return { uptime_seconds: 1 };
        if (cmd === "security_get_status") {
          portsSeen.push((params as { port: number }).port);
          return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } };
        }
        return null;
      });
      const state = makeState({ sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass", keyPath: undefined } });
      const { rerender } = render(<OverviewSection state={state} />);
      await waitFor(() => { expect(portsSeen.length).toBeGreaterThanOrEqual(1); });

      // SSH port changes (host unchanged) — mirrors a security_change_ssh_port flow.
      const stateNewPort = makeState({ sshParams: { host: "10.0.0.1", port: 2222, user: "root", password: "pass", keyPath: undefined } });
      rerender(<OverviewSection state={stateNewPort} />);

      await act(async () => {
        window.dispatchEvent(new Event("tt:security-changed"));
      });
      // The refetch triggered by the event MUST use the new port (2222), proving
      // the listener closure is no longer stale.
      await waitFor(() => {
        expect(portsSeen).toContain(2222);
      });
    });

    it("does not double-fire security_get_status on a single StrictMode mount", async () => {
      // Pre-fix: the misleading 'ref-like' eslint-disable comments masked that
      // refetchSecurity was re-created every render; under StrictMode the
      // initial-load effect + listener effect could each fire an extra
      // security_get_status against the same SSH channel. The
      // useCallback/depend-on-primitives form keeps a single stable identity so
      // the effect set is registered once per primitive set.
      let securityCalls = 0;
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "server_get_uptime") return { uptime_seconds: 1 };
        if (cmd === "security_get_status") { securityCalls++; return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } }; }
        return null;
      });
      const state = makeState();
      render(
        <StrictMode>
          <OverviewSection state={state} />
        </StrictMode>,
      );
      await waitFor(() => { expect(securityCalls).toBeGreaterThanOrEqual(1); });
      // Give any stray double-mount effect a tick to fire.
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      expect(securityCalls).toBe(1);
    });
  });

  describe("H-01 / SAFETY-02: sshParams not spread wholesale into server_get_uptime IPC (Plan 04-14)", () => {
    it("forwards ONLY the 5 SSH fields — extra metadata keys (which could carry the secret) are not spread", async () => {
      // Pre-fix: `invoke("server_get_uptime", sshParams)` spread the ENTIRE
      // sshParams object — whose `[key: string]: unknown` index signature lets
      // callers attach arbitrary metadata — into every uptime poll's IPC args.
      // That bypasses the type-level guarantee that only the 5 SSH fields reach
      // Rust, and risks leaking a secret carried in an unexpected key. The fix
      // forwards an explicit { host, port, user, password, keyPath } picked
      // subset. D-29 assertion: an extra `secretSidecar` key (carrying the
      // password value) must NEVER appear in the IPC args.
      const SECRET = "TOPSECRET_UPTIME_PW";
      const uptimeArgs: Array<Record<string, unknown>> = [];
      vi.mocked(invoke).mockImplementation(async (cmd: string, params?: unknown) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "security_get_status") return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } };
        if (cmd === "server_get_uptime") {
          uptimeArgs.push((params ?? {}) as Record<string, unknown>);
          return { uptime_seconds: 3661 };
        }
        return null;
      });
      // sshParams carries an extra non-SSH key holding the secret (allowed by the
      // index signature) — the pre-fix full-object spread would forward it.
      const state = makeState({
        // Cast: the real sshParams type lists the 5 SSH fields, but the runtime
        // object has an index signature ([key: string]: unknown) that lets extra
        // metadata attach — which is exactly the leak surface under test.
        sshParams: {
          host: "10.0.0.1",
          port: 22,
          user: "root",
          password: SECRET,
          keyPath: undefined,
          secretSidecar: SECRET,
        } as unknown as ServerState["sshParams"],
      });
      render(<OverviewSection state={state} />);
      await waitFor(() => { expect(uptimeArgs.length).toBeGreaterThanOrEqual(1); });
      for (const args of uptimeArgs) {
        // The extra metadata key (and its secret payload) must not be forwarded.
        expect(args).not.toHaveProperty("secretSidecar");
        // The arg surface is exactly the 5 picked SSH fields — no extra keys.
        expect(Object.keys(args).sort()).toEqual(
          ["host", "keyPath", "password", "port", "user"].sort(),
        );
        // The secret appears ONLY via the legitimate `password` field (needed to
        // open the SSH channel) — never duplicated into any other arg key.
        for (const [k, v] of Object.entries(args)) {
          if (k === "password") continue;
          expect(String(v)).not.toContain(SECRET);
        }
      }
    });
  });

  describe("C-02: reboot poller surfaces an honest error on timeout (Plan 04-14)", () => {
    it("pushes an error notification + logs it instead of silently dropping the server when the 120s reboot poll times out", async () => {
      vi.useFakeTimers();
      try {
        const logged: Array<{ tag: string; message: string }> = [];
        vi.mocked(invoke).mockImplementation(async (cmd: string, params?: unknown) => {
          if (cmd === "ping_endpoint") return 42;
          if (cmd === "server_get_stats") return null;
          if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
          if (cmd === "server_get_uptime") return { uptime_seconds: 1 };
          if (cmd === "security_get_status") return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } };
          // The reboot poll keeps failing → drives the elapsed>=120 timeout path.
          if (cmd === "check_server_installation") throw new Error("still rebooting");
          if (cmd === "clear_ssh_credentials") return null;
          if (cmd === "write_activity_log") {
            const p = params as { tag: string; message: string };
            logged.push({ tag: p.tag, message: p.message });
          }
          return null;
        });
        const pushSuccess = vi.fn();
        const state = makeState({ rebooting: true, pushSuccess });
        render(<OverviewSection state={state} />);

        // Advance through the full 120s reboot-timeout window (12 × 10s ticks).
        await act(async () => {
          for (let i = 0; i < 13; i++) {
            await vi.advanceTimersByTimeAsync(10_000);
          }
        });

        // Pre-fix: nothing user-visible fired — clear_ssh_credentials silently
        // dropped the server. Post-fix: an honest error toast + an ERROR log.
        expect(pushSuccess).toHaveBeenCalledWith(
          i18n.t("server.overview.rebootTimeout"),
          "error",
        );
        expect(
          logged.some((e) => e.tag === "ERROR" && e.message.includes("overview.reboot.timeout")),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("H-03 / L-03: serverInfo-null skeleton matches the loaded layout (Plan 04-14, D-04)", () => {
    it("renders exactly 3 Security skeleton sub-tiles in the pre-data (serverInfo===null) branch", () => {
      // Pre-fix: this branch rendered [1,2,3,4] = 4 tiles, while the loaded
      // Security card renders 3 (Firewall / Fail2Ban / TLS). That produced a
      // 4→3 layout jump the moment serverInfo arrived. The fix aligns both
      // skeleton paths to 3 (D-04 — skeleton must mirror the loaded layout).
      const state = makeState({ serverInfo: null });
      render(<OverviewSection state={state} />);
      expect(screen.getAllByTestId("security-skeleton-tile")).toHaveLength(3);
    });

    it("renders all 10 card titles in the pre-data skeleton (L-03 — same card set as loaded)", () => {
      const state = makeState({ serverInfo: null });
      render(<OverviewSection state={state} />);
      const cardKeys = [
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
      for (const key of cardKeys) {
        expect(screen.getByText(i18n.t(key))).toBeInTheDocument();
      }
    });
  });
});
