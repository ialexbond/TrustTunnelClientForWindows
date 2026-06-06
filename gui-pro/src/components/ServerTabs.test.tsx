import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, within, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "../test/test-utils";
import { makeState } from "../test/fixtures";
import i18n from "../shared/i18n";
import { configTabDirtyRef } from "./server/ConfigurationTab";
import { ServerTabs } from "./ServerTabs";

// ServerTabs characterization (Phase 3 safety-net, Wave 1, stream 6a).
//
// FIRST-EVER test for ServerTabs — there is no production code change here
// (D-06). We pin the current chrome behavior so a Phase 4 refactor that breaks
// the WAI-ARIA tablist, the persisted-tab logic, the disconnect confirm flow,
// the navigate-away dirty guard, or the `service-tab-update-dot` cascade slice
// flips this suite red.
//
// The five inner section components (Overview/Users/Configuration/Security/
// Service) are mocked: they pull in heavy SSH/Tauri logic that is exercised by
// their own per-surface plans. Mocking them keeps THIS suite focused on the
// chrome (tablist, panels, disconnect, dirty guard, dot) and avoids coupling to
// section internals. Each mock renders a unique testid so we can assert which
// panel content is active.
//
// `configTabDirtyRef` is a real module-level shared ref (NOT mocked) — the
// navigate-away guard reads `configTabDirtyRef.current`, so the tests toggle the
// real ref to drive the guard, exactly as ConfigurationTab does in production.

vi.mock("./server/OverviewSection", () => ({
  OverviewSection: ({
    onNavigate,
  }: {
    onNavigate: (tab: string) => void;
  }) => (
    <div data-testid="mock-overview">
      Overview content
      <button
        type="button"
        data-testid="overview-drilldown-to-service"
        onClick={() => onNavigate("service")}
      >
        go service
      </button>
    </div>
  ),
}));
vi.mock("./server/UsersSection", () => ({
  UsersSection: () => <div data-testid="mock-users">Users content</div>,
}));
vi.mock("./server/ConfigurationTab", async () => {
  // Keep the REAL configTabDirtyRef (shared module-level ref the guard reads),
  // only stub the heavy ConfigurationTab component itself.
  const actual = await vi.importActual<
    typeof import("./server/ConfigurationTab")
  >("./server/ConfigurationTab");
  return {
    ...actual,
    ConfigurationTab: () => (
      <div data-testid="mock-configuration">Configuration content</div>
    ),
  };
});
vi.mock("./server/SecurityTabSection", () => ({
  SecurityTabSection: () => (
    <div data-testid="mock-security">Security content</div>
  ),
}));
vi.mock("./server/ServiceTabSection", () => ({
  ServiceTabSection: () => <div data-testid="mock-service">Service content</div>,
}));

const STORAGE_KEY = "tt_active_tab";
const TAB_IDS = ["overview", "users", "configuration", "security", "service"] as const;

function renderTabs(
  props: Partial<React.ComponentProps<typeof ServerTabs>> = {},
) {
  const onDisconnect = vi.fn();
  const state = makeState({
    onDisconnect,
    loading: false,
    error: "",
    ...(props.state ?? {}),
  } as Partial<ReturnType<typeof makeState>>);
  const utils = renderWithProviders(<ServerTabs {...props} state={state} />);
  return { ...utils, state, onDisconnect };
}

/** The panel <div role="tabpanel"> for the given tab id. */
function panelFor(tabId: (typeof TAB_IDS)[number]): HTMLElement {
  return document.getElementById(`panel-${tabId}`) as HTMLElement;
}

