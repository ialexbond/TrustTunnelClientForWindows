import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRef } from "react";
import { screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { renderWithProviders } from "../../test/test-utils";
import { ConnectionPanel, type ConnectionPanelHandle } from "./ConnectionPanel";
import type { ConfigSummary } from "../../shared/hooks/useConfigList";
import {
  isSelfDeleting,
  clearSelfDelete,
  resetSelfDeleteGuard,
} from "../../shared/utils/selfDeleteGuard";

// IN-40: jsdom gives every element a 0 layout, so install a fake geometry on the scroll
// container to simulate "at bottom" vs "scrolled up". scrollTop is a real, settable jsdom
// property — we read it back to assert whether the panel force-scrolled the list.
function makeScrollable(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
}

// ── Tauri mocks ──────────────────────────────────────────────────────────────
// invoke is the single IPC seam. list_configs drives the rendered list; the mutation
// commands (delete_config / duplicate_config / rename_config) are the manifest writes the
// panel routes through. ping_config_endpoint is no-data (harmless).
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const TWO: ConfigSummary[] = [
  { id: "cfg-a", name: "Германия — Frankfurt", host: "de1.example.com", display_host: "de1.example.com", user: "swift-fox", path: "C:/app/a.toml", order: 0, last_used: true },
  { id: "cfg-b", name: "Нидерланды", host: "nl1.example.com", display_host: "nl1.example.com", user: "calm-owl", path: "C:/app/b.toml", order: 1, last_used: false },
];
const ONE: ConfigSummary[] = [TWO[0]];
const EMPTY: ConfigSummary[] = [];
const THREE: ConfigSummary[] = [
  ...TWO,
  { id: "cfg-c", name: "Швеция", host: "se1.example.com", display_host: "se1.example.com", user: "brave-elk", path: "C:/app/c.toml", order: 2, last_used: false },
];

const L = {
  switch: i18n.t("connection.card.switch"),
  empty: i18n.t("connection.empty.heading"),
  deleteConfirm: i18n.t("connection.delete.confirm"),
};

function setup(props?: Partial<Parameters<typeof ConnectionPanel>[0]>) {
  const onImport = vi.fn();
  const onConnect = vi.fn();
  const onDisconnect = vi.fn().mockResolvedValue(undefined);
  const onSwitchTo = vi.fn();
  const onReconnect = vi.fn().mockResolvedValue(undefined);
  renderWithProviders(
    <ConnectionPanel
      onImport={onImport}
      status="disconnected"
      activeConfigPath=""
      onConnect={onConnect}
      onDisconnect={onDisconnect}
      onSwitchTo={onSwitchTo}
      onReconnect={onReconnect}
      {...props}
    />,
  );
  return { onImport, onConnect, onDisconnect, onSwitchTo, onReconnect };
}

describe("ConnectionPanel (production integration)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    // TA-8: the selfDeleteGuard is a module-level singleton shared across ALL tests. Reset it (and
    // cancel any live 8000 ms TTL timer) before AND after each test so a mark leaked by one test's
    // real delete flow cannot bleed a stale mark / a pending timer into a sibling (order-dependent
    // flake, and a live timer leaking into the neighbouring secondVpn suite).
    resetSelfDeleteGuard();
  });

  afterEach(() => {
    resetSelfDeleteGuard();
  });

  // Truth: «Переключиться» on an inactive card calls onSwitchTo (the switchTo VPN action) —
  // a tunnel is active on another config (activeConfigPath set to the lead's path).
  it("«Переключиться» on an inactive card invokes onSwitchTo", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_configs") return Promise.resolve(TWO);
      if (cmd === "ping_config_endpoint") return Promise.resolve({ status: "no-data" });
      return Promise.resolve(null);
    });
    // The lead (cfg-a) is the active path → cfg-b is the inactive card whose primary reads
    // «Переключиться».
    const { onSwitchTo } = setup({ status: "connected", activeConfigPath: "C:/app/a.toml" });

    // Wait for the list to render both cards.
    await screen.findByText("Нидерланды");
    const switchBtns = await screen.findAllByRole("button", { name: L.switch });
    // cfg-b's card carries «Переключиться»; click it.
    await user.click(switchBtns[0]);
    expect(onSwitchTo).toHaveBeenCalledWith("C:/app/b.toml");
  });

  // Truth: deleting the LAST config returns the list to empty-no-configs. delete_config →
  // reload (now returns the empty manifest) → ConfigList renders the empty state.
  it("deleting the last config returns the list to empty-no-configs", async () => {
    const user = userEvent.setup();
    // First list_configs → ONE; after delete the reload returns EMPTY.
    let listCallCount = 0;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_configs") {
        listCallCount += 1;
        return Promise.resolve(listCallCount === 1 ? ONE : EMPTY);
      }
      if (cmd === "delete_config") return Promise.resolve(EMPTY);
      if (cmd === "ping_config_endpoint") return Promise.resolve({ status: "no-data" });
      return Promise.resolve(null);
    });
    setup();

    await screen.findByText("Германия — Frankfurt");

    // Open the overflow menu and click «Удалить».
    const actions = screen.getByRole("button", { name: i18n.t("connection.card.actions_label") });
    await user.click(actions);
    const menu = screen.getByRole("menu");
    await user.click(within(menu).getByText(i18n.t("connection.card.delete")));

    // The danger ConfirmDialog opens — confirm it.
    const confirmBtn = await screen.findByRole("button", { name: L.deleteConfirm });
    await user.click(confirmBtn);

    // delete_config fired with the config id, and the list reloaded to empty.
    await waitFor(() => {
      expect(invokeMock.mock.calls.some((c) => c[0] === "delete_config" && (c[1] as { id: string }).id === "cfg-a")).toBe(true);
    });
    await screen.findByTestId("empty-no-configs");
    expect(screen.getByText(L.empty)).toBeInTheDocument();
  });

  // Truth: «Дублировать» calls duplicate_config then reloads.
  it("«Дублировать» invokes duplicate_config", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_configs") return Promise.resolve(ONE);
      if (cmd === "duplicate_config") return Promise.resolve(ONE);
      if (cmd === "ping_config_endpoint") return Promise.resolve({ status: "no-data" });
      return Promise.resolve(null);
    });
    setup();
    await screen.findByText("Германия — Frankfurt");

    const actions = screen.getByRole("button", { name: i18n.t("connection.card.actions_label") });
    await user.click(actions);
    const menu = screen.getByRole("menu");
    await user.click(within(menu).getByText(i18n.t("connection.card.duplicate")));

    await waitFor(() => {
      expect(invokeMock.mock.calls.some((c) => c[0] === "duplicate_config" && (c[1] as { id: string }).id === "cfg-a")).toBe(true);
    });
  });

  // Truth: an active-config delete disconnects BEFORE deleting (disconnect-then-delete, D-03).
  it("active-config delete disconnects before delete_config (D-03)", async () => {
    const user = userEvent.setup();
    const callOrder: string[] = [];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_configs") return Promise.resolve(ONE);
      if (cmd === "delete_config") { callOrder.push("delete_config"); return Promise.resolve(EMPTY); }
      if (cmd === "ping_config_endpoint") return Promise.resolve({ status: "no-data" });
      return Promise.resolve(null);
    });
    const onDisconnect = vi.fn().mockImplementation(() => { callOrder.push("disconnect"); return Promise.resolve(); });
    // cfg-a is the active config (its path matches activeConfigPath).
    setup({ status: "connected", activeConfigPath: "C:/app/a.toml", onDisconnect });

    await screen.findByText("Германия — Frankfurt");
    const actions = screen.getByRole("button", { name: i18n.t("connection.card.actions_label") });
    await user.click(actions);
    const menu = screen.getByRole("menu");
    await user.click(within(menu).getByText(i18n.t("connection.card.delete")));

    // The ACTIVE confirm copy uses the «Отключить и удалить» label.
    const confirmBtn = await screen.findByRole("button", { name: i18n.t("connection.delete.confirm_active") });
    await user.click(confirmBtn);

    await waitFor(() => expect(callOrder).toEqual(["disconnect", "delete_config"]));
  });

  // #7 (Fable re-review): the self-delete mark must be armed AFTER the disconnect leg completes,
  // immediately before delete_config — NOT before the disconnect. If it were armed first, a SLOW
  // teardown (up to ~7s: graceful + hard-kill + DNS restore) could outlast the guard's TTL,
  // so the mark would already be gone by the time the fs Remove landed → the watcher would fire a
  // second red snackbar on top of the green success (the B2 double-snackbar bug resurfacing on its
  // flagship case: deleting the ACTIVE config while CONNECTED). Assert: at the instant delete_config
  // is invoked (which only happens AFTER onDisconnect resolves), the active path IS marked — so a
  // long disconnect cannot expire the mark before the file is even removed.
  it("#7: an active-config delete arms the self-delete mark AFTER a slow disconnect, right before delete_config", async () => {
    const user = userEvent.setup();
    // The beforeEach resetSelfDeleteGuard() already cleared any residual mark (guard is a singleton).
    let markedWhenDeleteInvoked: boolean | null = null;
    let markedDuringDisconnect: boolean | null = null;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_configs") return Promise.resolve(ONE);
      if (cmd === "delete_config") {
        // Capture the guard state at the exact moment the file is about to be removed.
        markedWhenDeleteInvoked = isSelfDeleting("C:/app/a.toml");
        return Promise.resolve(EMPTY);
      }
      if (cmd === "ping_config_endpoint") return Promise.resolve({ status: "no-data" });
      return Promise.resolve(null);
    });
    // A SLOW disconnect that resolves after a real delay; during it, the path must NOT yet be
    // marked (the mark is deferred to after the disconnect) so the TTL clock has not started early.
    const onDisconnect = vi.fn().mockImplementation(async () => {
      markedDuringDisconnect = isSelfDeleting("C:/app/a.toml");
      await new Promise((r) => setTimeout(r, 50));
    });
    setup({ status: "connected", activeConfigPath: "C:/app/a.toml", onDisconnect });

    await screen.findByText("Германия — Frankfurt");
    const actions = screen.getByRole("button", { name: i18n.t("connection.card.actions_label") });
    await user.click(actions);
    const menu = screen.getByRole("menu");
    await user.click(within(menu).getByText(i18n.t("connection.card.delete")));

    const confirmBtn = await screen.findByRole("button", { name: i18n.t("connection.delete.confirm_active") });
    await user.click(confirmBtn);

    await waitFor(() => expect(invokeMock.mock.calls.some((c) => c[0] === "delete_config")).toBe(true));
    try {
      // The mark was NOT armed during the disconnect leg (so a long teardown cannot expire it early)…
      expect(markedDuringDisconnect).toBe(false);
      // …but IS armed by the time delete_config removes the file (covering the fs Remove event).
      expect(markedWhenDeleteInvoked).toBe(true);
    } finally {
      // TA-8: clear in a finally so an assertion failure above can't leak the mark + its live TTL
      // timer into a sibling test. (afterEach's resetSelfDeleteGuard is the backstop.)
      clearSelfDelete("C:/app/a.toml");
    }
  });

  // Truth (11-UAT gap A): a machine upgraded from the old single-config build can hold ONE
  // server as TWO physical .toml files (legacy trusttunnel_client.toml + wizard
  // TrustTunnel_<user>.toml), which migration keeps as two manifest entries. The panel collapses
  // same-server (host+user) twins into a single card, keeping the connected file as the survivor.
  it("collapses two same-server files (host+user) into a single card", async () => {
    const DUP: ConfigSummary[] = [
      { id: "legacy", name: "Германия — Frankfurt", host: "de1.example.com", display_host: "de1.example.com", user: "swift-fox", path: "C:/app/trusttunnel_client.toml", order: 1, last_used: false },
      { id: "wizard", name: "Германия — Frankfurt", host: "de1.example.com", display_host: "de1.example.com", user: "swift-fox", path: "C:/app/TrustTunnel_swift-fox.toml", order: 0, last_used: true },
    ];
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_configs") return Promise.resolve(DUP);
      if (cmd === "ping_config_endpoint") return Promise.resolve({ status: "no-data" });
      return Promise.resolve(null);
    });
    // The tunnel runs through the wizard file → it is the surviving (connected, lead) card.
    setup({ status: "connected", activeConfigPath: "C:/app/TrustTunnel_swift-fox.toml" });

    await screen.findByText("Германия — Frankfurt");
    expect(screen.getAllByTestId("config-card")).toHaveLength(1);
    // The single surviving card is the connected lead → its primary is «Отключить».
    expect(screen.getByRole("button", { name: i18n.t("connection.card.disconnect") })).toBeInTheDocument();
  });
});

