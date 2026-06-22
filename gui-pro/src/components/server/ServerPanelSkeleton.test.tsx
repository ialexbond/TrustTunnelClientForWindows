import { describe, it, expect, vi } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { invoke } from "@tauri-apps/api/core";
import { ServerPanelSkeleton } from "./ServerPanelSkeleton";
import { OverviewSection } from "./OverviewSection";
import { makeState } from "../../test/fixtures";

// ═══════════════════════════════════════════════════════
// Plan 04-14 — Skeleton ↔ loaded layout parity (D-04).
//
// The user treats a skeleton-vs-loaded layout mismatch as a real bug (D-04):
// the placeholder MUST mirror the loaded OverviewSection exactly so there is no
// visual jump when data arrives. These tests pin the structural parity that was
// broken pre-fix:
//   - H-03: the Security card skeleton rendered 4 sub-tiles, but the loaded
//     layout renders 3 (Firewall / Fail2Ban / TLS — SSH-key removed in Phase 16).
//   - L-03: the full-panel skeleton must mirror the loaded 10-card layout.
//
// Counting is done via a stable `data-testid` hook on the skeleton tiles (NOT a
// CSS-class match) so the assertion survives a presentation refactor (D-04).
// ═══════════════════════════════════════════════════════

describe("ServerPanelSkeleton ↔ OverviewSection layout parity (Plan 04-14, D-04)", () => {
  it("H-03: the Security skeleton renders exactly 3 sub-tiles (matching the loaded 3-tile layout)", () => {
    render(<ServerPanelSkeleton />);
    // Pre-fix this was 4 tiles → a 4→3 jump when serverInfo loaded.
    expect(screen.getAllByTestId("security-skeleton-tile")).toHaveLength(3);
  });

  it("H-03: the loaded Security card renders exactly 3 named sub-tiles (Firewall / Fail2Ban / TLS)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "ping_endpoint") return 42;
      if (cmd === "server_get_stats") return null;
      if (cmd === "get_server_geoip") return { country: "X", country_code: "X", flag_emoji: "🏳" };
      if (cmd === "server_get_uptime") return { uptime_seconds: 1 };
      if (cmd === "security_get_status") return { firewall: { installed: true, active: true }, fail2ban: { installed: true, active: true } };
      return null;
    });
    i18n.changeLanguage("ru");
    const state = makeState();
    render(<OverviewSection state={state} />);
    // D-07 (Plan 07-06): OverviewSection now gates the real grid behind an
    // all-cards-loaded check (it paints the full skeleton until every per-card
    // signal settles). The loaded Security card (a ClickableCard with role=button)
    // only exists once the gate opens — wait for it, re-resolving the card inside
    // waitFor so we never read from the detached skeleton node.
    const securityCard = await waitFor(() => {
      const title = screen.getByText(i18n.t("server.overview.cards.security"));
      const card = title.closest('[role="button"]') as HTMLElement | null;
      expect(card).not.toBeNull();
      expect(
        within(card!).getByText(i18n.t("server.overview.security.firewall")),
      ).toBeInTheDocument();
      return card!;
    });
    // Exactly 3 named tiles — confirms the loaded count the skeleton must mirror.
    expect(within(securityCard).getByText(i18n.t("server.overview.security.firewall"))).toBeInTheDocument();
    expect(within(securityCard).getByText(i18n.t("server.overview.security.fail2ban"))).toBeInTheDocument();
    expect(within(securityCard).getByText(i18n.t("server.overview.security.tls"))).toBeInTheDocument();
  });

  it("L-03: the full-panel skeleton mirrors the loaded 10-card layout (10 card placeholders)", () => {
    const { container } = render(<ServerPanelSkeleton />);
    // The skeleton mirrors OverviewSection's 10-card flex-wrap grid. Each card
    // placeholder is a direct child of the inner flex-wrap container. We locate
    // that container structurally (the only element with the flex-wrap inline
    // style holding the cards) and count its element children.
    // The skeleton's content grid is the descendant <div> that wraps the 10
    // OverviewSkeletonCard divs (style: display flex, flexWrap wrap).
    const grids = Array.from(container.querySelectorAll<HTMLElement>("div")).filter(
      (el) => el.style.display === "flex" && el.style.flexWrap === "wrap",
    );
    expect(grids.length).toBeGreaterThanOrEqual(1);
    const cardGrid = grids[0];
    // 10 cards: Status, Ping, Speed, Users, IP, Country, Uptime, Version,
    // Security, Load — matching the loaded OverviewSection layout.
    expect(cardGrid.children).toHaveLength(10);
  });
});
