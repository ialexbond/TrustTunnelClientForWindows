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
  user: "swift-fox",
  path: "C:/app/TrustTunnel_swift-fox.toml",
  order: 0,
  last_used: true,
};
const cfgNl: ConfigSummary = {
  id: "cfg-nl-def67890",
  name: "Нидерланды",
  host: "nl.example.com",
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
});
