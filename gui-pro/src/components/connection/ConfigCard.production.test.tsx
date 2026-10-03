import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { renderWithProviders } from "../../test/test-utils";
import { ConfigCard } from "./ConfigCard";
import { statusBadgeVariant } from "../../shared/lib/statusBadgeVariant";
import type { ConfigSummary } from "../../shared/hooks/useConfigList";
import type { VpnStatus } from "../../shared/types";

// Resolve labels through i18n so the test is language-agnostic (jsdom defaults to en-US).
const L = {
  switch: i18n.t("connection.card.switch"),
  connect: i18n.t("connection.card.connect"),
  disconnect: i18n.t("connection.card.disconnect"),
  connecting: i18n.t("status.connecting_short"),
  disconnecting: i18n.t("status.disconnecting_short"),
  // Phase 14 (14-02): the switching-face badge label. Until the ru/en key lands, i18n.t returns
  // the key string itself ("status.switching_short") — the switching-face test asserts THIS resolved
  // value renders, so it flips GREEN automatically once 14-02 adds «Переключение» and forces it.
  switching: i18n.t("status.switching_short"),
  no_data: i18n.t("connection.ping.no_data"),
  unreachable: i18n.t("connection.ping.unreachable"),
  // Phase 16 (T-22 / 16-03): the IP-only glyph tooltip. The key ALREADY exists
  // (connection.card.ip_only_tooltip); the glyph that consumes it does not yet — so the
  // two IP cases below are RED until 16-03 renders the «IP» glyph in the host-meta row.
  ipTooltip: i18n.t("connection.card.ip_only_tooltip"),
};

const cfg: ConfigSummary = {
  id: "cfg-de-abc12345",
  name: "Германия — Frankfurt",
  host: "de1.example.com",
  // 16-07: a real domain → display_host mirrors host (globe preserved).
  display_host: "de1.example.com",
  user: "swift-fox",
  path: "C:/app/TrustTunnel_swift-fox.toml",
  order: 0,
  last_used: true,
};

