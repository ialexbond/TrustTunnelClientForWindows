import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { AddRuleInput } from "./AddRuleInput";
import type { RouteAction, GeoDataIndex, GeoDataStatus } from "./useRoutingState";

function defaultGeoStatus(): GeoDataStatus {
  return {
    downloaded: true,
    geoip_exists: true,
    geosite_exists: true,
    geoip_categories_count: 5,
    geosite_categories_count: 10,
  };
}

function defaultGeoCategories(): GeoDataIndex {
  return { geoip: ["RU", "US", "CN"], geosite: ["google", "facebook", "youtube"] };
}

// jsdom does not implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("AddRuleInput", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onAdd: any;

  beforeEach(() => {
    i18n.changeLanguage("ru");
    onAdd = vi.fn().mockReturnValue(null);
  });

  function renderInput(overrides: { action?: RouteAction } = {}) {
    return render(
      <AddRuleInput
        action={overrides.action ?? "proxy"}
        geodataStatus={defaultGeoStatus()}
        geodataCategories={defaultGeoCategories()}
        onAdd={onAdd}
      />,
    );
  }

  it("renders without crashing", () => {
    renderInput();
    expect(screen.getByPlaceholderText(/domain\.com/)).toBeInTheDocument();
  });

  it("shows placeholder text from i18n", () => {
    renderInput();
    expect(screen.getByPlaceholderText("domain.com, IP, geoip:RU, geosite:category, iplist_group:...")).toBeInTheDocument();
  });

  it("add button is disabled when input is empty", () => {
    renderInput();
    const addBtn = screen.getByRole("button");
    expect(addBtn).toBeDisabled();
  });

  it("add button becomes enabled when user types text", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "example.com");
    // The plus button (second button — first is clear)
    const buttons = screen.getAllByRole("button");
    const addBtn = buttons[buttons.length - 1];
    expect(addBtn).not.toBeDisabled();
  });

  it("calls onAdd when clicking add button with valid domain", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "example.com");
    // Click the add (Plus) button
    const buttons = screen.getAllByRole("button");
    const addBtn = buttons[buttons.length - 1];
    fireEvent.click(addBtn);
    expect(onAdd).toHaveBeenCalledWith("proxy", "example.com");
  });

  it("calls onAdd on Enter key press", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "10.0.0.1{Enter}");
    expect(onAdd).toHaveBeenCalledWith("proxy", "10.0.0.1");
  });

  it("clears input after successful add", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/) as HTMLInputElement;
    await userEvent.type(input, "example.com{Enter}");
    expect(input.value).toBe("");
  });

  it("shows error for duplicate entry", async () => {
    onAdd.mockReturnValue("duplicate");
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "example.com{Enter}");
    expect(screen.getByText("Такая запись уже существует")).toBeInTheDocument();
  });

  it("shows validation error for domain without dot", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "example{Enter}");
    expect(screen.getByText(/полный домен/)).toBeInTheDocument();
  });

  it("shows validation error for invalid format", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "!!!invalid!!!{Enter}");
    expect(screen.getByText(/Допустимы/)).toBeInTheDocument();
  });

  it("accepts valid IP address", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "192.168.1.1{Enter}");
    expect(onAdd).toHaveBeenCalledWith("proxy", "192.168.1.1");
  });

  it("accepts valid CIDR", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "10.0.0.0/8{Enter}");
    expect(onAdd).toHaveBeenCalledWith("proxy", "10.0.0.0/8");
  });

  it("accepts geoip: prefix without validation error", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    fireEvent.change(input, { target: { value: "geoip:RU" } });
    // Press add button
    const buttons = screen.getAllByRole("button");
    const addBtn = buttons[buttons.length - 1];
    fireEvent.click(addBtn);
    expect(onAdd).toHaveBeenCalledWith("proxy", "geoip:RU");
  });

  it("shows clear button when input has text", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "test");
    // Should have 2 buttons now: clear (X) and add (Plus)
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(2);
  });

  it("clears input when clear button is clicked", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/) as HTMLInputElement;
    await userEvent.type(input, "test.com");
    const buttons = screen.getAllByRole("button");
    // Click clear button (first)
    fireEvent.click(buttons[0]);
    expect(input.value).toBe("");
  });

  it("passes correct action to onAdd", async () => {
    renderInput({ action: "direct" });
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "example.com{Enter}");
    expect(onAdd).toHaveBeenCalledWith("direct", "example.com");
  });

  // ── iplist_group: manual autocomplete + whitelist (D-03 / Security V5 — Wave 0 RED) ──
  //
  // These cases are RED until Plan 22-03: today `detectAutocomplete` only knows geoip:/geosite:,
  // `validateEntry` has no iplist_group branch (so a group id falls through to the generic
  // invalidFormat error), and `AddRuleInput` has no `iplistGroups` prop. Plan 22-03 adds the
  // combobox branch + the `routing.validation.invalidGroup` whitelist rejection and turns them
  // green.
  describe("iplist_group (Wave 0 RED — contract for Plan 22-03)", () => {
    function renderWithGroups(overrides: { action?: RouteAction } = {}) {
      return render(
        <AddRuleInput
          action={overrides.action ?? "proxy"}
          geodataStatus={defaultGeoStatus()}
          geodataCategories={defaultGeoCategories()}
          onAdd={onAdd}
          iplistGroups={[
            { id: "games", label: "Games" },
            { id: "youtube", label: "YouTube" },
            { id: "messengers", label: "Messengers" },
          ]}
        />,
      );
    }

    it("opens the group autocomplete when the iplist_group: prefix is typed", async () => {
      renderWithGroups();
      const input = screen.getByPlaceholderText(/domain\.com/) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "iplist_group:" } });

      await waitFor(() => {
        expect(input).toHaveAttribute("aria-expanded", "true");
      });
      // The dropdown is fed the group-id list passed via the iplistGroups prop.
      expect(screen.getByText(/games/i)).toBeInTheDocument();
    });

    it("adds a KNOWN group id with its iplist_group: prefix", () => {
      renderWithGroups();
      const input = screen.getByPlaceholderText(/domain\.com/);
      fireEvent.change(input, { target: { value: "iplist_group:games" } });
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[buttons.length - 1]); // add (Plus) button
      expect(onAdd).toHaveBeenCalledWith("proxy", "iplist_group:games");
    });

    it("rejects a path-traversal group id and does NOT call onAdd (Security V5, T-22-01)", () => {
      renderWithGroups();
      const input = screen.getByPlaceholderText(/domain\.com/);
      fireEvent.change(input, { target: { value: "iplist_group:../etc" } });
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[buttons.length - 1]);

      expect(onAdd).not.toHaveBeenCalled();
      // A group-specific rejection surfaces (routing.validation.invalidGroup) — NOT the generic
      // invalidFormat message ("Допустимы: …"). This distinguishes the whitelist reject from the
      // pre-existing format validator and is the RED gate for Plan 22-03.
      const alert = screen.getByRole("alert");
      expect(alert.textContent || "").not.toMatch(/Допустимы/);
    });

    it("rejects an UNKNOWN group id and does NOT call onAdd", () => {
      renderWithGroups();
      const input = screen.getByPlaceholderText(/domain\.com/);
      fireEvent.change(input, { target: { value: "iplist_group:bogus_unknown" } });
      const buttons = screen.getAllByRole("button");
      fireEvent.click(buttons[buttons.length - 1]);

      expect(onAdd).not.toHaveBeenCalled();
      const alert = screen.getByRole("alert");
      expect(alert.textContent || "").not.toMatch(/Допустимы/);
    });
  });

  // ── Phase 22 UAT fixes — regression guards for the two defects the owner found live ──
  describe("suggestions dropdown (Phase 22 UAT fixes)", () => {
    /** Open the geo dropdown and return the portal element it renders into. */
    async function openDropdown() {
      const input = screen.getByPlaceholderText(/domain\.com/);
      fireEvent.change(input, { target: { value: "geosite:" } });
      await waitFor(() => {
        expect(document.querySelector("[data-geo-dropdown]")).toBeInTheDocument();
      });
      return document.querySelector("[data-geo-dropdown]") as HTMLElement;
    }

    it("closes on a main-tab change", async () => {
      // UAT fix #3. The dropdown is a fixed createPortal on document.body and the tab panels are
      // hidden-not-unmounted (App IN-11), so a tab switch does not unmount it. Mouse clicks on the
      // tab bar happen to fire the outside-mousedown close, but keyboard (Ctrl+1..5) / tray /
      // deep-link navigation emit no such event and left it floating over the new tab. App
      // broadcasts `app:tabchange` on every activeTab change — assert we act on it.
      renderInput();
      await openDropdown();

      fireEvent(window, new CustomEvent("app:tabchange"));

      await waitFor(() => {
        expect(document.querySelector("[data-geo-dropdown]")).not.toBeInTheDocument();
      });
    });

    it("matches the input's left edge and width exactly (no sidebar clamp)", async () => {
      // UAT fix #1. The dropdown used to apply a clamp written for a pre-v3 layout — force
      // `left >= 56` and shrink the width by `56 - rect.left`. The v3 Routing tab is a centred
      // max-w column with NO left sidebar, so on the narrow windows this client runs at
      // `rect.left ≈ 16 < 56`: the clamp fired and the dropdown rendered inset and narrower than
      // the field. jsdom reports zeroed rects, so we feed a realistic one and assert the geometry
      // is copied verbatim — a re-introduced clamp would show up as left=56 / width=260.
      const rect = { left: 16, bottom: 40, width: 300, top: 12, right: 316, height: 28, x: 16, y: 12 };
      const spy = vi
        .spyOn(HTMLElement.prototype, "getBoundingClientRect")
        .mockReturnValue({ ...rect, toJSON: () => rect } as DOMRect);
      try {
        renderInput();
        const dropdown = await openDropdown();
        expect(dropdown.style.left).toBe("16px");
        expect(dropdown.style.width).toBe("300px");
        expect(dropdown.style.top).toBe("44px"); // rect.bottom + the intended 4px gap
      } finally {
        spy.mockRestore();
      }
    });
  });
});
