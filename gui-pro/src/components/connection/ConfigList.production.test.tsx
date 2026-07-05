import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { renderWithProviders } from "../../test/test-utils";
import { ConfigList } from "./ConfigList";
import type { ConfigSummary } from "../../shared/hooks/useConfigList";

// Resolve the import-CTA label through i18n so the test is language-agnostic (jsdom
// defaults navigator.language to en-US, so the suite runs in English).
const importCtaLabel = i18n.t("connection.import.cta");

// The production ConfigList is a pure presentational component (no invoke) — these tests
// render it directly with deterministic props for each list-level state.

const cfgDe: ConfigSummary = {
  id: "cfg-de-abc12345",
  name: "Германия — Frankfurt",
  host: "de1.example.com",
  display_host: "de1.example.com",
  user: "swift-fox",
  path: "C:/app/TrustTunnel_swift-fox.toml",
  order: 0,
  last_used: true,
};
const cfgNl: ConfigSummary = {
  id: "cfg-nl-def67890",
  name: "Нидерланды",
  host: "nl.example.com",
  display_host: "nl.example.com",
  user: "bold-eagle",
  path: "C:/app/TrustTunnel_bold-eagle.toml",
  order: 1,
  last_used: false,
};

describe("ConfigList", () => {
  // Truth: with no configs, ConfigList renders the empty-no-configs CTA.
  // (Story-vs-plan reconciliation: the LIVE design contract — ConfigList.stories.tsx
  // EmptyNoConfigs — settled on a SINGLE CTA «Импортировать конфиг»; the «…мастер
  // установки» pointer was intentionally dropped, so we assert against the live story.)
  it("empty-no-configs renders the «Импортировать конфиг» CTA", () => {
    const onImport = vi.fn();
    renderWithProviders(<ConfigList configs={[]} loading={false} onImport={onImport} />);

    expect(screen.getByTestId("empty-no-configs")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: importCtaLabel }),
    ).toBeInTheDocument();
  });

  // Truth: the import CTA invokes the onImport callback.
  it("clicking the import CTA calls onImport", async () => {
    const onImport = vi.fn();
    renderWithProviders(<ConfigList configs={[]} loading={false} onImport={onImport} />);
    await userEvent.click(
      screen.getByRole("button", { name: importCtaLabel }),
    );
    expect(onImport).toHaveBeenCalledTimes(1);
  });

  // Truth (a11y, F22): no shipped button has an accessible name starting with «…».
  // The live single-CTA empty state has no «…»-prefixed control, so this holds — we
  // assert it explicitly so a future re-introduction of an «…» pointer must keep an
  // explicit non-«…» accessible name.
  it("no button accessible name starts with «…» (F22)", () => {
    renderWithProviders(<ConfigList configs={[]} loading={false} onImport={vi.fn()} />);
    const buttons = screen.getAllByRole("button");
    for (const btn of buttons) {
      const name = btn.getAttribute("aria-label") ?? btn.textContent ?? "";
      expect(name.trimStart().startsWith("…")).toBe(false);
    }
  });

  // Truth: while loading, ConfigList renders the loading skeleton (no real cards).
  it("loading renders the skeleton state", () => {
    renderWithProviders(<ConfigList configs={[]} loading={true} onImport={vi.fn()} />);
    expect(screen.getByTestId("loading-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("config-card")).not.toBeInTheDocument();
  });

  // Truth: with nothing connected the last-used config sits on TOP but is a NORMAL card (no
  // green hero) — the «hero» lead presentation appears only while a tunnel is LIVE. So the top
  // card has NO data-lead here (11-UAT: a disconnected former-active config returns to a normal
  // inactive card, kept on top), while still being the first card with the right name + host.
  it("renders the last-used config on top as a normal card when disconnected", () => {
    // last-used first (as Rust sorts it): cfgDe (last_used) then cfgNl. No status → disconnected.
    renderWithProviders(
      <ConfigList configs={[cfgDe, cfgNl]} loading={false} onImport={vi.fn()} />,
    );
    const cards = screen.getAllByTestId("config-card");
    expect(cards).toHaveLength(2);
    // Top card is the last-used config — but NOT the green hero (nothing is connected).
    expect(cards[0]).not.toHaveAttribute("data-lead", "true");
    expect(cards[0]).toHaveTextContent("Германия — Frankfurt");
    expect(cards[0]).toHaveTextContent("de1.example.com");
    expect(cards[1]).toHaveTextContent("nl.example.com");
    expect(cards[1]).toHaveTextContent("bold-eagle");
  });

  // Truth (11-UAT): when the active config is DISCONNECTED it returns to a NORMAL inactive card
  // on top — the inline rename pencil + the ping pill come back and its primary CONNECTS (not
  // disconnects). The hero presentation is reserved for a LIVE tunnel.
  it("disconnected former-active config on top is a normal card — pencil + ping + «Подключить»", () => {
    renderWithProviders(
      <ConfigList
        configs={[cfgDe, cfgNl]}
        loading={false}
        onImport={vi.fn()}
        status="disconnected"
        activeConfigPath={cfgDe.path} // cfgDe WAS active, now disconnected
        pings={{ [cfgDe.id]: { band: "green", valueMs: 42 } }}
        onConnect={vi.fn()}
        onRename={vi.fn()}
      />,
    );
    const cards = screen.getAllByTestId("config-card");
    // Top card is cfgDe, but NOT the green hero (nothing is live).
    expect(cards[0]).not.toHaveAttribute("data-lead", "true");
    // The inline rename pencil is back (editable like any inactive card).
    expect(
      within(cards[0]).getByRole("button", { name: i18n.t("connection.rename.aria") }),
    ).toBeInTheDocument();
    // Primary is «Подключить» — NOT «Отключить».
    expect(
      within(cards[0]).getByRole("button", { name: i18n.t("connection.card.connect") }),
    ).toBeInTheDocument();
    expect(
      within(cards[0]).queryByRole("button", { name: i18n.t("connection.card.disconnect") }),
    ).not.toBeInTheDocument();
    // The ping pill is shown (settled disconnected state shows the badge).
    expect(within(cards[0]).getByText(/42/)).toBeInTheDocument();
  });

  // Truth: a single migrated config still renders as a full card (minimum populated list).
  it("renders a single migrated config as a card", () => {
    renderWithProviders(
      <ConfigList configs={[cfgDe]} loading={false} onImport={vi.fn()} />,
    );
    expect(screen.getByTestId("config-card")).toHaveTextContent(
      "Германия — Frankfurt",
    );
  });

  // Truth (11-UAT gaps B/C): the CONNECTED config — matched to activeConfigPath — is hoisted to
  // the lead with the live status and «Отключить», even when it is NOT first in the manifest.
  // The other card reads «Переключиться» (a tunnel is active elsewhere).
  it("hoists the connected config to the lead with live status, even when not first", () => {
    // Manifest order is [cfgDe(last_used), cfgNl], but the tunnel runs through cfgNl.
    renderWithProviders(
      <ConfigList
        configs={[cfgDe, cfgNl]}
        loading={false}
        onImport={vi.fn()}
        status="connected"
        activeConfigPath={cfgNl.path}
        onConnect={vi.fn()}
      />,
    );
    const cards = screen.getAllByTestId("config-card");
    expect(cards[0]).toHaveAttribute("data-lead", "true");
    expect(cards[0]).toHaveTextContent("Нидерланды");
    expect(cards[0]).toHaveAttribute("data-active-highlight", "true");
    expect(
      within(cards[0]).getByRole("button", { name: i18n.t("connection.card.disconnect") }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: i18n.t("connection.card.switch") }),
    ).toBeInTheDocument();
  });

  // F31 (14-UAT round 3): a FRESH connect (status `connecting`, not a switch → isSwitching false) must
  // ALSO lock the OTHER cards' «Переключиться» — the owner found them clickable mid-«Подключение», unlike
  // a real switch which locks everything. Rival switch mid-connect races the in-flight connect.
  it("locks the other cards' «Переключиться» while a config is CONNECTING (fresh connect)", () => {
    renderWithProviders(
      <ConfigList
        configs={[cfgDe, cfgNl]}
        loading={false}
        onImport={vi.fn()}
        status="connecting"
        activeConfigPath={cfgDe.path}
        onConnect={vi.fn()}
      />,
    );
    // cfgNl (the inactive card) reads «Переключиться» and must be DISABLED during connecting.
    expect(
      screen.getByRole("button", { name: i18n.t("connection.card.switch") }),
    ).toBeDisabled();
  });

  // Truth (11-UAT gaps B/C): the active-path match is normalized — a connected card stays
  // connected even when activeConfigPath arrives with backslashes / different casing than the
  // manifest path. This is the exact string divergence that left the card grey before the fix.
  it("marks the connected card even when activeConfigPath differs in separators/casing", () => {
    const mismatched = cfgDe.path.replace(/\//g, "\\").toUpperCase(); // C:\APP\TRUSTTUNNEL_SWIFT-FOX.TOML
    renderWithProviders(
      <ConfigList
        configs={[cfgDe]}
        loading={false}
        onImport={vi.fn()}
        status="connected"
        activeConfigPath={mismatched}
        onConnect={vi.fn()}
      />,
    );
    const card = screen.getByTestId("config-card");
    expect(card).toHaveAttribute("data-active-highlight", "true");
    expect(
      within(card).getByRole("button", { name: i18n.t("connection.card.disconnect") }),
    ).toBeInTheDocument();
  });

  // Truth: with nothing connected, every card reads «Подключить» — no card shows
  // «Переключиться» (a switch only makes sense while a tunnel is up elsewhere).
  it("shows «Подключить» on every card when nothing is connected", () => {
    renderWithProviders(
      <ConfigList
        configs={[cfgDe, cfgNl]}
        loading={false}
        onImport={vi.fn()}
        status="disconnected"
        activeConfigPath=""
        onConnect={vi.fn()}
      />,
    );
    expect(
      screen.getAllByRole("button", { name: i18n.t("connection.card.connect") }),
    ).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: i18n.t("connection.card.switch") }),
    ).not.toBeInTheDocument();
  });

  // Regression (Phase 15, 15-VERIFICATION gap): the «…» → «QR-код» action must reach EVERY card,
  // including those in the NOT-CONNECTED uniform list (activeConfigPath="" — the COMMON state right
  // after launch). That third render branch in ConfigList had `onQr` omitted, so «QR-код» was a silent
  // no-op in the app's default state even though the plan required threading it to all three sites
  // (D-09: available for any config). Existing card-level tests passed because they render the card in
  // isolation with onQr wired — only a LIST-level prop-threading test catches the missed branch. This
  // opens a not-connected card's overflow → «QR-код» → asserts onQr fires with that card's config.
  it("threads onQr to «QR-код» on cards in the NOT-CONNECTED list (D-09 regression)", async () => {
    const onQr = vi.fn();
    renderWithProviders(
      <ConfigList
        configs={[cfgDe, cfgNl]}
        loading={false}
        onImport={vi.fn()}
        status="disconnected"
        activeConfigPath="" // nothing connected → the uniform not-connected branch (the one that dropped onQr)
        onQr={onQr}
      />,
    );
    const cards = screen.getAllByTestId("config-card");
    // Open the FIRST card's overflow menu (scope the trigger to that card — two cards → two triggers).
    await userEvent.click(
      within(cards[0]).getByRole("button", { name: i18n.t("connection.card.actions_label") }),
    );
    const menu = screen.getByRole("menu");
    await userEvent.click(within(menu).getByText(i18n.t("connection.card.qr")));
    // cfgDe is last-used → the top card of the not-connected list; onQr must fire once with it.
    expect(onQr).toHaveBeenCalledTimes(1);
    expect(onQr).toHaveBeenCalledWith(cfgDe);
  });

  // ─── Manual ping refresh button (next to «Добавить конфиг») ───
  //
  // The automatic 15 s card-ping interval is REMOVED; pinging is now MANUAL via a square icon-only
  // «Обновить пинг» button placed next to «Добавить конфиг». One click pings ALL config cards once.
  // Assert BEHAVIOR + aria (not CSS): the button renders next to add-config, is accessible by its
  // aria-label, click triggers the refresh, and it is disabled while a round is in flight / no configs.
  describe("manual ping refresh button", () => {
    const refreshLabel = i18n.t("connection.refresh_pings");
    const addLabel = i18n.t("connection.list.add");

    it("renders the refresh button next to «Добавить конфиг», accessible by aria-label", () => {
      renderWithProviders(
        <ConfigList
          configs={[cfgDe, cfgNl]}
          loading={false}
          onImport={vi.fn()}
          onRefreshPings={vi.fn()}
        />,
      );
      const refreshBtn = screen.getByRole("button", { name: refreshLabel });
      const addBtn = screen.getByRole("button", { name: addLabel });
      expect(refreshBtn).toBeInTheDocument();
      expect(addBtn).toBeInTheDocument();
      // Adjacency: both live in the SAME footer row. The add button sits directly in the footer; the
      // refresh button is wrapped by its Tooltip, so climb to the nearest common footer ancestor and
      // assert it contains BOTH buttons (the refresh button is placed immediately next to add-config).
      const footer = addBtn.parentElement;
      expect(footer).toContainElement(refreshBtn);
    });

    it("clicking the refresh button triggers onRefreshPings", async () => {
      const onRefreshPings = vi.fn();
      renderWithProviders(
        <ConfigList
          configs={[cfgDe, cfgNl]}
          loading={false}
          onImport={vi.fn()}
          onRefreshPings={onRefreshPings}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: refreshLabel }));
      expect(onRefreshPings).toHaveBeenCalledTimes(1);
    });

    it("disables the refresh button (shows the in-flight spinner) while pinging", () => {
      renderWithProviders(
        <ConfigList
          configs={[cfgDe, cfgNl]}
          loading={false}
          onImport={vi.fn()}
          onRefreshPings={vi.fn()}
          pinging
        />,
      );
      // `loading` renders the spinner AND disables the button — assert the observable disabled state.
      expect(screen.getByRole("button", { name: refreshLabel })).toBeDisabled();
    });

    it("does not fire onRefreshPings while pinging (button is inert)", async () => {
      const onRefreshPings = vi.fn();
      renderWithProviders(
        <ConfigList
          configs={[cfgDe, cfgNl]}
          loading={false}
          onImport={vi.fn()}
          onRefreshPings={onRefreshPings}
          pinging
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: refreshLabel }));
      expect(onRefreshPings).not.toHaveBeenCalled();
    });

    it("disables the refresh button when there are no configs to ping", () => {
      // A populated-but-not-empty check is impossible with zero configs (the empty state renders
      // instead), so render the empty state and assert the refresh button is not present there — the
      // footer (add + refresh) only exists in the populated list. The disabled-when-empty guard is
      // additionally covered by the button's `disabled={pinging || configs.length === 0}`.
      renderWithProviders(
        <ConfigList configs={[]} loading={false} onImport={vi.fn()} onRefreshPings={vi.fn()} />,
      );
      // Empty state → no populated footer → no refresh button.
      expect(screen.queryByRole("button", { name: refreshLabel })).not.toBeInTheDocument();
    });

    it("omits the refresh button when onRefreshPings is not supplied", () => {
      renderWithProviders(
        <ConfigList configs={[cfgDe, cfgNl]} loading={false} onImport={vi.fn()} />,
      );
      expect(screen.queryByRole("button", { name: refreshLabel })).not.toBeInTheDocument();
      // The add-config button is still there.
      expect(screen.getByRole("button", { name: addLabel })).toBeInTheDocument();
    });
  });

  // ─── Phase 16 (TA-3): the T-22 «IP» glyph is threaded through the LIST render ───
  //
  // The ConfigCard-level tests prove ONE card shows the «IP» glyph for a bare-IP display_host.
  // This LIST-level case renders a bare-IP card (fake .local SNI host + IP in display_host — the
  // exact gap-5a shape) TOGETHER with a domain card, so a regression that drops display_host on the
  // list's map/hoist path (twin-collapse in ConnectionPanel keys off display_host) would surface
  // here even while the isolated card test stays green. The IP config is the LIVE lead (the glyph is
  // lead-card only), the domain config rests — so exactly one «IP» glyph must exist and belong to it.
  it("TA-3: renders exactly one «IP» glyph for a bare-IP card in a mixed IP+domain list", () => {
    // cfgIp: a bare-IP server carrying a fake TLS-SNI hostname (.local) — the real endpoint is the IP.
    const cfgIp: ConfigSummary = {
      id: "cfg-ip-fedc0987",
      name: "Self-hosted (IP)",
      host: "trusttunnel.local", // fake SNI hostname (raw dedup key)
      display_host: "203.0.113.141", // the IP-preferring card value the glyph keys off
      user: "lone-wolf",
      path: "C:/app/TrustTunnel_lone-wolf.toml",
      order: 0,
      last_used: false,
    };
    renderWithProviders(
      <ConfigList
        configs={[cfgIp, cfgDe]}
        loading={false}
        onImport={vi.fn()}
        // The IP config is connected → hoisted to the lead (the only place the glyph renders);
        // cfgDe (domain) rests below.
        status="connected"
        activeConfigPath={cfgIp.path}
        onConnect={vi.fn()}
      />,
    );
    // Exactly one «IP» glyph in the whole list, and it belongs to the IP (lead) card.
    const markers = screen.getAllByTestId("config-card-ip-marker");
    expect(markers).toHaveLength(1);
    const cards = screen.getAllByTestId("config-card");
    const ipCard = cards.find((c) => c.contains(markers[0]));
    expect(ipCard).toBe(cards[0]); // the lead card is the IP config
    expect(ipCard).toHaveTextContent("203.0.113.141"); // shows the IP, not the fake .local name
    expect(ipCard).not.toHaveTextContent("trusttunnel.local");
    // The domain card (cfgDe) shows its domain host and NO «IP» glyph.
    expect(cards[1]).toHaveTextContent("de1.example.com");
    expect(within(cards[1]).queryByText("IP")).not.toBeInTheDocument();
  });

  // ─── Phase 14 (14-02): the hero survives a transient disconnected while switching ───
  //
  // GREEN as of 14-02 (D-12) — the `isSwitching` prop is threaded App→ConnectionPanel→ConfigList and
  // OR'd into the leadIsLive gate (`leadIsLive = Boolean(activeMatchId) && (isTunnelLive(status) ||
  // isSwitching)`). The dead-air bug was that the teardown emits a transient `disconnected` whose
  // `isTunnelLive===false` demoted the frosted hero to a plain resting row mid-switch; ORing
  // isSwitching keeps the hero mounted through that transient. `data-lead="true"` is the observable
  // for the wide/sticky hero treatment (leadIsLive true).
  describe("Phase 14 — hero persistence while switching (GREEN in 14-02)", () => {
    // D-12: with a switch in flight the lead/frosted hero SURVIVES the transient `disconnected`
    // (leadIsLive stays true) — the active card must not demote to a resting row mid-switch, or the
    // user reads it as "the connection vanished". `activeConfigPath` already points at the TARGET at
    // switch start (promoted in App.handleConnectConfig), so the hero shows the target server.
    it("keeps the frosted hero mounted through a transient disconnected while isSwitching", () => {
      renderWithProviders(
        <ConfigList
          configs={[cfgDe, cfgNl]}
          loading={false}
          onImport={vi.fn()}
          // The teardown leg emits a transient `disconnected` (isTunnelLive===false today → demote).
          status="disconnected"
          activeConfigPath={cfgNl.path}
          // A switch is in flight → the hero must stay live (14-02 threaded isSwitching).
          isSwitching
          onConnect={vi.fn()}
        />,
      );
      const cards = screen.getAllByTestId("config-card");
      // The switch target (cfgNl) is hoisted + frosted as the LIVE hero despite the transient
      // disconnected — leadIsLive is held true by isSwitching (D-12).
      expect(cards[0]).toHaveAttribute("data-lead", "true");
      expect(cards[0]).toHaveTextContent("Нидерланды");
    });

    // WR-01: the whole hero-persistence guarantee rests on `activeConfigPath` matching a manifest row
    // by `samePath` (normalized: separator + case) through the ENTIRE switch. If the switch target
    // arrives with a different separator/casing than the manifest path (the exact string divergence
    // 11-UAT gaps B/C flagged), a raw `===` would make `activeMatchId` undefined → leadIsLive collapses
    // to false mid-switch and the frosted hero demotes to a resting row for a frame (the "dead-air"
    // regression the phase exists to kill). This asserts the hero STAYS mounted (data-lead) across a
    // switch whose target path differs in separator/casing — proving the samePath normalization holds
    // the hero live even in the mismatched-string case, not just the exact-match one.
    it("WR-01: keeps the frosted hero mounted mid-switch when the target path differs in separators/casing", () => {
      // cfgNl is the switch target, but activeConfigPath arrives with backslashes + uppercase (the
      // separator/case divergence). samePath must still match it to cfgNl so leadIsLive stays true.
      const mismatched = cfgNl.path.replace(/\//g, "\\").toUpperCase(); // C:\APP\TRUSTTUNNEL_BOLD-EAGLE.TOML
      renderWithProviders(
        <ConfigList
          configs={[cfgDe, cfgNl]}
          loading={false}
          onImport={vi.fn()}
          // The teardown leg emits a transient `disconnected` (isTunnelLive===false).
          status="disconnected"
          activeConfigPath={mismatched}
          // A switch is in flight → the hero must stay live regardless of the path-string divergence.
          isSwitching
          onConnect={vi.fn()}
        />,
      );
      const cards = screen.getAllByTestId("config-card");
      // The target (cfgNl) is still matched by samePath despite the separator/case mismatch, so it
      // stays the hoisted frosted hero — no dead-air demotion to a resting row.
      expect(cards[0]).toHaveAttribute("data-lead", "true");
      expect(cards[0]).toHaveTextContent("Нидерланды");
    });

    // IN-52 regression must-keep: when NO switch is in flight and the disconnect is SETTLED, the
    // sticky/frosted lead treatment VANISHES (leadIsLive returns false once isSwitching clears) — a
    // plain uniform list, no hero. This is the invariant the isSwitching OR must NOT break: it only
    // holds the hero DURING a switch, never after a genuine settled disconnect.
    it("IN-52: the frosted hero VANISHES when settled-disconnected with no switch in flight", () => {
      renderWithProviders(
        <ConfigList
          configs={[cfgDe, cfgNl]}
          loading={false}
          onImport={vi.fn()}
          status="disconnected"
          activeConfigPath={cfgNl.path}
          // No switch in flight → the hero must be gone (plain uniform list).
          isSwitching={false}
          onConnect={vi.fn()}
        />,
      );
      const cards = screen.getAllByTestId("config-card");
      // No card carries the lead/hero treatment — the list is uniform (IN-52).
      for (const card of cards) {
        expect(card).not.toHaveAttribute("data-lead", "true");
      }
    });
  });

  // ─── Phase 14 (14-03): every card LOCKS while a switch is in flight (D-13) ───
  //
  // RED until 14-03 — `isSwitching` is threaded into ConfigList (14-02) but is NOT yet OR'd into the
  // per-card `locked` prop. D-13: a mid-switch action on ANY card (a second «Переключиться», an
  // «Изменить»/«Дублировать»/«Удалить», an inline rename) must be inert until the swap settles, so a
  // competing action cannot corrupt the in-flight swap. We reuse the EXISTING `locked` idiom (D-21) —
  // ConfigCard.locked already disables the primary + overflow + the rename pencil — by OR-ing
  // isSwitching into it for EVERY card (lead + resting). Assert behavior (disabled primary), never CSS.
  describe("Phase 14 — every card locks while switching (RED until 14-03)", () => {
    // D-13: with a switch in flight the RESTING card's primary («Переключиться», since a tunnel is live
    // on the hero) is DISABLED — a second switch cannot race the swap. The lead hero primary is an
    // in-flight spinner already (14-02); this asserts the OTHER cards lock too.
    it("disables a resting card's primary while isSwitching (D-13)", () => {
      renderWithProviders(
        <ConfigList
          configs={[cfgDe, cfgNl]}
          loading={false}
          onImport={vi.fn()}
          // cfgDe is the live hero; cfgNl is a resting «Переключиться» card.
          status="connected"
          activeConfigPath={cfgDe.path}
          isSwitching
          onConnect={vi.fn()}
        />,
      );
      const cards = screen.getAllByTestId("config-card");
      // The resting (non-lead) card's primary button must be disabled while switching.
      const resting = cards.find((c) => c.getAttribute("data-lead") !== "true");
      expect(resting).toBeDefined();
      const primary = within(resting!).getByRole("button", {
        name: i18n.t("connection.card.switch"),
      });
      expect((primary as HTMLButtonElement).disabled).toBe(true);
    });

    // D-13 atomic re-enable: with the switch settled (isSwitching false) the resting card's primary is
    // ENABLED again — the lock lifts in one flip (no per-card timer). This is the must-keep counterpart
    // so the lock does not persist past the swap.
    it("re-enables a resting card's primary when the switch settles (D-13)", () => {
      renderWithProviders(
        <ConfigList
          configs={[cfgDe, cfgNl]}
          loading={false}
          onImport={vi.fn()}
          status="connected"
          activeConfigPath={cfgDe.path}
          isSwitching={false}
          onConnect={vi.fn()}
        />,
      );
      const cards = screen.getAllByTestId("config-card");
      const resting = cards.find((c) => c.getAttribute("data-lead") !== "true");
      const primary = within(resting!).getByRole("button", {
        name: i18n.t("connection.card.switch"),
      });
      expect((primary as HTMLButtonElement).disabled).toBe(false);
    });
  });

  // FAB-01: the cards are LOCKED not only during an App-owned switch (isSwitching) but ALSO while the
  // backend reconnect supervisor is running (`reconnecting`/`recovering`). A manual «Переключиться»
  // clicked during «Переподключение»/«Восстановление» would race the Rust respawn_sidecar. The cards
  // must be VISIBLY locked in those states (matching performSwitch's early refusal). Assert a resting
  // card's primary is disabled while `reconnecting` even with isSwitching=false.
  describe("Phase 14 — cards lock while reconnecting/recovering (FAB-01)", () => {
    it("disables a resting card's primary while status is reconnecting (isSwitching false)", () => {
      renderWithProviders(
        <ConfigList
          configs={[cfgDe, cfgNl]}
          loading={false}
          onImport={vi.fn()}
          // cfgDe is the live hero; the backend is auto-reconnecting (NOT an App-owned switch).
          status="reconnecting"
          activeConfigPath={cfgDe.path}
          isSwitching={false}
          onConnect={vi.fn()}
        />,
      );
      const cards = screen.getAllByTestId("config-card");
      const resting = cards.find((c) => c.getAttribute("data-lead") !== "true");
      expect(resting).toBeDefined();
      // While reconnecting the tunnel is live-on-the-hero, so the resting primary reads «Переключиться».
      const primary = within(resting!).getByRole("button", {
        name: i18n.t("connection.card.switch"),
      });
      expect((primary as HTMLButtonElement).disabled).toBe(true);
    });

    it("disables a resting card's primary while status is recovering (isSwitching false)", () => {
      renderWithProviders(
        <ConfigList
          configs={[cfgDe, cfgNl]}
          loading={false}
          onImport={vi.fn()}
          status="recovering"
          activeConfigPath={cfgDe.path}
          isSwitching={false}
          onConnect={vi.fn()}
        />,
      );
      const cards = screen.getAllByTestId("config-card");
      const resting = cards.find((c) => c.getAttribute("data-lead") !== "true");
      const primary = within(resting!).getByRole("button", {
        name: i18n.t("connection.card.switch"),
      });
      expect((primary as HTMLButtonElement).disabled).toBe(true);
    });

    it("disables a resting card's primary while status is disconnecting (3.4 R-DCT, isSwitching false)", () => {
      renderWithProviders(
        <ConfigList
          configs={[cfgDe, cfgNl]}
          loading={false}
          onImport={vi.fn()}
          // cfgDe is the live hero being torn down; the cards must lock so a connect cannot race the kill.
          status="disconnecting"
          activeConfigPath={cfgDe.path}
          isSwitching={false}
          onConnect={vi.fn()}
        />,
      );
      const cards = screen.getAllByTestId("config-card");
      const resting = cards.find((c) => c.getAttribute("data-lead") !== "true");
      expect(resting).toBeDefined();
      const primary = within(resting!).getByRole("button", {
        name: i18n.t("connection.card.switch"),
      });
      expect((primary as HTMLButtonElement).disabled).toBe(true);
    });

    // Must-keep: a plain `connected` state (no switch, no reconnect) leaves the resting primary ENABLED
    // — the FAB-01 lock is scoped to reconnecting/recovering + switching, it does not over-lock.
    it("leaves a resting card's primary ENABLED in a plain connected state (no over-lock)", () => {
      renderWithProviders(
        <ConfigList
          configs={[cfgDe, cfgNl]}
          loading={false}
          onImport={vi.fn()}
          status="connected"
          activeConfigPath={cfgDe.path}
          isSwitching={false}
          onConnect={vi.fn()}
        />,
      );
      const cards = screen.getAllByTestId("config-card");
      const resting = cards.find((c) => c.getAttribute("data-lead") !== "true");
      const primary = within(resting!).getByRole("button", {
        name: i18n.t("connection.card.switch"),
      });
      expect((primary as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
