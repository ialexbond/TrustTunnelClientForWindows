import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { renderWithProviders } from "../../test/test-utils";
import { ConfigCard } from "./ConfigCard";
import type { ConfigSummary } from "../../shared/hooks/useConfigList";

// RED (15-01, B-16): the «QR-код» overflow item + the `onQr` prop do not exist
// yet — 15-03 adds them (D-09). Until then:
//   - `onQr` is not on ConfigCardProps → the @ts-expect-error below is REQUIRED
//     (typecheck would otherwise flag it), and turns into an error 15-03 must
//     remove once the prop lands.
//   - the menu has no «QR-код» item → getByText throws → the tests are RED.
// This pins the 4th overflow item (with the Lucide QrCode glyph), its onQr wiring,
// and D-09 (available for ANY config — no active/inactive state gating).

const cfg: ConfigSummary = {
  id: "cfg-de-abc12345",
  name: "Германия — Frankfurt",
  host: "de1.example.com",
  user: "swift-fox",
  path: "C:/app/TrustTunnel_swift-fox.toml",
  order: 0,
  last_used: true,
};

async function openMenu() {
  const trigger = screen.getByRole("button", {
    name: i18n.t("connection.card.actions_label"),
  });
  await userEvent.click(trigger);
  return screen.getByRole("menu");
}

describe("ConfigCard — «QR-код» overflow item (B-16)", () => {
  it("exposes a 4th «QR-код» overflow item that calls onQr once when selected", async () => {
    const onQr = vi.fn();
    renderWithProviders(
      <ConfigCard config={cfg} status="disconnected" onQr={onQr} />,
    );
    const menu = await openMenu();

    const qrItem = within(menu).getByText(i18n.t("connection.card.qr"));
    expect(qrItem).toBeInTheDocument();
    // The item carries a Lucide glyph (an <svg> inside the menuitem button).
    const qrMenuItem = qrItem.closest('[role="menuitem"]');
    expect(qrMenuItem?.querySelector("svg")).toBeInTheDocument();

    await userEvent.click(qrItem);
    expect(onQr).toHaveBeenCalledTimes(1);
  });

  it("shows «QR-код» for BOTH an active and an inactive config (D-09 — no state gating)", async () => {
    // Active (connected lead) config.
    const onQrActive = vi.fn();
    const { unmount } = renderWithProviders(
      <ConfigCard config={cfg} leadCard status="connected" onQr={onQrActive} />,
    );
    let menu = await openMenu();
    const activeItem = within(menu).getByText(i18n.t("connection.card.qr"));
    expect(activeItem).toBeInTheDocument();
    // Not disabled by connected state (only the existing D-21 `locked` may disable it).
    expect(activeItem.closest('[role="menuitem"]')).not.toBeDisabled();
    unmount();

    // Inactive (disconnected) config.
    const onQrInactive = vi.fn();
    renderWithProviders(
      <ConfigCard config={cfg} status="disconnected" onQr={onQrInactive} />,
    );
    menu = await openMenu();
    expect(within(menu).getByText(i18n.t("connection.card.qr"))).toBeInTheDocument();
  });
});