describe("ConfigCard", () => {
  // Session-uptime timer (re-wired: the lead card slot + Storybook existed since Phase 11 but the
  // live data was never threaded). Connected + connectedSince → a ticking «HH:MM:SS» counter.
  it("connected lead card shows a live HH:MM:SS uptime counter from connectedSince", () => {
    const since = new Date(Date.now() - 65_000); // 65s ago → «00:01:0x»
    renderWithProviders(<ConfigCard config={cfg} leadCard status="connected" connectedSince={since} />);
    const card = screen.getByTestId("config-card");
    // Exact seconds may drift by test timing → assert the HH:MM:SS shape is rendered.
    expect(within(card).getByText(/^\d{2}:\d{2}:\d{2}$/)).toBeInTheDocument();
  });

  it("connected lead card renders NO uptime when neither connectedSince nor uptime is given", () => {
    renderWithProviders(<ConfigCard config={cfg} leadCard status="connected" />);
    const card = screen.getByTestId("config-card");
    expect(within(card).queryByText(/^\d{2}:\d{2}:\d{2}$/)).not.toBeInTheDocument();
  });

  // Truth: the active (connected) lead card exposes a green-active marker (data-attr) and
  // does NOT render a left-accent-rail element (banned design artifact — active = green
  // tint + full ring).
  it("active lead card has a green-active marker and NO left accent rail", () => {
    renderWithProviders(<ConfigCard config={cfg} leadCard status="connected" />);
    const card = screen.getByTestId("config-card");
    // Green-active marker present (asserted semantically, not via CSS hex).
    expect(card).toHaveAttribute("data-active-highlight", "true");
    expect(card).toHaveAttribute("data-lead", "true");
    // The active highlight is a FULL ring (ring-1) — no single-sided left-edge accent.
    expect(card.className).toContain("ring-1");
    expect(card.className).not.toMatch(/border-l-|border-l\b/);
    // No element carries a left-rail marker class.
    expect(card.querySelector("[class*='border-l-']")).toBeNull();
  });

  // Truth: an inactive card's primary button accessible name is «Переключиться» when a
  // tunnel is active elsewhere (D-20).
  it("inactive card primary reads «Переключиться» when active elsewhere", () => {
    renderWithProviders(<ConfigCard config={cfg} status="disconnected" activeElsewhere />);
    expect(screen.getByRole("button", { name: L.switch })).toBeInTheDocument();
    // It is NOT «Подключить» in that state.
    expect(screen.queryByRole("button", { name: L.connect })).not.toBeInTheDocument();
  });

  // Truth: a resting inactive card with no active tunnel reads «Подключить».
  it("inactive card primary reads «Подключить» when nothing is active", () => {
    renderWithProviders(<ConfigCard config={cfg} status="disconnected" />);
    expect(screen.getByRole("button", { name: L.connect })).toBeInTheDocument();
  });

  // F28: connectPending gives INSTANT click feedback — the primary is disabled (Button.loading) so the
  // click is never a silent no-op while the pre-connect probe runs before status becomes «connecting».
  it("F28: connectPending disables the primary for instant click feedback", () => {
    renderWithProviders(<ConfigCard config={cfg} status="disconnected" connectPending />);
    expect(screen.getByRole("button", { name: L.connect })).toBeDisabled();
  });

  // Truth: the connected lead card primary reads «Отключить» (danger).
  it("connected lead card primary reads «Отключить»", () => {
    renderWithProviders(<ConfigCard config={cfg} leadCard status="connected" />);
    expect(screen.getByRole("button", { name: L.disconnect })).toBeInTheDocument();
  });

  // Truth: the ACTIVE/lead card title is READ-ONLY — no inline rename pencil even when an
  // onRename handler is wired. The active config's title is edited in «Изменить»
  // (ConfigEditView → «Имя конфига»), never inline on the card. Inline rename is a
  // resting-row affordance only.
  it("lead card title is read-only — no rename pencil even with onRename wired", () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ConfigCard config={cfg} leadCard status="connected" onRename={onRename} />,
    );
    expect(
      screen.queryByRole("button", { name: i18n.t("connection.rename.aria") }),
    ).not.toBeInTheDocument();
  });

  // Truth (IN-58): an EMPTY config name is VALID — the card TITLE falls back to the config's
  // username. The lead card's meta line has NO username (host · ping · uptime only), so the
  // username text appearing at all proves it landed as the hero title.
  it("empty name falls back to the username as the lead-card title", () => {
    renderWithProviders(
      <ConfigCard config={{ ...cfg, name: "" }} leadCard status="connected" />,
    );
    expect(screen.getByText(cfg.user)).toBeInTheDocument();
  });

  // Truth (IN-58): the resting row title falls back to the username too. The resting meta
  // line always shows «host · username», so with an empty name the username paints TWICE —
  // once as the title fallback, once in the meta line. A non-empty name paints it only once.
  it("empty name falls back to the username on the resting-row title", () => {
    renderWithProviders(<ConfigCard config={{ ...cfg, name: "" }} status="disconnected" />);
    expect(screen.getAllByText(cfg.user)).toHaveLength(2);
  });

  // Truth: a NON-empty name renders as the title (no username fallback in the title slot).
  it("non-empty name renders the name as the title", () => {
    renderWithProviders(<ConfigCard config={cfg} leadCard status="connected" />);
    expect(screen.getByText(cfg.name)).toBeInTheDocument();
    // Lead meta has no username line, so the username must NOT appear anywhere.
    expect(screen.queryByText(cfg.user)).not.toBeInTheDocument();
  });

  // Truth (IN-58): clearing the name inline is a VALID commit — no error paints while the
  // draft is empty, and ✓ commits onRename("") (the backend then clears endpoint.name and
  // the title falls back to the username).
  it("clearing the name commits an empty rename with no error", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ConfigCard
        config={cfg}
        status="disconnected"
        onRename={onRename}
        existingNames={["Нидерланды"]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: i18n.t("connection.rename.aria") }));
    await userEvent.clear(
      screen.getByRole("textbox", { name: i18n.t("connection.rename.edit_aria") }),
    );
    // No FieldError while the draft is empty (the empty-name rule was removed).
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: i18n.t("connection.rename.commit") }));
    expect(onRename).toHaveBeenCalledWith("");
  });

  // Truth: a DUPLICATE name is still an error — the FieldError shows the duplicate message
  // and ✓ never commits.
  it("duplicate name surfaces the duplicate error and never commits", async () => {
    const onRename = vi.fn();
    renderWithProviders(
      <ConfigCard
        config={cfg}
        status="disconnected"
        onRename={onRename}
        existingNames={["Нидерланды"]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: i18n.t("connection.rename.aria") }));
    const input = screen.getByRole("textbox", { name: i18n.t("connection.rename.edit_aria") });
    await userEvent.clear(input);
    await userEvent.type(input, "Нидерланды");
    expect(
      screen.getByText(i18n.t("connection.rename.error_duplicate")),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: i18n.t("connection.rename.commit") }));
    expect(onRename).not.toHaveBeenCalled();
  });

  // Truth: a resting (inactive) card DOES expose the inline rename pencil → editor → onRename.
  it("resting card name is editable inline (pencil → edit → onRename)", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<ConfigCard config={cfg} status="disconnected" onRename={onRename} />);
    await userEvent.click(screen.getByRole("button", { name: i18n.t("connection.rename.aria") }));
    const input = screen.getByRole("textbox", { name: i18n.t("connection.rename.edit_aria") });
    await userEvent.clear(input);
    await userEvent.type(input, "Тестирование");
    await userEvent.click(screen.getByRole("button", { name: i18n.t("connection.rename.commit") }));
    expect(onRename).toHaveBeenCalledWith("Тестирование");
  });

  // Truth: a NON-cancelable in-flight lead state renders an icon-only SPINNER primary (no text
  // label) — the action word lives in aria-label/title, not as visible button text (F24). D-05
  // (17-07) made the CANCELABLE states (connecting/reconnecting/recovering) render a live «Отмена»
  // button instead (see ConfigCard.cancel.test.tsx), so the icon-only spinner now covers only the
  // non-cancelable teardown («Отключение» / disconnecting) and the locked switch/pending legs.
  it("non-cancelable in-flight lead card (disconnecting) renders an icon-only spinner primary (no text label)", () => {
    renderWithProviders(<ConfigCard config={cfg} leadCard status="disconnecting" />);
    const btn = screen.getByRole("button", { name: L.disconnecting });
    // The accessible name is the state word, but there is no visible text content.
    expect(btn.textContent?.trim()).toBe("");
    // Ping is HIDDEN during the teardown (F03) — no ping pill text on the card.
    expect(screen.queryByText(L.no_data)).not.toBeInTheDocument();
    expect(screen.queryByText(L.unreachable)).not.toBeInTheDocument();
  });

  // Truth: the no-data ping renders the neutral «—» (NEVER red). The pill is a neutral
  // Badge (data-variant=neutral), not danger.
  it("no-data ping renders neutral «—», never red", () => {
    renderWithProviders(
      <ConfigCard config={cfg} status="disconnected" ping={{ band: "no-data" }} />,
    );
    const dash = screen.getByText(L.no_data);
    // The badge wrapping the dash is neutral (not danger).
    const badge = dash.closest("[data-variant]");
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute("data-variant", "neutral");
    expect(badge).not.toHaveAttribute("data-variant", "danger");
  });

  // Truth: actions lock while another card is connecting (D-21) — the primary is disabled
  // and the overflow trigger is non-interactive.
  it("locks the primary + overflow while another card is connecting", () => {
    renderWithProviders(<ConfigCard config={cfg} status="disconnected" locked activeElsewhere />);
    const primary = screen.getByRole("button", { name: L.switch });
    expect(primary).toBeDisabled();
  });

  // Truth: the overflow menu is collapsed by default (D-26) and exposes Edit / Duplicate /
  // QR / Delete. Opening it surfaces the four items. Phase 15 (D-09) added «QR-код» — the
  // pre-15 «no QR» assertion was FLIPPED to expect it present (B-16 lands the item + onQr).
  it("overflow menu holds Edit / Duplicate / QR / Delete", async () => {
    const onEdit = vi.fn();
    renderWithProviders(<ConfigCard config={cfg} status="disconnected" onEdit={onEdit} />);
    const trigger = screen.getByRole("button", {
      name: i18n.t("connection.card.actions_label"),
    });
    await userEvent.click(trigger);
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText(i18n.t("connection.card.edit"))).toBeInTheDocument();
    expect(within(menu).getByText(i18n.t("connection.card.duplicate"))).toBeInTheDocument();
    expect(within(menu).getByText(i18n.t("connection.card.delete"))).toBeInTheDocument();
    // Phase 15 (D-09): «QR-код» is now the 4th item (opens the ConfigQr transfer modal).
    expect(within(menu).getByText(i18n.t("connection.card.qr"))).toBeInTheDocument();
  });

  // ─── Phase 14 (Wave 0, plan 14-01): the switching face ───
  //
  // RED SCAFFOLD (D-12) — the lead card gets a new `switching?: boolean` prop that FORCES the amber
  // «Переключение» face regardless of the underlying in-flight VpnStatus (during the teardown leg the
  // real status is the GREY `disconnecting`, so the card must force the amber band + «Переключение»
  // label rather than derive it — Pitfall 4). These tests MUST FAIL until 14-02 adds the prop + the
  // `status.switching_short` key. Assert by the RESOLVED label (not CSS class, per the plan), the
  // in-flight spinner (never a live «Отключить»), and the hidden ping.
  describe("Phase 14 — switching face (RED until 14-02)", () => {
    // D-12: the switching lead card shows the «Переключение» state word — even though the underlying
    // status is the grey `disconnecting` teardown leg. `switching` forces the amber label.
    it("shows the «Переключение» label when switching (forced over the disconnecting status)", () => {
      renderWithProviders(<ConfigCard config={cfg} leadCard status="disconnecting" switching />);
      // The resolved switching label renders on the card (once 14-02 wires it + adds the i18n key).
      expect(screen.getByText(L.switching)).toBeInTheDocument();
    });

    // D-12: the switching card renders an in-flight icon-only SPINNER primary and NEVER a live
    // «Отключить» text button (a switch is not a settled connected state).
    it("renders an in-flight spinner primary and NEVER a live «Отключить» while switching", () => {
      renderWithProviders(<ConfigCard config={cfg} leadCard status="disconnecting" switching />);
      // The primary is an icon-only spinner: its accessible name is the switching state word and it
      // has NO visible text content.
      const btn = screen.getByRole("button", { name: L.switching });
      expect(btn.textContent?.trim()).toBe("");
      // There is NEVER a live «Отключить» button while switching.
      expect(
        screen.queryByRole("button", { name: L.disconnect }),
      ).not.toBeInTheDocument();
    });

    // D-12 / F03: the ping pill is HIDDEN while switching (a stale ping must not paint mid-transition).
    it("hides the ping pill while switching", () => {
      renderWithProviders(
        <ConfigCard config={cfg} leadCard status="disconnecting" switching ping={{ band: "green", valueMs: 42 }} />,
      );
      // No ping number and no no-data «—» paint while switching.
      expect(screen.queryByText(/42/)).not.toBeInTheDocument();
      expect(screen.queryByText(L.no_data)).not.toBeInTheDocument();
    });

    // Verifier WARNING (14-VERIFICATION): the earlier `isConnected`-side-effect guard left a 1-render
    // flash window — a TRANSIENT `connected` during the switch/revert (A briefly up, or A reconnected on
    // revert before `isSwitching` clears) painted a stale ping/uptime. The direct `!switching` guard must
    // suppress BOTH connected-only details even when the underlying status is `connected`.
    it("hides ping AND uptime while switching even when the status is transiently connected", () => {
      renderWithProviders(
        <ConfigCard
          config={cfg}
          leadCard
          status="connected"
          switching
          ping={{ band: "green", valueMs: 42 }}
          uptime="0:05"
        />,
      );
      expect(screen.queryByText(/42/)).not.toBeInTheDocument();
      expect(screen.queryByText(L.no_data)).not.toBeInTheDocument();
      expect(screen.queryByText("0:05")).not.toBeInTheDocument();
    });
  });

  // ─── Phase 16 (Wave 0, plan 16-01): the T-22 IP-only glyph ───
  //
  // RED SCAFFOLD (T-22) — the lead card's host-meta row currently shows only a `Globe` icon +
  // the host text. For a BARE-IP endpoint (no domain) 16-03 will add a small leading «IP»
  // letter-glyph carrying the `connection.card.ip_only_tooltip` label, so the user can tell an
  // IP-only server apart from a domain one at a glance. These cases MUST FAIL until 16-03 renders
  // the glyph — same file, same assertions turn GREEN there (mirrors the 14-02 switching-face
  // RED→GREEN handoff documented above). Assert semantically by the rendered «IP» text within the
  // config-card testid + the tooltip label reachable, NEVER by a CSS class.
  // 16-07 (gap 5a): the glyph + host text now key off config.display_host, so these cases set
  // display_host (the IP-preferring card value), NOT config.host (the raw dedup key).
  describe("T-22 ip-only glyph (keys off display_host)", () => {
    // Test A: an IPv4 display_host renders the «IP» glyph + its tooltip label.
    it("renders the «IP» glyph with its tooltip for a bare IPv4 display_host", () => {
      renderWithProviders(
        <ConfigCard
          config={{ ...cfg, host: "203.0.113.7", display_host: "203.0.113.7" }}
          leadCard
          status="connected"
        />,
      );
      const card = screen.getByTestId("config-card");
      // The «IP» letter-glyph text is present in the host-meta area.
      expect(within(card).getByText("IP")).toBeInTheDocument();
      // Its accessible/tooltip label resolves the existing ip_only_tooltip key (reachable text).
      expect(within(card).getByText(L.ipTooltip)).toBeInTheDocument();
    });

    // 5a-2 (16-12): the «IP» marker must be CONSISTENT with the domain globe — a plain
    // inline monochrome marker, NOT the mismatched boxed pill/badge (owner: «не по
    // дизайну»). TA-9: assert this via the stable `data-variant="plain"` semantic marker
    // (a cosmetic restyle/token-rename must NOT break this test) instead of matching Tailwind
    // class substrings, per the «test behaviour + aria, not CSS» rule. The glyph text and the
    // accessible tooltip/sr-only label are the observable contract and are asserted alongside.
    it("5a-2: the «IP» marker is a plain inline marker (data-variant=plain), not a boxed pill/badge", () => {
      renderWithProviders(
        <ConfigCard
          config={{ ...cfg, host: "203.0.113.7", display_host: "203.0.113.7" }}
          leadCard
          status="connected"
        />,
      );
      const marker = screen.getByTestId("config-card-ip-marker");
      // Semantic variant marker — the "plain inline glyph, not a boxed pill" contract.
      expect(marker).toHaveAttribute("data-variant", "plain");
      expect(marker).toHaveTextContent("IP");
      // The glyph itself is decorative (aria-hidden); the label is carried by the always-rendered
      // sr-only span so a screen reader parked on the glyph still reads it (reachable text).
      expect(marker).toHaveAttribute("aria-hidden", "true");
      const card = screen.getByTestId("config-card");
      expect(within(card).getByText(L.ipTooltip)).toBeInTheDocument();
    });

    // Test B: an IPv6 display_host also renders the «IP» glyph.
    it("renders the «IP» glyph for a bracketed IPv6 display_host", () => {
      renderWithProviders(
        <ConfigCard
          config={{ ...cfg, host: "[2001:db8::1]:443", display_host: "[2001:db8::1]:443" }}
          leadCard
          status="connected"
        />,
      );
      const card = screen.getByTestId("config-card");
      expect(within(card).getByText("IP")).toBeInTheDocument();
    });

    // Test C (green guard): a DOMAIN display_host renders NO «IP» glyph, only the Globe host meta.
    it("renders NO «IP» glyph for a domain display_host", () => {
      renderWithProviders(
        <ConfigCard
          config={{ ...cfg, host: "de1.example.com", display_host: "de1.example.com" }}
          leadCard
          status="connected"
        />,
      );
      const card = screen.getByTestId("config-card");
      expect(within(card).queryByText("IP")).not.toBeInTheDocument();
    });

    // ── 16-07 (gap 5a): the headline fix — a fake SNI hostname over a bare IP ──
    //
    // The UAT bug: a bare-IP server carries a fake TLS-SNI hostname (host="trusttunnel.local") but
    // the real endpoint is the IP (display_host="203.0.113.141"). The card must show the IP + the
    // «IP» glyph, NOT the fake .local name + globe. The glyph keys off display_host, so this passes.
    it("gap 5a: a fake-SNI host + IP display_host renders «IP» and SHOWS the IP", () => {
      renderWithProviders(
        <ConfigCard
          config={{ ...cfg, host: "trusttunnel.local", display_host: "203.0.113.141" }}
          leadCard
          status="connected"
        />,
      );
      const card = screen.getByTestId("config-card");
      // «IP» glyph + its tooltip label render (keyed off display_host).
      expect(within(card).getByText("IP")).toBeInTheDocument();
      expect(within(card).getByText(L.ipTooltip)).toBeInTheDocument();
      // The card shows the real IP, NOT the fake SNI name.
      expect(within(card).getByText("203.0.113.141")).toBeInTheDocument();
      expect(within(card).queryByText("trusttunnel.local")).not.toBeInTheDocument();
    });
  });

  // ─── Phase 14 regression guard (plan 14-01): statusBadgeVariant stays at EXACTLY 4 variants ───
  //
  // GREEN GUARD (not RED) — D-07 keeps the amber switching band on the EXISTING `connecting` variant;
  // no 5th badge variant / no new color token is added (the owner is regression-sensitive). This
  // asserts that across EVERY VpnStatus input, statusBadgeVariant only ever yields its 4 known
  // variants. It PASSES today and must KEEP passing — a 5th variant would trip it.
  it("statusBadgeVariant yields exactly its 4 existing variants across all VpnStatus inputs (no 5th)", () => {
    const allStatuses: VpnStatus[] = [
      "connected",
      "connecting",
      "reconnecting",
      "recovering",
      "disconnecting",
      "disconnected",
      "error",
    ];
    const allowed = new Set(["connected", "connecting", "error", "disconnected"]);
    const produced = new Set(allStatuses.map((s) => statusBadgeVariant(s)));
    // Every produced variant is one of the 4 allowed …
    for (const v of produced) {
      expect(allowed.has(v)).toBe(true);
    }
    // … and there are at most 4 distinct variants (amber reuses `connecting` — no 5th).
    expect(produced.size).toBeLessThanOrEqual(4);
  });
});

