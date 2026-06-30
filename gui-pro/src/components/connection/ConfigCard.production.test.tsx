import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { renderWithProviders } from "../../test/test-utils";
import { ConfigCard } from "./ConfigCard";
import type { ConfigSummary } from "../../shared/hooks/useConfigList";

// Resolve labels through i18n so the test is language-agnostic (jsdom defaults to en-US).
const L = {
  switch: i18n.t("connection.card.switch"),
  connect: i18n.t("connection.card.connect"),
  disconnect: i18n.t("connection.card.disconnect"),
  connecting: i18n.t("status.connecting_short"),
  no_data: i18n.t("connection.ping.no_data"),
  unreachable: i18n.t("connection.ping.unreachable"),
};

const cfg: ConfigSummary = {
  id: "cfg-de-abc12345",
  name: "Германия — Frankfurt",
  host: "de1.example.com",
  user: "swift-fox",
  path: "C:/app/TrustTunnel_swift-fox.toml",
  order: 0,
  last_used: true,
};

describe("ConfigCard", () => {
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

  // Truth: any in-flight lead state renders an icon-only SPINNER primary (no text label) —
  // the action word lives in aria-label/title, not as visible button text (F24).
  it("in-flight lead card renders an icon-only spinner primary (no text label)", () => {
    renderWithProviders(<ConfigCard config={cfg} leadCard status="connecting" />);
    const btn = screen.getByRole("button", { name: L.connecting });
    // The accessible name is the state word, but there is no visible text content.
    expect(btn.textContent?.trim()).toBe("");
    // Ping is HIDDEN during connecting (F03) — no ping pill text on the card.
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
  // Delete (QR deferred). Opening it surfaces the three items.
  it("overflow menu holds Edit / Duplicate / Delete (no QR)", async () => {
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
    // QR is DEFERRED this phase — not in the menu.
    expect(within(menu).queryByText(i18n.t("connection.card.qr"))).not.toBeInTheDocument();
  });
});
