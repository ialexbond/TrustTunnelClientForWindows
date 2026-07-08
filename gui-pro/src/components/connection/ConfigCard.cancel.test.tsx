import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { renderWithProviders } from "../../test/test-utils";
import { ConfigCard } from "./ConfigCard";
import type { ConfigSummary } from "../../shared/hooks/useConfigList";
import type { VpnStatus } from "../../shared/types";

// Phase 17 Wave 0 (17-01) — RED (GREEN by 17-07). BUG-A2 (17-uat) narrowed the live-cancel states.
//
// D-05 / BUG-A2: the Connection tab's lead card exposes a LIVE «Отмена» button ONLY for the states
// where the App's race-safe cancel is GUARANTEED to work — `connecting` / `recovering` (where the
// shared `reconnectResolve` latch is null). `reconnecting` is AMBIGUOUS (it is BOTH a backend
// auto-retry — safe — AND a FE save-and-reconnect whose teardown ARMS the latch — the cancel would be
// inert), so from status alone it cannot offer a working cancel and must render the INERT spinner —
// never a live-but-dead button. It mirrors the SAME affordance StatusPanel offers (StatusPanel.tsx:169),
// threading the reused race-safe `handleUserCancel` → `vpn_disconnect` (no new backend command).
//
// The teardown itself («Отключение» / disconnecting) and `reconnecting` are NON-cancelable here — the
// live button must be HIDDEN there (mirror StatusPanel). Semantic queries only (role/name) — never CSS.

const CANCEL = i18n.t("buttons.cancel");

const cfg: ConfigSummary = {
  id: "cfg-de-abc12345",
  name: "Германия — Frankfurt",
  host: "de1.example.com",
  display_host: "de1.example.com",
  user: "swift-fox",
  path: "C:/app/TrustTunnel_swift-fox.toml",
  order: 0,
  last_used: true,
};

// `onDisconnect` is the prop 17-07 adds to ConfigCard (wired to useVpnActions.handleDisconnect).
// It does not exist yet — passing it is harmless now; the assertions on the rendered button are
// what make this RED.
type CancelProps = { onDisconnect?: () => void };

describe("ConfigCard — D-05/BUG-A2 cancel button on the lead card", () => {
  // BUG-A2: the LIVE cancel shows ONLY for the reconnectResolve-null (works-cancel) states.
  for (const status of ["connecting", "recovering"] as VpnStatus[]) {
    it(`renders an «Отмена» button on the lead card when status = ${status}`, () => {
      renderWithProviders(
        <ConfigCard config={cfg} leadCard status={status} {...({} as CancelProps)} onDisconnect={vi.fn()} />,
      );
      const cancel = screen.getByRole("button", { name: CANCEL });
      expect(cancel).toBeInTheDocument();
      expect(cancel).toBeEnabled();
    });
  }

  // BUG-A2: `reconnecting` is AMBIGUOUS (a FE save-and-reconnect arms the shared latch → the cancel
  // would be a dead no-op), so it renders the INERT spinner — NO live «Отмена». `disconnecting` (the
  // non-cancelable teardown) is HIDDEN the same way (mirror StatusPanel). This is the regression guard
  // that the show-condition never offers a live-but-dead cancel during an armed-latch FE reconnect.
  for (const status of ["reconnecting", "disconnecting"] as VpnStatus[]) {
    it(`HIDES the live «Отмена» while status = ${status} (inert spinner instead)`, () => {
      renderWithProviders(
        <ConfigCard config={cfg} leadCard status={status} onDisconnect={vi.fn()} />,
      );
      expect(screen.queryByRole("button", { name: CANCEL })).not.toBeInTheDocument();
    });
  }

  // BUG-A2: a seamless A→B switch is self-terminating; its controls are locked to the inert spinner
  // (never a live cancel — D-12). Assert no live «Отмена» while `switching`.
  it("HIDES the live «Отмена» while switching (seamless switch shows the inert spinner)", () => {
    renderWithProviders(
      <ConfigCard config={cfg} leadCard status="connecting" switching onDisconnect={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: CANCEL })).not.toBeInTheDocument();
  });

  it("clicking «Отмена» calls onDisconnect (the reused handleDisconnect → vpn_disconnect)", async () => {
    const onDisconnect = vi.fn();
    renderWithProviders(
      <ConfigCard config={cfg} leadCard status="connecting" onDisconnect={onDisconnect} />,
    );
    await userEvent.click(screen.getByRole("button", { name: CANCEL }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});

// BUG-A2 (17-uat): the live «Отмена» SHOWS during a plain connect EVEN WHILE connectPending is true.
// handleConnectActive raises pendingConnectPath (→ connectPending) for the WHOLE connecting span, and
// handleUserCancel is SAFE during connecting/recovering (reconnectResolve null), so hiding it there is
// the exact "нет кнопки отмены при обычном подключении" bug. Only `reconnecting` (ambiguous armed-latch)
// stays inert. This is the dead-window the old F6 tests missed (they hid the cancel on connectPending).
describe("ConfigCard — BUG-A2: cancel shows during a plain connect (connectPending)", () => {
  const SPINNER_LABEL: Record<string, string> = {
    reconnecting: i18n.t("status.reconnecting_short"),
  };
  // connecting/recovering + connectPending → the LIVE, working «Отмена» (the fix).
  for (const status of ["connecting", "recovering"] as VpnStatus[]) {
    it(`shows a LIVE, working «Отмена» when connectPending + status = ${status} (plain connect)`, async () => {
      const onDisconnect = vi.fn();
      renderWithProviders(
        <ConfigCard config={cfg} leadCard status={status} connectPending onDisconnect={onDisconnect} />,
      );
      const cancel = screen.getByRole("button", { name: CANCEL });
      expect(cancel).toBeEnabled();
      await userEvent.click(cancel);
      expect(onDisconnect).toHaveBeenCalledTimes(1);
    });
  }

  // reconnecting stays inert regardless of connectPending (ambiguous armed-latch FE reconnect).
  it("shows the inert spinner (no live «Отмена») when connectPending + status = reconnecting", () => {
    renderWithProviders(
      <ConfigCard config={cfg} leadCard status="reconnecting" connectPending onDisconnect={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: CANCEL })).not.toBeInTheDocument();
    const inert = screen.getByRole("button", { name: SPINNER_LABEL.reconnecting });
    expect(inert).toBeDisabled();
  });

  it("still shows a LIVE, working «Отмена» during an ordinary connecting (connectPending absent)", async () => {
    const onDisconnect = vi.fn();
    renderWithProviders(
      <ConfigCard config={cfg} leadCard status="connecting" onDisconnect={onDisconnect} />,
    );
    const cancel = screen.getByRole("button", { name: CANCEL });
    expect(cancel).toBeEnabled();
    await userEvent.click(cancel);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});