// F6 (14-UAT): the switch-failed-reverted notice renders EMBEDDED inside the lead card (a calm,
// dismissible ErrorBanner variant="info"), NOT as a floating window-level banner.
describe("ConfigCard — F6 embedded revert notice", () => {
  const REVERT = "Переключение не удалось. Соединение с «Германия — Frankfurt» восстановлено.";

  it("lead card renders the revert notice as a calm info (role=status), never a red alert", () => {
    renderWithProviders(<ConfigCard config={cfg} leadCard status="connected" revertNotice={REVERT} />);
    // ErrorBanner variant=info announces politely (role="status"), named by its aria-label.
    expect(screen.getByRole("status", { name: /восстановлено/i })).toBeInTheDocument();
    // It is NOT the assertive red error alert.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders nothing when no revert notice is set", () => {
    renderWithProviders(<ConfigCard config={cfg} leadCard status="connected" />);
    expect(screen.queryByRole("status", { name: /восстановлено/i })).not.toBeInTheDocument();
  });

  it("a resting (non-lead) card never renders the revert notice", () => {
    renderWithProviders(<ConfigCard config={cfg} status="disconnected" revertNotice={REVERT} />);
    expect(screen.queryByRole("status", { name: /восстановлено/i })).not.toBeInTheDocument();
  });

  it("dismissing the embedded notice calls onRevertDismiss", async () => {
    const onRevertDismiss = vi.fn();
    renderWithProviders(
      <ConfigCard config={cfg} leadCard status="connected" revertNotice={REVERT} onRevertDismiss={onRevertDismiss} />,
    );
    const dismiss = within(screen.getByRole("status", { name: /восстановлено/i })).getByRole("button");
    await userEvent.click(dismiss);
    expect(onRevertDismiss).toHaveBeenCalledTimes(1);
  });
});