// IN-45 (reveal-to-bottom on a USER add) + IN-49 (scroll is preserved NATIVELY — no custom restore;
// the only deliberate scroll move is the user-add reveal). jsdom has no real layout, so we fake the
// scroll geometry on the panel's single overflow-y-auto container.
describe("ConnectionPanel scroll behavior (IN-45/IN-49)", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    resetSelfDeleteGuard(); // TA-8: keep the singleton clean between suites too.
  });

  afterEach(() => {
    resetSelfDeleteGuard();
  });

  function renderPanel() {
    const ref = createRef<ConnectionPanelHandle>();
    const utils = renderWithProviders(
      <ConnectionPanel
        ref={ref}
        onImport={vi.fn()}
        status="disconnected"
        activeConfigPath=""
        onConnect={vi.fn()}
        onDisconnect={vi.fn().mockResolvedValue(undefined)}
        onSwitchTo={vi.fn()}
        onReconnect={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    return { ref, ...utils };
  }

  function scroller(container: HTMLElement): HTMLElement {
    return container.querySelector(".overflow-y-auto") as HTMLElement;
  }

  // IN-45: a USER-initiated add (reload path → reveal flag) snaps the new card into view with an
  // INSTANT jump (scrollTop === scrollHeight), even when the user had scrolled UP.
  it("snaps to the new card on a user add (reload path), even scrolled up", async () => {
    let configs = TWO;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_configs") return Promise.resolve(configs);
      if (cmd === "ping_config_endpoint") return Promise.resolve({ status: "no-data" });
      return Promise.resolve(null);
    });
    const { ref, container } = renderPanel();
    await screen.findByText("Нидерланды");
    const el = scroller(container);
    makeScrollable(el, 1100, 200);
    el.scrollTop = 100; // scrolled UP
    configs = THREE;
    await act(async () => {
      ref.current!.reload(); // user add → reveal flag set
    });
    await screen.findByText("Швеция");
    await waitFor(() => expect(el.scrollTop).toBe(1100));
  });

  // IN-45: a PASSIVE add (fs-watcher silent refresh(), no reveal flag) must NOT move the view.
  it("does NOT scroll on a passive refresh add", async () => {
    let configs = TWO;
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_configs") return Promise.resolve(configs);
      if (cmd === "ping_config_endpoint") return Promise.resolve({ status: "no-data" });
      return Promise.resolve(null);
    });
    const { ref, container } = renderPanel();
    await screen.findByText("Нидерланды");
    const el = scroller(container);
    makeScrollable(el, 1100, 200);
    el.scrollTop = 100;
    configs = THREE;
    await act(async () => {
      ref.current!.refresh(); // silent — must not move the view
    });
    await screen.findByText("Швеция"); // the new card rendered…
    expect(el.scrollTop).toBe(100); // …but the view did not move
  });

  // ─── Manual ping refresh (standalone path: the panel's OWN usePerConfigPing) ───
  //
  // With no App `source` injected the panel runs its internal ping loop, which is now MANUAL. Assert
  // the wiring end-to-end: no ping fires on mount (auto interval removed), and clicking the «Обновить
  // пинг» button runs one round — ping_config_endpoint invoked once per config.
  it("does NOT ping on mount, and the refresh button pings every config once on click", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "list_configs") return Promise.resolve(TWO);
      if (cmd === "ping_config_endpoint") return Promise.resolve({ status: "ok", ms: 42 });
      return Promise.resolve(null);
    });
    setup();

    // Both cards render…
    await screen.findByText("Нидерланды");
    // …and NO ping fired automatically (the auto interval / on-mount ping is gone).
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "ping_config_endpoint").length,
    ).toBe(0);

    // Click «Обновить пинг» → exactly one round: one probe per config (TWO configs → 2 probes).
    await user.click(
      screen.getByRole("button", { name: i18n.t("connection.refresh_pings") }),
    );
    await waitFor(() =>
      expect(
        invokeMock.mock.calls.filter((c) => c[0] === "ping_config_endpoint").length,
      ).toBe(2),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "ping_config_endpoint",
      expect.objectContaining({ configPath: "C:/app/a.toml" }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "ping_config_endpoint",
      expect.objectContaining({ configPath: "C:/app/b.toml" }),
    );
  });
});
