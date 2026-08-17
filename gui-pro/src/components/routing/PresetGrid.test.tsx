import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
// Wave 0 RED (Plan 22-01): the production PresetGrid does not exist yet — this import fails to
// resolve, so every case here is RED. The assertions FREEZE the component's props contract that
// Plan 22-04 must satisfy:
//
//   props: {
//     rules: RoutingRules,                       // current rules — drives "already added" state
//     onAdd: (action, value) => string | null,   // = useRoutingState.addEntry
//     ensureGroupCache: (groupId: string) => void,// prefetch+cache an iplist_group before it resolves
//     geodataDownloaded: boolean,                 // gates geosite-backed tiles
//     blockRoutingEnabled: boolean,               // gates block-target (ads/trackers) tiles
//   }
//
// Backings are fixed by 22-RESEARCH §C: YouTube → `geosite:youtube` (no prefetch), Игры →
// `iplist_group:games` (needs prefetch), Россия → a `ru` backing landing in `direct`, Реклама и
// трекеры → a block-target backing.
import { PresetGrid } from "./PresetGrid";
import type { RoutingRules, RuleEntry } from "./useRoutingState";

// jsdom does not implement scrollIntoView (portals / focus rings may call it)
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

function makeRules(overrides?: Partial<RoutingRules>): RoutingRules {
  return {
    direct: [],
    proxy: [],
    block: [],
    process_mode: "exclude",
    processes: [],
    ...overrides,
  };
}

function entry(type: RuleEntry["type"], value: string, id = `e_${value}`): RuleEntry {
  return { id, type, value };
}

describe("PresetGrid (Wave 0 RED — contract for Plan 22-04)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onAdd: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ensureGroupCache: any;

  beforeEach(() => {
    i18n.changeLanguage("ru");
    onAdd = vi.fn().mockReturnValue(null); // addEntry returns null on success
    ensureGroupCache = vi.fn();
  });

  function renderGrid(overrides?: {
    rules?: RoutingRules;
    geodataDownloaded?: boolean;
    blockRoutingEnabled?: boolean;
  }) {
    return render(
      <PresetGrid
        rules={overrides?.rules ?? makeRules()}
        onAdd={onAdd}
        ensureGroupCache={ensureGroupCache}
        geodataDownloaded={overrides?.geodataDownloaded ?? true}
        blockRoutingEnabled={overrides?.blockRoutingEnabled ?? true}
      />,
    );
  }

  // ── (a) smart-default landing ──────────────────────────────────────────────
  it("lands the RU preset in the direct block", () => {
    renderGrid();
    fireEvent.click(screen.getByRole("button", { name: /Россия/i }));
    // Россия → «Напрямую» (direct). Exact backing token confirmed at Plan 04; must reference RU.
    expect(onAdd).toHaveBeenCalledWith("direct", expect.stringMatching(/ru/i));
  });

  it("lands the YouTube preset in the proxy block via geosite backing", () => {
    renderGrid();
    fireEvent.click(screen.getByRole("button", { name: /YouTube/i }));
    expect(onAdd).toHaveBeenCalledWith("proxy", "geosite:youtube");
  });

  it("lands the ads/trackers preset in the block block", () => {
    renderGrid();
    fireEvent.click(screen.getByRole("button", { name: /Реклама/i }));
    expect(onAdd).toHaveBeenCalledWith("block", expect.any(String));
  });

  // ── (b) idempotent re-add is a no-op (D-06) ────────────────────────────────
  it("marks a tile as added and blocks re-adding when its backing is already in rules", () => {
    // YouTube backing (geosite:youtube) is stored as {type:geosite, value:youtube}.
    const rules = makeRules({ proxy: [entry("geosite", "youtube")] });
    renderGrid({ rules });

    const tile = screen.getByRole("button", { name: /YouTube/i });
    expect(tile).toBeDisabled();
    expect(tile).toHaveAccessibleName(/уже добавлен/i);

    fireEvent.click(tile);
    expect(onAdd).not.toHaveBeenCalled();
  });

  // ── (c) exact-token added-state (Pitfall #4) ───────────────────────────────
  it("does NOT mark the geosite:youtube tile added when only iplist_group:youtube exists", () => {
    // Same human category, DIFFERENT backing token → the geosite tile must stay addable.
    const rules = makeRules({ proxy: [entry("iplist_group", "youtube")] });
    renderGrid({ rules });

    const tile = screen.getByRole("button", { name: /YouTube/i });
    expect(tile).not.toBeDisabled();
    expect(tile).not.toHaveAccessibleName(/уже добавлен/i);

    fireEvent.click(tile);
    expect(onAdd).toHaveBeenCalledWith("proxy", "geosite:youtube");
  });

  // ── (d) fetch-on-add for iplist_group backings (Pitfall #2) ────────────────
  it("prefetches the group cache when adding an iplist_group-backed tile", () => {
    renderGrid();
    fireEvent.click(screen.getByRole("button", { name: /Игры/i }));
    expect(ensureGroupCache).toHaveBeenCalledWith("games");
    expect(onAdd).toHaveBeenCalledWith("proxy", "iplist_group:games");
  });

  it("does NOT prefetch a group cache when adding a geosite-backed tile", () => {
    renderGrid();
    fireEvent.click(screen.getByRole("button", { name: /YouTube/i }));
    expect(ensureGroupCache).not.toHaveBeenCalled();
  });

  // ── (e) gating (Pitfall #1 / #3) ───────────────────────────────────────────
  it("HIDES block-target tiles entirely when block routing is off (owner D-2/F-3)", () => {
    // Was: shown-but-disabled. Now: the block card is hidden, so a block-target preset has
    // nowhere to land → it is not rendered at all. Both block tiles disappear; non-block stay.
    renderGrid({ blockRoutingEnabled: false });
    expect(screen.queryByRole("button", { name: /Реклама/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Телеметрия/i })).not.toBeInTheDocument();
    // A non-block tile is still present.
    expect(screen.getByRole("button", { name: /YouTube/i })).toBeInTheDocument();
  });

  it("shows block-target tiles when block routing is on", () => {
    renderGrid({ blockRoutingEnabled: true });
    expect(screen.getByRole("button", { name: /Реклама/i })).toBeInTheDocument();
  });

  it("disables geosite-backed tiles when geodata is not downloaded", () => {
    renderGrid({ geodataDownloaded: false });
    const tile = screen.getByRole("button", { name: /YouTube/i });
    expect(tile).toBeDisabled();
    fireEvent.click(tile);
    expect(onAdd).not.toHaveBeenCalled();
  });
});