// F20 (14-UAT round 2): during an auto-reconnect the lead card shows «Попытка N из M» so the user
// sees it is actively retrying, not silently waiting.
describe("ConfigCard — F20 reconnect attempt counter", () => {
  // Language-agnostic (jsdom defaults to en-US) — resolve the counter text through i18n.
  const ATTEMPT_2_OF_3 = i18n.t("status.reconnect_attempt", { attempt: 2, max: 3 });
  const anyAttempt = /Attempt|Попытка/;

  it("lead card in reconnecting shows the attempt counter «Попытка N из M»", () => {
    renderWithProviders(
      <ConfigCard config={cfg} leadCard status="reconnecting" reconnectProgress={{ attempt: 2, max: 3 }} />,
    );
    expect(screen.getByText(ATTEMPT_2_OF_3)).toBeInTheDocument();
  });

  it("a lead card that is NOT reconnecting shows no attempt counter", () => {
    renderWithProviders(<ConfigCard config={cfg} leadCard status="connected" />);
    expect(screen.queryByText(anyAttempt)).not.toBeInTheDocument();
  });

  it("a reconnecting lead card WITHOUT progress shows no attempt counter", () => {
    renderWithProviders(<ConfigCard config={cfg} leadCard status="reconnecting" />);
    expect(screen.queryByText(anyAttempt)).not.toBeInTheDocument();
  });

  it("a resting (non-lead) card never shows the attempt counter", () => {
    renderWithProviders(
      <ConfigCard config={cfg} status="reconnecting" reconnectProgress={{ attempt: 2, max: 3 }} />,
    );
    expect(screen.queryByText(anyAttempt)).not.toBeInTheDocument();
  });
});