describe("ServerTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    configTabDirtyRef.current = false;
    i18n.changeLanguage("ru");
  });

  afterEach(() => {
    localStorage.clear();
    configTabDirtyRef.current = false;
  });

  // ─── Tablist WAI-ARIA structure ────────────────────────────────────────────
  describe("tablist WAI-ARIA structure", () => {
    it("renders a tablist with 5 tabs", () => {
      renderTabs();
      const tablist = screen.getByRole("tablist");
      const tabs = within(tablist).getAllByRole("tab");
      expect(tabs).toHaveLength(5);
    });

    it("each tab has aria-controls pointing at its panel + a stable id", () => {
      renderTabs();
      for (const id of TAB_IDS) {
        const tab = document.getElementById(`tab-${id}`)!;
        expect(tab).toHaveAttribute("role", "tab");
        expect(tab).toHaveAttribute("aria-controls", `panel-${id}`);
      }
    });

    it("the active (overview) tab has aria-selected=true, others false", () => {
      renderTabs();
      expect(document.getElementById("tab-overview")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(document.getElementById("tab-users")).toHaveAttribute(
        "aria-selected",
        "false",
      );
    });

    it("roving tabIndex: only the active tab is in the tab order (0), others -1", () => {
      renderTabs();
      expect(document.getElementById("tab-overview")).toHaveAttribute(
        "tabindex",
        "0",
      );
      expect(document.getElementById("tab-users")).toHaveAttribute(
        "tabindex",
        "-1",
      );
      expect(document.getElementById("tab-service")).toHaveAttribute(
        "tabindex",
        "-1",
      );
    });
  });

  // ─── Active panel visible / others hidden ──────────────────────────────────
  describe("active/hidden panels", () => {
    it("the active panel is not aria-hidden; inactive panels are aria-hidden", () => {
      renderTabs();
      expect(panelFor("overview")).toHaveAttribute("aria-hidden", "false");
      expect(panelFor("users")).toHaveAttribute("aria-hidden", "true");
      expect(panelFor("service")).toHaveAttribute("aria-hidden", "true");
    });

    it("keeps all section content mounted (cross-fade pattern) but the active panel hosts the active tab's content", () => {
      // Production pins (lines 303-384): ServerTabs uses a mount-once cross-fade
      // — every panel mounts its section, inactive ones are hidden via
      // opacity/visibility + aria-hidden, NOT unmounted. So mock-service IS in
      // the document even on overview. We assert the active panel is the visible
      // one rather than asserting absence of inactive content.
      renderTabs();
      expect(
        within(panelFor("overview")).getByTestId("mock-overview"),
      ).toBeInTheDocument();
      expect(within(panelFor("service")).getByTestId("mock-service")).toBeInTheDocument();
      expect(panelFor("overview")).toHaveAttribute("aria-hidden", "false");
      expect(panelFor("service")).toHaveAttribute("aria-hidden", "true");
    });
  });

  // ─── Tab click switches + persists ─────────────────────────────────────────
  describe("tab switching + tt_active_tab persistence", () => {
    it("clicking a tab switches the active panel and renders its content", async () => {
      renderTabs();
      fireEvent.click(document.getElementById("tab-users")!);
      await waitFor(() =>
        expect(screen.getByTestId("mock-users")).toBeInTheDocument(),
      );
      expect(document.getElementById("tab-users")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(panelFor("users")).toHaveAttribute("aria-hidden", "false");
    });

    it("clicking a tab writes the new id to localStorage", async () => {
      renderTabs();
      fireEvent.click(document.getElementById("tab-security")!);
      await waitFor(() =>
        expect(localStorage.getItem(STORAGE_KEY)).toBe("security"),
      );
    });

    it("reads the persisted tab on init", () => {
      localStorage.setItem(STORAGE_KEY, "service");
      renderTabs();
      expect(document.getElementById("tab-service")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      expect(screen.getByTestId("mock-service")).toBeInTheDocument();
    });

    it("migrates the legacy 'utilities' persisted value → 'service'", () => {
      localStorage.setItem(STORAGE_KEY, "utilities");
      renderTabs();
      expect(document.getElementById("tab-service")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    it("falls back to 'overview' for an invalid stored value", () => {
      localStorage.setItem(STORAGE_KEY, "does-not-exist");
      renderTabs();
      expect(document.getElementById("tab-overview")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });

  // ─── Keyboard navigation (manual activation — focus only) ──────────────────
  describe("keyboard navigation (manual activation, focus only)", () => {
    it("ArrowRight moves focus to the next tab WITHOUT activating it", () => {
      renderTabs();
      const overview = document.getElementById("tab-overview")!;
      overview.focus();
      fireEvent.keyDown(overview, { key: "ArrowRight" });
      expect(document.getElementById("tab-users")).toHaveFocus();
      // Manual activation: aria-selected stays on overview until Enter/click.
      expect(overview).toHaveAttribute("aria-selected", "true");
    });

    it("ArrowLeft from the first tab wraps focus to the last tab", () => {
      renderTabs();
      const overview = document.getElementById("tab-overview")!;
      overview.focus();
      fireEvent.keyDown(overview, { key: "ArrowLeft" });
      expect(document.getElementById("tab-service")).toHaveFocus();
    });

    it("Home moves focus to the first tab", () => {
      renderTabs();
      const service = document.getElementById("tab-service")!;
      service.focus();
      fireEvent.keyDown(service, { key: "Home" });
      expect(document.getElementById("tab-overview")).toHaveFocus();
    });

    it("End moves focus to the last tab", () => {
      renderTabs();
      const overview = document.getElementById("tab-overview")!;
      overview.focus();
      fireEvent.keyDown(overview, { key: "End" });
      expect(document.getElementById("tab-service")).toHaveFocus();
    });
  });

  // ─── Disconnect button + confirm dialog ────────────────────────────────────
  describe("disconnect button + confirm", () => {
    it("exposes a disconnect button with its aria-label", () => {
      renderTabs();
      expect(
        screen.getByRole("button", { name: i18n.t("control.disconnect") }),
      ).toBeInTheDocument();
    });

    it("happy path: confirming the danger dialog calls state.onDisconnect", async () => {
      const { onDisconnect } = renderTabs();
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("control.disconnect") }),
      );
      // ConfirmDialog renders; confirm with the «Подтвердить» button.
      const confirmBtn = await screen.findByRole("button", {
        name: i18n.t("buttons.confirm"),
      });
      fireEvent.click(confirmBtn);
      await waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    });

    it("cancel path: dismissing the dialog does NOT call state.onDisconnect", async () => {
      const { onDisconnect } = renderTabs();
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("control.disconnect") }),
      );
      const cancelBtn = await screen.findByRole("button", {
        name: i18n.t("buttons.cancel"),
      });
      fireEvent.click(cancelBtn);
      await waitFor(() =>
        expect(screen.queryByText(i18n.t("server.disconnect.confirm_title"))).toBeNull(),
      );
      expect(onDisconnect).not.toHaveBeenCalled();
    });
  });

  // ─── Navigate-away dirty guard (configTabDirtyRef) ─────────────────────────
  describe("navigate-away dirty guard", () => {
    it("blocks a tab switch from a dirty Configuration tab when user chooses Stay", async () => {
      localStorage.setItem(STORAGE_KEY, "configuration");
      renderTabs();
      configTabDirtyRef.current = true;
      // Try to leave Configuration → Overview.
      fireEvent.click(document.getElementById("tab-overview")!);
      // Guard dialog appears — choose «Остаться» (Stay = cancel).
      const stayBtn = await screen.findByRole("button", {
        name: i18n.t("server.config.stay"),
      });
      fireEvent.click(stayBtn);
      await waitFor(() =>
        expect(document.getElementById("tab-configuration")).toHaveAttribute(
          "aria-selected",
          "true",
        ),
      );
    });

    it("allows the tab switch when user chooses Discard & leave", async () => {
      localStorage.setItem(STORAGE_KEY, "configuration");
      renderTabs();
      configTabDirtyRef.current = true;
      fireEvent.click(document.getElementById("tab-overview")!);
      const discardBtn = await screen.findByRole("button", {
        name: i18n.t("server.config.discard_and_leave"),
      });
      fireEvent.click(discardBtn);
      await waitFor(() =>
        expect(document.getElementById("tab-overview")).toHaveAttribute(
          "aria-selected",
          "true",
        ),
      );
      // Discard clears the shared dirty ref.
      expect(configTabDirtyRef.current).toBe(false);
    });

    it("disconnect from a dirty Configuration tab is blocked when user chooses Stay", async () => {
      localStorage.setItem(STORAGE_KEY, "configuration");
      const { onDisconnect } = renderTabs();
      configTabDirtyRef.current = true;
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("control.disconnect") }),
      );
      // First (unsaved) guard dialog — choose Stay.
      const stayBtn = await screen.findByRole("button", {
        name: i18n.t("server.config.stay"),
      });
      fireEvent.click(stayBtn);
      await waitFor(() =>
        expect(screen.queryByText(i18n.t("server.config.unsaved_title"))).toBeNull(),
      );
      expect(onDisconnect).not.toHaveBeenCalled();
    });

    it("disconnect from a dirty Configuration tab proceeds after Discard & leave + Confirm", async () => {
      localStorage.setItem(STORAGE_KEY, "configuration");
      const { onDisconnect } = renderTabs();
      configTabDirtyRef.current = true;
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("control.disconnect") }),
      );
      // 1) unsaved guard → Discard & leave.
      const discardBtn = await screen.findByRole("button", {
        name: i18n.t("server.config.discard_and_leave"),
      });
      fireEvent.click(discardBtn);
      // 2) disconnect confirm → Confirm.
      const confirmBtn = await screen.findByRole("button", {
        name: i18n.t("buttons.confirm"),
      });
      fireEvent.click(confirmBtn);
      await waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1));
    });
  });

  // ─── service-tab-update-dot cascade slice ──────────────────────────────────
  describe("service-tab-update-dot (cascade slice)", () => {
    it("is visible when an update is available AND the user is NOT on the service tab", () => {
      renderTabs({ hasSidecarUpdate: true }); // default tab = overview
      const dot = screen.getByTestId("service-tab-update-dot");
      expect(dot).toBeInTheDocument();
      expect(dot).toHaveAttribute("role", "status");
      expect(dot).toHaveAttribute(
        "aria-label",
        i18n.t("server.service.tab_update_available_aria"),
      );
    });

    it("the dot lives inside the «Сервис» tab button", () => {
      renderTabs({ hasSidecarUpdate: true });
      const dot = screen.getByTestId("service-tab-update-dot");
      expect(dot.closest('[role="tab"]')?.getAttribute("id")).toBe(
        "tab-service",
      );
    });

    it("is hidden once the user is already on the service tab", () => {
      localStorage.setItem(STORAGE_KEY, "service");
      renderTabs({ hasSidecarUpdate: true });
      expect(screen.queryByTestId("service-tab-update-dot")).toBeNull();
    });

    it("is absent when no update is available", () => {
      renderTabs({ hasSidecarUpdate: false });
      expect(screen.queryByTestId("service-tab-update-dot")).toBeNull();
    });

    it("appears once the user navigates AWAY from the service tab", async () => {
      localStorage.setItem(STORAGE_KEY, "service");
      renderTabs({ hasSidecarUpdate: true });
      expect(screen.queryByTestId("service-tab-update-dot")).toBeNull();
      fireEvent.click(document.getElementById("tab-overview")!);
      await waitFor(() =>
        expect(screen.getByTestId("service-tab-update-dot")).toBeInTheDocument(),
      );
    });
  });

  // ─── Loading skeleton + error/retry ────────────────────────────────────────
  describe("loading + error states", () => {
    it("shows the loading skeleton (section content absent) when state.loading", () => {
      renderTabs({ state: { loading: true } as never });
      // Loading replaces the section in EVERY panel (the loading branch is inside
      // each tabpanel) — so even the active overview panel has no section content.
      expect(
        within(panelFor("overview")).queryByTestId("mock-overview"),
      ).toBeNull();
    });

    it("shows an error message + retry button in the active panel, and retry calls loadServerInfo", () => {
      const { state } = renderTabs({
        state: { error: "Connection refused" } as never,
      });
      // The error branch also renders inside every panel; scope to the active one.
      const activePanel = panelFor("overview");
      expect(within(activePanel).getByText("Connection refused")).toBeInTheDocument();
      const retry = within(activePanel).getByRole("button", {
        name: i18n.t("errors.retry"),
      });
      fireEvent.click(retry);
      expect(state.loadServerInfo).toHaveBeenCalled();
    });
  });

  // ─── H-07: disconnect button MUST NOT live inside role="tablist" ───────────
  describe("disconnect button WAI-ARIA placement (Chrome H-07)", () => {
    it("the disconnect button is NOT a descendant of the tablist", () => {
      renderTabs();
      const tablist = screen.getByRole("tablist");
      const disconnect = screen.getByRole("button", {
        name: i18n.t("control.disconnect"),
      });
      // WAI-ARIA 1.2 §3.24: a tablist must contain only role=tab children.
      // The disconnect button is a separate action — it must sit outside.
      expect(tablist.contains(disconnect)).toBe(false);
    });

    it("the tablist still contains exactly the 5 tabs (no stray controls)", () => {
      renderTabs();
      const tablist = screen.getByRole("tablist");
      // role=tab overrides the implicit button role, so a tablist holding only
      // tabs exposes ZERO elements with role=button. A stray non-tab control
      // (like the old disconnect button) would surface here.
      const strayButtons = within(tablist).queryAllByRole("button", {
        hidden: true,
      });
      expect(strayButtons).toHaveLength(0);
      const tabs = within(tablist).getAllByRole("tab");
      expect(tabs).toHaveLength(5);
    });
  });

  // ─── H-08: loadActiveTab migration writes the canonical value back ─────────
  describe("loadActiveTab 'utilities'→'service' write-back (Chrome H-08)", () => {
    it("persists 'service' to localStorage immediately on migration (no tab switch needed)", () => {
      localStorage.setItem(STORAGE_KEY, "utilities");
      renderTabs();
      // The migrated value must be written back at once so a user who stays on
      // the service tab no longer leaves 'utilities' rotting in storage.
      expect(localStorage.getItem(STORAGE_KEY)).toBe("service");
      expect(document.getElementById("tab-service")).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    it("does NOT rewrite storage for an already-canonical value", () => {
      localStorage.setItem(STORAGE_KEY, "security");
      renderTabs();
      // No migration happened, so the stored value is untouched.
      expect(localStorage.getItem(STORAGE_KEY)).toBe("security");
    });
  });
});
