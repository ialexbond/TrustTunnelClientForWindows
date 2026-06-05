import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import i18n from "../../../shared/i18n";
import { QuickSettingsCard } from "./QuickSettingsCard";
import type { TomlFieldSchema } from "./types";

/**
 * Phase 3 safety-net (Stream 3) — first-ever characterization of QuickSettingsCard.
 *
 * QuickSettingsCard had ZERO tests before this net. It renders 4 fixed boolean
 * toggles (ipv6_available, allow_private_network_connections, speedtest_enable,
 * ping_enable) as ToggleField rows (each a `role="switch"`). When getSchema()
 * returns undefined for a key (bundle not loaded yet), it renders a placeholder
 * schema with value=false so the user sees a default-off toggle during load.
 *
 * Behavior/aria only (D-04): role + aria-label + `i18n.t(...)`. Pins CURRENT
 * behavior against UNCHANGED production code (D-06).
 */
const QUICK_KEYS = [
  "ipv6_available",
  "allow_private_network_connections",
  "speedtest_enable",
  "ping_enable",
] as const;

/** Build a boolean schema for a given quick-settings key. */
function boolSchema(key: string, value: boolean): TomlFieldSchema {
  return {
    key,
    path: [key],
    type: { kind: "boolean", value },
    isExplicit: true,
    tooltipKey: `server.config.field_desc.vpn.${key}`,
  };
}

describe("QuickSettingsCard (Phase 3 characterization)", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
  });

  it("renders the quick-settings title heading", () => {
    render(<QuickSettingsCard getSchema={() => undefined} onChange={vi.fn()} />);
    expect(
      screen.getByRole("heading", {
        name: i18n.t("server.config.quick_settings_title"),
      }),
    ).toBeInTheDocument();
  });

  it("renders all 4 fixed boolean toggles by aria-label", () => {
    render(
      <QuickSettingsCard
        getSchema={(path) => boolSchema(path[0], false)}
        onChange={vi.fn()}
      />,
    );
    for (const key of QUICK_KEYS) {
      expect(screen.getByRole("switch", { name: key })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("switch")).toHaveLength(4);
  });

  it("reflects the schema value (checked) on each toggle", () => {
    render(
      <QuickSettingsCard
        getSchema={(path) =>
          boolSchema(path[0], path[0] === "ipv6_available")
        }
        onChange={vi.fn()}
      />,
    );
    const ipv6 = screen.getByRole("switch", { name: "ipv6_available" });
    const ping = screen.getByRole("switch", { name: "ping_enable" });
    expect(ipv6).toBeChecked();
    expect(ping).not.toBeChecked();
  });

  it("falls back to an off placeholder toggle when getSchema returns undefined (bundle not loaded)", () => {
    render(<QuickSettingsCard getSchema={() => undefined} onChange={vi.fn()} />);
    // All 4 still render (placeholder schema), all default-off.
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(4);
    for (const sw of switches) {
      expect(sw).not.toBeChecked();
    }
  });

  it("toggling a switch calls onChange with the field path and the new value", () => {
    const onChange = vi.fn();
    render(
      <QuickSettingsCard
        getSchema={(path) => boolSchema(path[0], false)}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "speedtest_enable" }));
    expect(onChange).toHaveBeenCalledWith(["speedtest_enable"], true);
  });

  it("disables all toggles when disabled prop is set", () => {
    render(
      <QuickSettingsCard
        getSchema={(path) => boolSchema(path[0], false)}
        onChange={vi.fn()}
        disabled
      />,
    );
    for (const sw of screen.getAllByRole("switch")) {
      expect(sw).toBeDisabled();
    }
  });

  it("renders each toggle inside the card heading's section (single card)", () => {
    const { container } = render(
      <QuickSettingsCard
        getSchema={(path) => boolSchema(path[0], false)}
        onChange={vi.fn()}
      />,
    );
    // One card wrapper holding the heading + all 4 toggles.
    const card = container.firstElementChild as HTMLElement;
    expect(
      within(card).getByRole("heading", {
        name: i18n.t("server.config.quick_settings_title"),
      }),
    ).toBeInTheDocument();
    expect(within(card).getAllByRole("switch")).toHaveLength(4);
  });
});
