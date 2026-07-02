import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTabPersistence } from "./useTabPersistence";
import type { AppTab, VpnConfig, VpnStatus } from "../types";

// Characterization + regression suite for the app-shell persistence hook.
//
// The REGRESSION test at the bottom pins the owner-reported tab-switch scroll
// loss: the hook used to run `querySelectorAll('[class*="overflow"]')` →
// `el.scrollTop = 0` on every activeTab change, nuking the scroll position of
// every kept-mounted tab panel (plus any open modal / log overlay). The tab
// panels stay MOUNTED across switches, so the browser preserves scrollTop
// natively (IN-49) — the hook must never touch it. scrollTop is a real,
// settable property in jsdom (same technique as LogPanel.test.tsx), so a write
// by the hook would be observable here.

function makeParams(overrides: Partial<{
  activeTab: AppTab;
  config: VpnConfig;
  status: VpnStatus;
  connectedSince: Date | null;
}> = {}) {
  return {
    activeTab: overrides.activeTab ?? ("connection" as AppTab),
    config: overrides.config ?? ({ configPath: "C:/cfg/client.toml", logLevel: "info" } as VpnConfig),
    status: overrides.status ?? ("disconnected" as VpnStatus),
    connectedSince: overrides.connectedSince ?? null,
  };
}

describe("useTabPersistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // ── localStorage persistence (characterization) ────────────────────────────

  it("persists activeTab to tt_active_tab AND the backward-compat tt_active_page", () => {
    const { rerender } = renderHook((p) => useTabPersistence(p), {
      initialProps: makeParams({ activeTab: "connection" }),
    });
    expect(localStorage.getItem("tt_active_tab")).toBe("connection");
    expect(localStorage.getItem("tt_active_page")).toBe("connection");

    rerender(makeParams({ activeTab: "settings" }));
    expect(localStorage.getItem("tt_active_tab")).toBe("settings");
    expect(localStorage.getItem("tt_active_page")).toBe("settings");
  });

  it("persists config path + log level", () => {
    renderHook((p) => useTabPersistence(p), {
      initialProps: makeParams({ config: { configPath: "C:/cfg/a.toml", logLevel: "debug" } as VpnConfig }),
    });
    expect(localStorage.getItem("tt_config_path")).toBe("C:/cfg/a.toml");
    expect(localStorage.getItem("tt_log_level")).toBe("debug");
  });

  it("persists VPN status", () => {
    renderHook((p) => useTabPersistence(p), {
      initialProps: makeParams({ status: "connected" as VpnStatus }),
    });
    expect(localStorage.getItem("tt_vpn_status")).toBe("connected");
  });

  it("sets tt_connected_since while connected and clears it on null", () => {
    const since = new Date("2026-07-01T10:00:00.000Z");
    const { rerender } = renderHook((p) => useTabPersistence(p), {
      initialProps: makeParams({ connectedSince: since }),
    });
    expect(localStorage.getItem("tt_connected_since")).toBe(since.toISOString());

    rerender(makeParams({ connectedSince: null }));
    expect(localStorage.getItem("tt_connected_since")).toBeNull();
  });

  // ── REGRESSION: tab switch must NOT reset panel scroll ─────────────────────

  describe("scroll preservation on tab switch (owner-reported bug)", () => {
    let scroller: HTMLDivElement;
    let modalScroller: HTMLDivElement;

    beforeEach(() => {
      // Mimic a kept-mounted tab panel's scroll container (Connection tab:
      // connection/ConnectionPanel.tsx) — its class matches the old
      // [class*="overflow"] selector, so the removed reset would have zeroed it.
      scroller = document.createElement("div");
      scroller.className = "h-full overflow-y-auto p-[var(--space-4)]";
      document.body.appendChild(scroller);
      // And an open modal's scroll container (shared/ui/Modal.tsx) — the old
      // reset also nuked modals that were open across a tab switch.
      modalScroller = document.createElement("div");
      modalScroller.className = "max-h-[calc(100vh-var(--space-8))] overflow-y-auto scroll-visible";
      document.body.appendChild(modalScroller);
    });

    afterEach(() => {
      scroller.remove();
      modalScroller.remove();
    });

    it("leaves scrollTop of overflow containers untouched across tab switches", () => {
      const { rerender } = renderHook((p) => useTabPersistence(p), {
        initialProps: makeParams({ activeTab: "connection" }),
      });

      // The user scrolls down inside the Connection tab (and a modal).
      scroller.scrollTop = 500;
      modalScroller.scrollTop = 120;

      // Leave the tab…
      rerender(makeParams({ activeTab: "settings" }));
      expect(scroller.scrollTop).toBe(500);
      expect(modalScroller.scrollTop).toBe(120);

      // …and come back. The browser preserves scrollTop natively on the
      // kept-mounted panel (IN-49); the hook must not have written to it.
      rerender(makeParams({ activeTab: "connection" }));
      expect(scroller.scrollTop).toBe(500);
      expect(modalScroller.scrollTop).toBe(120);
    });
  });
});
