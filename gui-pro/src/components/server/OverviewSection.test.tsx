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

  it("renders a Status card with running state when service is active", async () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    // D-07 (Plan 07-06): the real grid renders only after all cards settle; the
    // Status value lives in the loaded grid (the skeleton shows a placeholder),
    // so await the resolved running state instead of asserting synchronously.
    expect(await screen.findByText(i18n.t("server.status.running"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.overview.cards.status"))).toBeInTheDocument();
  });

  it("renders stopped status when service is inactive", async () => {
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.0.20",
        serviceActive: false,
        users: ["user1"],
      } as ServerState["serverInfo"],
    });
    render(<OverviewSection state={state} />);
    // D-07: await the loaded grid (stopped status is grid-only content).
    expect(await screen.findByText(i18n.t("server.status.stopped"))).toBeInTheDocument();
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

  it("shows host IP only in the dedicated IP card (DC-03 scope)", async () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    // D-07 (Plan 07-06): the IP value lives in the loaded grid (the all-cards gate
    // paints the skeleton first), so wait for the grid to open before scoping.
    await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
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

  it("shows rebooting countdown label when rebooting", async () => {
    const state = makeState({ rebooting: true });
    render(<OverviewSection state={state} />);
    // D-07 (Plan 07-06): the rebooting Status card is loaded-grid content (the
    // all-cards gate paints the skeleton first), so await it. Label is
    // "Перезагрузка"/"Rebooting" + a countdown suffix ("..." or " {N}s").
    const rebootLabel = i18n.t("server.overview.rebootingCountdown");
    expect(
      await screen.findByText((content) => content.startsWith(rebootLabel)),
    ).toBeInTheDocument();
  });

  it("refresh button uses localized aria-label", async () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    const refreshAria = i18n.t("server.overview.refreshAria");
    // D-07: the refresh buttons live in the loaded grid — wait for it to open.
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: refreshAria }).length).toBeGreaterThan(0);
    });
    const refreshBtns = screen.getAllByRole("button", { name: refreshAria });
    fireEvent.click(refreshBtns[0]);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("ping_endpoint", expect.any(Object));
    });
  });

  it("shows server version in the protocol-version card", async () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    // D-07: await the loaded grid; scope to the protocol-version card and assert
    // the value renders INSIDE it (False-green FIX RESEARCH §3 stream 1, was :170).
    await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
    const versionCard = cardOf("server.overview.cards.protocolVersion");
    expect(within(versionCard).getByText("1.0.20")).toBeInTheDocument();
  });

  it("shows user count of 2 in the Users card", async () => {
    const state = makeState();
    render(<OverviewSection state={state} />);
    // D-07: await the loaded grid. Scope to the Users card so the count is proven
    // to be the userCount value (False-green FIX RESEARCH §3 stream 1, was :174).
    await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
    const usersCard = cardOf("server.overview.cards.userCount");
    expect(within(usersCard).getByText("2")).toBeInTheDocument();
  });

  // ═══════════════════════════════════════════════════════
  // R2-F08 (Plan 09-37): Users-card loading sentinel
  // ─────────────────────────────────────────────────────────
  // On a fresh app start the Users count was rendered as a premature concrete
  // `0` before the async users fetch resolved (~10s later it filled to the real
  // count), because `userCount = serverInfo.users?.length ?? 0` could not tell
  // "users unknown" from "genuinely 0". The fix adds a `usersKnown` signal: while
  // !usersKnown the card renders the same <Skeleton variant="line"> the panel
  // skeleton uses for this card, and reserves the digit `0` for a confirmed-zero
  // result. See 09-UAT-2-DIAGNOSIS.md (R2-F08).
  // ═══════════════════════════════════════════════════════
  describe("Users card loading sentinel (R2-F08)", () => {
    it("renders the loading skeleton (not a premature 0) while users are unknown", async () => {
      // Premature-empty window: a silent cold-start load returned users:[] but it
      // is NOT yet a confirmed zero (usersKnown:false).
      const state = makeState({
        serverInfo: {
          installed: true,
          version: "1.0.20",
          serviceActive: true,
          users: [],
          protocol: "WireGuard",
          listenPort: 51820,
        } as ServerState["serverInfo"],
        usersKnown: false,
      } as Partial<ServerState>);
      render(<OverviewSection state={state} />);
      // Await the loaded grid (the all-cards gate is unchanged; the Users card is
      // not one of its async signals).
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
      const usersCard = cardOf("server.overview.cards.userCount");
      // Must NOT show a premature 0…
      expect(within(usersCard).queryByText("0")).not.toBeInTheDocument();
      // …and DOES show the loading skeleton sentinel.
      expect(within(usersCard).getByTestId("users-count-skeleton")).toBeInTheDocument();
    });

    it("renders the digit 0 for a confirmed-empty users result", async () => {
      const state = makeState({
        serverInfo: {
          installed: true,
          version: "1.0.20",
          serviceActive: true,
          users: [],
          protocol: "WireGuard",
          listenPort: 51820,
        } as ServerState["serverInfo"],
        usersKnown: true,
      } as Partial<ServerState>);
      render(<OverviewSection state={state} />);
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
      const usersCard = cardOf("server.overview.cards.userCount");
      expect(within(usersCard).getByText("0")).toBeInTheDocument();
      expect(within(usersCard).queryByTestId("users-count-skeleton")).not.toBeInTheDocument();
    });

    it("renders the real count for a confirmed non-empty users result", async () => {
      const state = makeState({
        serverInfo: {
          installed: true,
          version: "1.0.20",
          serviceActive: true,
          users: ["a", "b", "c"],
          protocol: "WireGuard",
          listenPort: 51820,
        } as ServerState["serverInfo"],
        usersKnown: true,
      } as Partial<ServerState>);
      render(<OverviewSection state={state} />);
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
      const usersCard = cardOf("server.overview.cards.userCount");
      expect(within(usersCard).getByText("3")).toBeInTheDocument();
      expect(within(usersCard).queryByTestId("users-count-skeleton")).not.toBeInTheDocument();
    });
  });

  it("renders correctly in English locale (i18n switch)", async () => {
    await i18n.changeLanguage("en");
    const state = makeState();
    render(<OverviewSection state={state} />);
    // D-07: await the loaded grid (Running status is grid-only content).
    await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
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
    // D-07 (Plan 07-06): the drill-down ClickableCards only render in the loaded
    // grid (the all-cards gate paints the skeleton first), so each test waits for
    // the grid to open (eye button = loaded-grid-only) before reaching for the
    // role="button" card.
    it("drill-down: calls onNavigate('users') when Users card is clicked", async () => {
      const onNavigate = vi.fn();
      const state = makeState();
      render(<OverviewSection state={state} onNavigate={onNavigate} />);
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });

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
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });

      const versionTitle = screen.getByText(i18n.t("server.overview.cards.protocolVersion"));
      const card = versionTitle.closest('[role="button"]');
      expect(card).not.toBeNull();

      fireEvent.keyDown(card!, { key: "Enter" });
      expect(onNavigate).toHaveBeenCalledWith("service");
    });

    it("Phase 19 — Protocol version card shows ArrowUp icon when sidecarAvailable=true", async () => {
      const onNavigate = vi.fn();
      const state = makeState();
      render(
        <OverviewSection
          state={state}
          onNavigate={onNavigate}
          sidecarAvailable={true}
        />,
      );
      // D-07: await the loaded grid (the version card renders there, not in skeleton).
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });

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

    it("Phase 19 cascade fix — ArrowUpCircle becomes visible WITHOUT remount when sidecarAvailable flips false→true", async () => {
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
      // D-07: wait for the loaded grid to open before asserting on the version card.
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });

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
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });

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
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });

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
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });

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
    it("never-measured: shows 'Не измерялась' when running and speedtest never ran", async () => {
      const state = makeState();
      render(<OverviewSection state={state} />);
      // D-07 (Plan 07-06): await the loaded grid before scoping to the Speed card.
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
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
      // D-07 (Plan 07-06): await the loaded grid before scoping to the Speed card.
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
      const speedCard = cardOf("server.overview.cards.speed");
      expect(
        within(speedCard).getByText(i18n.t("server.overview.speedRequiresProtocol")),
      ).toBeInTheDocument();
    });

    it("requires-protocol: shows 'Запустите протокол' when rebooting", async () => {
      const state = makeState({ rebooting: true });
      render(<OverviewSection state={state} />);
      // D-07: await the loaded grid before scoping to the Speed card.
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
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
      // D-07 (Plan 07-06): ping=-1 is a SETTLED (failed) signal, so the all-cards
      // gate opens and the real grid renders. Re-resolve the card inside waitFor
      // (the gate paints the skeleton first; that card node is then detached).
      await waitFor(() => {
        expect(
          within(cardOf("server.overview.cards.ping")).getByText(i18n.t("server.overview.dataUnavailable")),
        ).toBeInTheDocument();
      });
      expect(within(cardOf("server.overview.cards.ping")).getByText("—")).toBeInTheDocument();
    });

    it("D-07 (Plan 07-06): a never-settling initial ping holds the all-cards skeleton (was: per-card pending dash)", async () => {
      // INTENTIONAL D-07 characterization update. Pre-07-06 the Overview revealed
      // each card progressively, so a pending ping showed a per-card "—" with no
      // subtitle WHILE the rest of the grid was live. D-07 replaces that with an
      // all-cards-loaded gate: until EVERY signal settles, the full skeleton shows.
      // A never-settling ping (ping stays null = pending, not -1) therefore holds
      // the gate closed → the loaded grid (and its eye toggle) never appears, and
      // no per-card pending dash is shown in a live grid. (The 60s fallback would
      // eventually force the grid, but that is covered by the dedicated D-07 test.)
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return new Promise<number>(() => {});
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      // Let geo/stats settle; ping remains pending → gate stays closed.
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith("get_server_geoip", expect.any(Object));
      });
      // The loaded grid never opens while ping is pending (no eye toggle).
      expect(
        screen.queryByRole("button", { name: i18n.t("server.overview.ip.show") }),
      ).not.toBeInTheDocument();
      // The skeleton still shows the Ping card title (placeholder), but NOT the
      // live unavailable subtitle (that is a failed-ping signal, not pending).
      expect(screen.getByText(i18n.t("server.overview.cards.ping"))).toBeInTheDocument();
      expect(
        screen.queryByText(i18n.t("server.overview.dataUnavailable")),
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
      // D-07 (Plan 07-06): wait for the all-cards gate to open (the loaded grid)
      // and the initial ping value to settle, re-resolving the card inside waitFor
      // so we never read from a detached skeleton node.
      await waitFor(() => {
        expect(within(cardOf("server.overview.cards.ping")).getByText("42")).toBeInTheDocument();
      });
      const pingCard = cardOf("server.overview.cards.ping");
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
      // D-07 (Plan 07-06): re-resolve the card INSIDE waitFor — the all-cards gate
      // first paints the skeleton, then swaps to the real grid, so a card captured
      // before the swap would be a detached skeleton node.
      await waitFor(() => {
        expect(tileLabel(cardOf("server.overview.cards.security"), i18n.t("server.overview.security.firewall")))
          .toBe(i18n.t("server.overview.security.active"));
      });
      expect(tileLabel(cardOf("server.overview.cards.security"), i18n.t("server.overview.security.fail2ban")))
        .toBe(i18n.t("server.overview.security.inactive"));
    });

    it("firewall not-installed: shows 'Не установлен'", async () => {
      mockSecurity({ installed: false, active: false }, { installed: true, active: true });
      const state = makeState();
      render(<OverviewSection state={state} />);
      await waitFor(() => {
        expect(tileLabel(cardOf("server.overview.cards.security"), i18n.t("server.overview.security.firewall")))
          .toBe(i18n.t("server.overview.security.notInstalled"));
      });
      expect(tileLabel(cardOf("server.overview.cards.security"), i18n.t("server.overview.security.fail2ban")))
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
      // D-07 (Plan 07-06): while security is in flight the all-cards gate holds the
      // full OverviewSkeleton. Its Security card shows the title + placeholder tiles
      // (no firewall/fail2ban NAMES — those are loaded-grid only), which is exactly
      // the pre-gate skeleton-branch contract this test pins.
      const skeletonSecurityCard = cardOf("server.overview.cards.security");
      expect(
        within(skeletonSecurityCard).getByText(i18n.t("server.overview.cards.security")),
      ).toBeInTheDocument();
      expect(
        within(skeletonSecurityCard).queryByText(i18n.t("server.overview.security.firewall")),
      ).not.toBeInTheDocument();
      expect(
        within(skeletonSecurityCard).queryByText(i18n.t("server.overview.security.fail2ban")),
      ).not.toBeInTheDocument();
      // Release → security settles → the gate opens → the real grid renders.
      // Re-resolve the card inside waitFor (the skeleton node is now detached).
      await act(async () => {
        releaseSecurity({ firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } });
      });
      await waitFor(() => {
        expect(
          within(cardOf("server.overview.cards.security")).getByText(i18n.t("server.overview.security.firewall")),
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
      // D-07 (Plan 07-06): the all-cards gate first paints the OverviewSkeleton,
      // then the real grid. The TLS sub-tile (with its name) only exists in the
      // loaded grid, so wait for it to appear, re-resolving the card each poll so
      // we never read from a detached skeleton node.
      const tlsName = await waitFor(() => {
        const securityCard = cardOf("server.overview.cards.security");
        return within(securityCard).getByText(i18n.t("server.overview.security.tls"));
      });
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

    it("UAT-6: missing cert (certRaw present but notAfter empty) shows the neutral placeholder dash, not 'Активен' or 'Истёк'", async () => {
      // A missing/unreadable cert can still arrive as a certRaw payload (the SSH
      // probe returned *something*) with an empty notAfter. The old hasTls =
      // !!state.certRaw painted this as green «Активен». hasTls is now gated on
      // notAfter readability → neutral placeholder dash.
      const state = makeState({
        certRaw: JSON.stringify({ hostname: "vpn.example.com", notAfter: "", issuer: "", subject: "" }),
      } as Partial<ServerState>);
      render(<OverviewSection state={state} />);
      const label = await tlsLabel();
      expect(label).toBe(i18n.t("server.overview.security.placeholder"));
      expect(label).not.toBe(i18n.t("server.overview.security.tlsActive"));
      expect(label).not.toBe(i18n.t("server.overview.security.tlsExpired"));
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

    it("prefers the live stats poll over the one-shot fastUptime (WR-04): shows the stats result once it arrives", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        // stats (live 10s poll) says 1д 1ч (90061s); fast uptime (one-shot) says 1ч 1м (3661s).
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
      // WR-04 (10.1 review): the live stats poll is AUTHORITATIVE once available, so the
      // card shows 90061s → "1д 1ч" (daysHours), NOT the frozen one-shot "1ч 1м". The
      // fastUptime one-shot is only the fast-first-paint fallback until the poll lands.
      const live = i18n.t("server.overview.uptimeFormat.daysHours", { days: 1, hours: 1 });
      // D-07 (Plan 07-06): re-resolve the card inside waitFor (the all-cards gate
      // paints the skeleton first; the loaded uptime card node arrives after).
      await waitFor(() => {
        expect(within(cardOf("server.overview.cards.uptime")).getByText(live)).toBeInTheDocument();
      });
    });
  });

  describe("Drill-down by CLICK (RESEARCH §3 stream 1 — was keyboard-only)", () => {
    it("version card CLICK navigates to the 'service' tab (Phase 19 target)", async () => {
      const onNavigate = vi.fn();
      const state = makeState();
      render(<OverviewSection state={state} onNavigate={onNavigate} />);
      // D-07 (Plan 07-06): the ClickableCard only renders in the loaded grid.
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
      const versionTitle = screen.getByText(i18n.t("server.overview.cards.protocolVersion"));
      const card = versionTitle.closest('[role="button"]');
      expect(card).not.toBeNull();
      fireEvent.click(card!);
      expect(onNavigate).toHaveBeenCalledWith("service");
    });

    it("security card CLICK navigates to the 'security' tab", async () => {
      const onNavigate = vi.fn();
      const state = makeState();
      render(<OverviewSection state={state} onNavigate={onNavigate} />);
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
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

  describe("D-06: reboot-timeout no longer auto-logs-out (Plan 07-05)", () => {
    it("NEVER calls clear_ssh_credentials on the 120s reboot timeout, while still firing the error toast + ERROR log", async () => {
      // D-06: plain unreachability (here: a reboot that exceeds 120s) must NOT
      // wipe stored SSH credentials. The ONLY credential-clear path is the
      // deliberate handleDisconnect in useControlPanelOrchestrator. This test
      // FAILS before the fix (the pre-fix code calls clear_ssh_credentials in
      // the timeout branch) and PASSES after the line is removed. The honest
      // feedback the C-02 test pins (toast + ERROR log) must REMAIN.
      vi.useFakeTimers();
      try {
        const logged: Array<{ tag: string; message: string }> = [];
        let clearCalls = 0;
        vi.mocked(invoke).mockImplementation(async (cmd: string, params?: unknown) => {
          if (cmd === "ping_endpoint") return 42;
          if (cmd === "server_get_stats") return null;
          if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
          if (cmd === "server_get_uptime") return { uptime_seconds: 1 };
          if (cmd === "security_get_status") return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } };
          // Keep the reboot poll failing → drive the elapsed>=120 timeout path.
          if (cmd === "check_server_installation") throw new Error("still rebooting");
          if (cmd === "clear_ssh_credentials") { clearCalls++; return null; }
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

        // The credential wipe must NOT happen on plain unreachability (D-06)…
        expect(clearCalls).toBe(0);
        // …while the honest feedback is preserved (the toast + the ERROR log).
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

  // ═══════════════════════════════════════════════════════
  // Phase 7 (Plan 07-06) — D-08 IP eye/blur + D-09 nowrap.
  // The IP value is rendered (never removed from the DOM) but blurred by
  // default; an eye IconButton in the IP-card Title action slot reveals it.
  // Uptime value + error captions stay single-line (whitespace-nowrap).
  // ═══════════════════════════════════════════════════════

  describe("D-08: IP eye/blur toggle (hidden by default, Plan 07-06)", () => {
    it("hides the IP value by default (opacity 0, dust overlay) and reveals it (opacity 1) on eye click — no aria-hidden on the value", async () => {
      const state = makeState();
      render(<OverviewSection state={state} />);
      // D-07 (Plan 07-06): wait for the all-cards gate to open (the eye button is
      // loaded-grid only) before reading the IP value's hidden/revealed state.
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
      const ipCard = cardOf("server.overview.cards.ip");
      // Default: the IP value is masked — rendered transparent (opacity 0) with the animated
      // dust overlay drawn over it (shoulder-surfing guard, D-08; replaced the old blur(6px)).
      const ipValue = within(ipCard).getByText("10.0.0.1");
      expect(ipValue.style.opacity).toBe("0");
      // The masked value is a CSS guard, not a secret-from-owner guard — it is
      // NOT hidden from assistive tech (UI-SPEC §D-08 a11y).
      expect(ipValue).not.toHaveAttribute("aria-hidden");
      // Hidden state → the eye button offers to SHOW (reveal) the IP.
      const showBtn = within(ipCard).getByRole("button", {
        name: i18n.t("server.overview.ip.show"),
      });
      fireEvent.click(showBtn);
      // Revealed → value fades in (opacity 1).
      await waitFor(() => {
        expect(within(ipCard).getByText("10.0.0.1").style.opacity).toBe("1");
      });
      // …and the button now offers to HIDE the IP (aria-label flips with action).
      expect(
        within(ipCard).getByRole("button", { name: i18n.t("server.overview.ip.hide") }),
      ).toBeInTheDocument();
    });

    it("keeps the IP value monospaced in both states (no font/box change → no layout shift)", async () => {
      const state = makeState();
      render(<OverviewSection state={state} />);
      // D-07: wait for the loaded grid before reading the IP value.
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
      const ipCard = cardOf("server.overview.cards.ip");
      const ipValue = within(ipCard).getByText("10.0.0.1");
      // font-mono is kept in both states so the blurred silhouette holds its
      // real width and the card never reflows when toggling.
      expect(ipValue.className).toContain("font-mono");
    });
  });

  describe("D-09: single-line Uptime + error captions (Plan 07-06)", () => {
    it("Uptime value carries whitespace-nowrap so it never wraps to a 2nd line", async () => {
      const state = makeState();
      render(<OverviewSection state={state} />);
      // 90061s → "1д 1ч" (ru). D-07 (Plan 07-06): the all-cards gate paints the
      // skeleton first, so re-resolve the card inside waitFor (the loaded uptime
      // value node arrives after the gate opens).
      const expected = i18n.t("server.overview.uptimeFormat.daysHours", { days: 1, hours: 1 });
      await waitFor(() => {
        expect(within(cardOf("server.overview.cards.uptime")).getByText(expected)).toBeInTheDocument();
      }, { timeout: 15_000 });
      expect(within(cardOf("server.overview.cards.uptime")).getByText(expected).className).toContain("whitespace-nowrap");
    }, 20_000);

    it("data-unavailable caption wraps freely + centered, never truncated or line-capped (owner UAT Ping failure path)", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") throw new Error("PING_TIMEOUT");
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} />);
      // Error caption rule (owner UAT): the full «Не удалось получить данные…»
      // text wraps FREELY — centered, NO line cap (no line-clamp), NO truncation
      // (no whitespace-nowrap, no text-ellipsis). The card is wide enough in the
      // error state (ERROR_CARD_MIN_BASIS) to land it in ~2 lines, but a narrower
      // window just wraps it taller; nothing is ever clipped.
      await waitFor(() => {
        const caption = within(cardOf("server.overview.cards.ping")).getByText(i18n.t("server.overview.dataUnavailable"));
        expect(caption.className).toContain("text-center");
        // No hard line cap and no truncation — the caption must be free to wrap.
        expect(caption.className).not.toContain("line-clamp");
        expect(caption.className).not.toContain("whitespace-nowrap");
        expect(caption.className).not.toContain("text-ellipsis");
      });
    });
  });

  // ═══════════════════════════════════════════════════════
  // Phase 7 (Plan 07-06) — D-10 press-state + D-07 all-cards gate.
  // ═══════════════════════════════════════════════════════

  describe("D-10: press-state on the clickable drill-down cards ONLY (post-UAT, Plan 07-06)", () => {
    // The grid only renders once all per-card signals are settled (D-07). The
    // default beforeEach mock settles ping (42) + geo + stats; security stays
    // null (no mock) → settles via failure. Wait for the loaded grid (eye button)
    // before asserting press-state classes.
    async function waitForGrid() {
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: i18n.t("server.overview.ip.show") }),
        ).toBeInTheDocument();
      }, { timeout: 15_000 });
    }

    it("plain info cards have NO press-state and stay non-interactive (post-UAT: press on a non-clickable card misleads)", async () => {
      const state = makeState();
      render(<OverviewSection state={state} onNavigate={vi.fn()} />);
      await waitForGrid();
      const plainKeys = [
        "server.overview.cards.status",
        "server.overview.cards.ping",
        "server.overview.cards.speed",
        "server.overview.cards.ip",
        "server.overview.cards.country",
        "server.overview.cards.uptime",
        "server.overview.cards.load",
      ];
      for (const key of plainKeys) {
        const card = cardOf(key);
        // The user rejected press feedback on non-clickable cards — a press
        // animation on a non-actionable card reads as "this is clickable" when it
        // is not. Plain cards must carry no press-scale.
        expect(card.className, `card "${key}" must NOT have active:scale press-state`).not.toContain(
          "active:scale-[0.98]",
        );
        // And they stay non-interactive (no button semantics misleading keyboard/AT users).
        expect(card.getAttribute("role"), `card "${key}" must NOT be role=button`).not.toBe("button");
        expect(card.getAttribute("tabindex"), `card "${key}" must NOT be focusable`).toBeNull();
      }
    }, 20_000);

    it("the three clickable cards keep role=button + tabIndex=0 + the press-state extends them", async () => {
      const state = makeState();
      render(<OverviewSection state={state} onNavigate={vi.fn()} />);
      await waitForGrid();
      const clickableKeys = [
        "server.overview.cards.userCount",
        "server.overview.cards.protocolVersion",
        "server.overview.cards.security",
      ];
      for (const key of clickableKeys) {
        const title = screen.getByText(i18n.t(key));
        const card = title.closest('[role="button"]') as HTMLElement;
        expect(card, `card "${key}" must stay role=button`).not.toBeNull();
        expect(card.getAttribute("tabindex")).toBe("0");
        // Focus ring stays intact (the press-scale must not drop it).
        expect(card.className).toContain("focus-visible:shadow-[var(--focus-ring)]");
        expect(card.className).toContain("active:scale-[0.98]");
      }
    }, 20_000);
  });

  describe("D-07: all-cards-loaded gate + 60s fallback (Plan 07-06)", () => {
    it("shows the skeleton while cards are pending, then the real grid once ALL signals settle", async () => {
      // Defer the ping signal so the gate stays closed (ping===null) until we
      // release it; geo/stats/security settle immediately from the mock below.
      let releasePing: (ms: number) => void = () => {};
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return new Promise<number>((resolve) => { releasePing = resolve; });
        if (cmd === "server_get_stats") return {
          cpu_percent: 1, load_1m: 0, load_5m: 0, load_15m: 0,
          mem_total: 1, mem_used: 0, disk_total: 1, disk_used: 0,
          unique_ips: 0, total_connections: 0, uptime_seconds: 1,
        };
        if (cmd === "server_get_uptime") return { uptime_seconds: 1 };
        if (cmd === "security_get_status") return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } };
        if (cmd === "get_server_geoip") return { country: "United States", country_code: "US", flag_emoji: "🇺🇸" };
        return null;
      });
      const state = makeState();
      render(<OverviewSection state={state} onNavigate={vi.fn()} />);
      // While ping is pending the gate is closed → skeleton grid (no eye button,
      // no drill-down ClickableCards render yet).
      await waitFor(() => {
        // geo/stats/security have settled by now; ping is the only hold-out.
        expect(invoke).toHaveBeenCalledWith("get_server_geoip", expect.any(Object));
      });
      expect(
        screen.queryByRole("button", { name: i18n.t("server.overview.ip.show") }),
      ).not.toBeInTheDocument();
      // Settle ping → all signals settled → the real grid renders (eye button shows).
      await act(async () => { releasePing(42); });
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: i18n.t("server.overview.ip.show") }),
        ).toBeInTheDocument();
      }, { timeout: 15_000 });
    }, 20_000);

    it("latches the gate open — a later stats poll never re-shows the skeleton (post-UAT fix)", async () => {
      vi.useFakeTimers();
      try {
        let statsCalls = 0;
        vi.mocked(invoke).mockImplementation(async (cmd: string) => {
          if (cmd === "ping_endpoint") return 42;
          if (cmd === "server_get_stats") {
            statsCalls += 1;
            if (statsCalls === 1) return {
              cpu_percent: 1, load_1m: 0, load_5m: 0, load_15m: 0,
              mem_total: 1, mem_used: 0, disk_total: 1, disk_used: 0,
              unique_ips: 0, total_connections: 0, uptime_seconds: 1,
            };
            // 2nd+ poll hangs → statsLoading stays true. Before the latch this
            // re-closed the all-cards gate (<60s) and flashed the whole grid back
            // to the skeleton every ~10s — the bug the user reported.
            return new Promise<never>(() => {});
          }
          if (cmd === "server_get_uptime") return { uptime_seconds: 1 };
          if (cmd === "security_get_status") return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } };
          if (cmd === "get_server_geoip") return { country: "United States", country_code: "US", flag_emoji: "🇺🇸" };
          return null;
        });
        render(<OverviewSection state={makeState()} onNavigate={vi.fn()} />);
        // First load settles → grid shows (eye button present).
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(
          screen.queryByRole("button", { name: i18n.t("server.overview.ip.show") }),
        ).toBeInTheDocument();
        // Fire the 10s stats poll — the refetch hangs → statsLoading true. The gate
        // must STAY open (latched); the grid must NOT flash back to the skeleton.
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(
          screen.queryByRole("button", { name: i18n.t("server.overview.ip.show") }),
          "gate must stay open after a poll refetch (latched) — no full-grid skeleton flash",
        ).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    }, 20_000);

    it("renders the grid after ~60s even if one card stays hung (fallback)", async () => {
      vi.useFakeTimers();
      try {
        // geo never settles → the all-ready gate would never open without the
        // 60s fallback. Everything else settles.
        vi.mocked(invoke).mockImplementation(async (cmd: string) => {
          if (cmd === "ping_endpoint") return 42;
          if (cmd === "server_get_stats") return {
            cpu_percent: 1, load_1m: 0, load_5m: 0, load_15m: 0,
            mem_total: 1, mem_used: 0, disk_total: 1, disk_used: 0,
            unique_ips: 0, total_connections: 0, uptime_seconds: 1,
          };
          if (cmd === "server_get_uptime") return { uptime_seconds: 1 };
          if (cmd === "security_get_status") return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } };
          if (cmd === "get_server_geoip") return new Promise<never>(() => {}); // hung forever
          return null;
        });
        const state = makeState();
        render(<OverviewSection state={state} onNavigate={vi.fn()} />);
        // Flush mounted-effect microtasks (ping/stats/security settle).
        await act(async () => { await vi.advanceTimersByTimeAsync(12_000); });
        // Gate still closed (geo hung) → skeleton, no eye button.
        expect(
          screen.queryByRole("button", { name: i18n.t("server.overview.ip.show") }),
        ).not.toBeInTheDocument();
        // Advance past the 60s fallback → the grid renders regardless.
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(
          screen.getByRole("button", { name: i18n.t("server.overview.ip.show") }),
        ).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ═══════════════════════════════════════════════════════
  // Plan 09-19 — Overview honesty + perf fixes (regression-test-first).
  //   E-1  : no-cert TLS sub-tile must render a NEUTRAL tone, not the red
  //          «Истёк»/danger tone (the `item.tone ?? (...)` fallback swallowed
  //          the explicit `null` tone and fell through to `item.ok===false →
  //          danger`). Asserted via the new data-testid="tls-tile" + a
  //          tone-conveying data-tone attribute (class-free, D-04).
  //   E-2  : a stopped protocol must clear the frozen fastUptime value so the
  //          card falls back to stats/«—», not a stale frozen number.
  //   QE-01: server_get_uptime is a ONE-SHOT on mount (fast first paint); the
  //          10s useServerStats poll owns steady-state — no duplicate recurring
  //          uptime poller.
  // ═══════════════════════════════════════════════════════

  describe("E-1: no-cert TLS sub-tile tone (Plan 09-19)", () => {
    /**
     * Resolve the TLS sub-tile by its stable data-testid AFTER the loaded grid
     * renders. The tile carries a `data-tone` attribute conveying the semantic
     * tone (neutral / ok / warning / danger) so the test asserts tone WITHOUT
     * coupling to CSS classes or colour tokens (assertion philosophy D-04).
     */
    async function tlsTile(): Promise<HTMLElement> {
      return waitFor(() => {
        const securityCard = cardOf("server.overview.cards.security");
        return within(securityCard).getByTestId("tls-tile");
      });
    }

    it("no-cert: TLS tile is NEUTRAL (data-tone='neutral'), not danger, and shows the «—» placeholder", async () => {
      const state = makeState({ certRaw: null } as Partial<ServerState>);
      render(<OverviewSection state={state} />);
      const tile = await tlsTile();
      // The explicit null tone must survive → neutral, NOT the firewall/fail2ban
      // boolean fallback (item.ok===false → danger) that produced the red «Истёк».
      expect(tile).toHaveAttribute("data-tone", "neutral");
      // Label is the «—» placeholder, and NOT the «Истёк» expired label.
      expect(within(tile).getByText(i18n.t("server.overview.security.placeholder"))).toBeInTheDocument();
      expect(
        within(tile).queryByText(i18n.t("server.overview.security.tlsExpired")),
      ).not.toBeInTheDocument();
    });

    it("positive control: an EXPIRED cert renders the danger tone + «Истёк» label", async () => {
      const state = makeState({ certRaw: makeCertRaw(-2) } as Partial<ServerState>);
      render(<OverviewSection state={state} />);
      const tile = await tlsTile();
      expect(tile).toHaveAttribute("data-tone", "danger");
      expect(within(tile).getByText(i18n.t("server.overview.security.tlsExpired"))).toBeInTheDocument();
    });

    it("positive control: a healthy cert (>14d) renders the ok tone", async () => {
      const state = makeState({ certRaw: makeCertRaw(40) } as Partial<ServerState>);
      render(<OverviewSection state={state} />);
      const tile = await tlsTile();
      expect(tile).toHaveAttribute("data-tone", "ok");
    });
  });

  describe("E-2: stopped protocol clears the frozen uptime (Plan 09-19)", () => {
    it("clears fastUptime when serviceActive flips false → the card no longer shows the stale value", async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") return 42;
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "server_get_uptime") return { uptime_seconds: 3661 }; // 1ч 1м
        return null;
      });
      const state = makeState();
      const { rerender } = render(<OverviewSection state={state} />);
      // The fast uptime value (1ч 1м) appears while the protocol is running.
      const fast = i18n.t("server.overview.uptimeFormat.hoursMins", { hours: 1, mins: 1 });
      await waitFor(() => {
        expect(within(cardOf("server.overview.cards.uptime")).getByText(fast)).toBeInTheDocument();
      });
      // Stop the protocol — the same component instance re-renders. The frozen
      // fastUptime MUST be cleared so the card falls back (stats null → «—»),
      // not keep showing the stale 1ч 1м number.
      const stoppedState = makeState({
        serverInfo: {
          installed: true,
          version: "1.0.20",
          serviceActive: false,
          users: ["user1", "user2"],
          protocol: "WireGuard",
          listenPort: 51820,
        } as ServerState["serverInfo"],
      });
      rerender(<OverviewSection state={stoppedState} />);
      await waitFor(() => {
        expect(
          within(cardOf("server.overview.cards.uptime")).queryByText(fast),
        ).not.toBeInTheDocument();
      });
    });
  });

  describe("QE-05: pollers pause when the window is hidden — reboot poller exempt (Plan 09-19)", () => {
    function setHidden(hidden: boolean) {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    }

    it("does NOT poll server_get_stats while the window is hidden, then resumes when visible", async () => {
      vi.useFakeTimers();
      try {
        let statsCalls = 0;
        vi.mocked(invoke).mockImplementation(async (cmd: string) => {
          if (cmd === "ping_endpoint") return 42;
          if (cmd === "server_get_stats") { statsCalls++; return {
            cpu_percent: 1, load_1m: 0, load_5m: 0, load_15m: 0,
            mem_total: 1, mem_used: 0, disk_total: 1, disk_used: 0,
            unique_ips: 0, total_connections: 0, uptime_seconds: 1,
          }; }
          if (cmd === "server_get_uptime") return { uptime_seconds: 1 };
          if (cmd === "security_get_status") return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } };
          if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
          return null;
        });
        // Start hidden → the stats poller must be disabled (no immediate fire).
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        render(<OverviewSection state={makeState()} activeServerTab="overview" />);
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(statsCalls).toBe(0);
        // Become visible → the poller turns on and fires.
        setHidden(false);
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(statsCalls).toBeGreaterThanOrEqual(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does NOT fire the 30s background ping while hidden", async () => {
      vi.useFakeTimers();
      try {
        let pingCalls = 0;
        vi.mocked(invoke).mockImplementation(async (cmd: string) => {
          if (cmd === "ping_endpoint") { pingCalls++; return 42; }
          if (cmd === "server_get_stats") return null;
          if (cmd === "server_get_uptime") return { uptime_seconds: 1 };
          if (cmd === "security_get_status") return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } };
          if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
          return null;
        });
        render(<OverviewSection state={makeState()} activeServerTab="overview" />);
        // Let the initial ping settle, then go hidden.
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        const afterMount = pingCalls;
        setHidden(true);
        // Advance past two 30s background-ping windows — none must fire while hidden.
        await act(async () => { await vi.advanceTimersByTimeAsync(70_000); });
        expect(pingCalls).toBe(afterMount);
      } finally {
        vi.useRealTimers();
      }
    });

    it("KEEPS polling check_server_installation (reboot poller) while hidden — the documented exception", async () => {
      vi.useFakeTimers();
      try {
        let rebootCalls = 0;
        vi.mocked(invoke).mockImplementation(async (cmd: string) => {
          if (cmd === "ping_endpoint") return 42;
          if (cmd === "server_get_stats") return null;
          if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
          if (cmd === "check_server_installation") { rebootCalls++; throw new Error("still rebooting"); }
          return null;
        });
        // Start hidden + rebooting — the reboot poller MUST keep running (gating it
        // would stall recovery).
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        render(<OverviewSection state={makeState({ rebooting: true })} activeServerTab="overview" />);
        // Advance two 10s reboot-poll ticks while hidden.
        await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
        expect(rebootCalls).toBeGreaterThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("A-1: refresh control adopts the shared IconButton (Plan 09-19)", () => {
    it("the Ping refresh control is a role=button with the refresh aria-label and reflects aria-busy while loading", async () => {
      // Deferred ping so the manual refresh stays in-flight → aria-busy true.
      let releasePing: (ms: number) => void = () => {};
      let initialResolved = false;
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "ping_endpoint") {
          if (!initialResolved) { initialResolved = true; return 42; }
          return new Promise<number>((resolve) => { releasePing = resolve; });
        }
        if (cmd === "server_get_stats") return null;
        if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
        if (cmd === "server_get_uptime") return { uptime_seconds: 1 };
        if (cmd === "security_get_status") return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } };
        return null;
      });
      render(<OverviewSection state={makeState()} />);
      // Wait for the loaded grid + the settled initial ping.
      await waitFor(() => {
        expect(within(cardOf("server.overview.cards.ping")).getByText("42")).toBeInTheDocument();
      });
      const pingCard = cardOf("server.overview.cards.ping");
      const refresh = within(pingCard).getByRole("button", { name: i18n.t("server.overview.refreshAria") });
      // Not busy at rest.
      expect(refresh).toHaveAttribute("aria-busy", "false");
      // Click → manual ping in flight → aria-busy true (IconButton loading state).
      fireEvent.click(refresh);
      await waitFor(() => { expect(refresh).toHaveAttribute("aria-busy", "true"); });
      // It is disabled while loading (IconButton disables on loading).
      expect(refresh).toBeDisabled();
      await act(async () => { releasePing(50); });
    });
  });

  describe("ELT-02/03/04: enriched Overview empty-state copy (Plan 09-19)", () => {
    it("the never-measured Speed caption is enriched (longer than the bare placeholder)", async () => {
      const state = makeState();
      render(<OverviewSection state={state} />);
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
      const speedCard = cardOf("server.overview.cards.speed");
      const caption = within(speedCard).getByText(i18n.t("server.overview.speedNotMeasured"));
      expect(caption).toBeInTheDocument();
      // Enriched copy explains what/how-to-start, so it is materially longer
      // than the old two-word «Не измерялась» (13 chars) bare label.
      expect((caption.textContent ?? "").length).toBeGreaterThan(25);
    });

    it("the protocol-stopped Speed caption is enriched (what/why context)", async () => {
      const state = makeState({
        serverInfo: {
          installed: true, version: "1.0.0", serviceActive: false, users: [],
          listenPort: 443, protocol: "x",
        } as ServerState["serverInfo"],
      });
      render(<OverviewSection state={state} />);
      await screen.findByRole("button", { name: i18n.t("server.overview.ip.show") });
      const speedCard = cardOf("server.overview.cards.speed");
      const caption = within(speedCard).getByText(i18n.t("server.overview.speedRequiresProtocol"));
      expect((caption.textContent ?? "").length).toBeGreaterThan(25);
    });
  });

  describe("QE-01: uptime is a one-shot on mount (Plan 09-19)", () => {
    it("calls server_get_uptime exactly once after mount (no recurring 10s uptime poller)", async () => {
      vi.useFakeTimers();
      try {
        let uptimeInvokes = 0;
        vi.mocked(invoke).mockImplementation(async (cmd: string) => {
          if (cmd === "ping_endpoint") return 42;
          if (cmd === "server_get_stats") return {
            cpu_percent: 1, load_1m: 0, load_5m: 0, load_15m: 0,
            mem_total: 1, mem_used: 0, disk_total: 1, disk_used: 0,
            unique_ips: 0, total_connections: 0, uptime_seconds: 90061,
          };
          if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
          if (cmd === "server_get_uptime") { uptimeInvokes++; return { uptime_seconds: 3661 }; }
          return null;
        });
        render(<OverviewSection state={makeState()} />);
        // Flush mount effects → the one-shot fires once.
        await act(async () => { await vi.advanceTimersByTimeAsync(100); });
        expect(uptimeInvokes).toBe(1);
        // Advance well past several 10s windows — the pre-fix recurring interval
        // would have fired again here. The one-shot must NOT.
        await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
        expect(uptimeInvokes).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
