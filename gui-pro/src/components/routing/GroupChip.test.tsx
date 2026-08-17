import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { GroupChip } from "./GroupChip";
import type { RuleEntry, RouteAction } from "./useRoutingState";

function makeEntry(overrides: Partial<RuleEntry> = {}): RuleEntry {
  return {
    id: "grp_1",
    type: "geosite",
    value: "geosite:youtube",
    ...overrides,
  };
}

describe("GroupChip", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onRemove: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onMove: any;

  beforeEach(() => {
    i18n.changeLanguage("ru");
    onRemove = vi.fn();
    onMove = vi.fn();
  });

  function renderChip(overrides: {
    entry?: RuleEntry;
    currentAction?: RouteAction;
    label?: string;
  } = {}) {
    return render(
      <GroupChip
        entry={overrides.entry ?? makeEntry()}
        currentAction={overrides.currentAction ?? "proxy"}
        label={overrides.label ?? "YouTube"}
        onRemove={onRemove}
        onMove={onMove}
      />,
    );
  }

  it("renders the localized group label with a group glyph", () => {
    renderChip({ label: "Соцсети" });
    expect(screen.getByText("Соцсети")).toBeInTheDocument();
  });

  it("shows an always-visible remove control (no hover gate)", () => {
    renderChip();
    // The remove button is present at rest — the whole point of «Удаление всегда видно».
    expect(screen.getByLabelText("Удалить запись")).toBeInTheDocument();
  });

  it("exposes a keyboard-accessible move arrow per target (proxy chip → Напрямую)", () => {
    // D-1: move is a per-target ArrowRight button (same pattern as RuleEntryRow), NOT an
    // OverflowMenu «...». A proxy chip offers the single target «Напрямую».
    renderChip({ currentAction: "proxy" });
    expect(screen.getByLabelText("Переместить в Напрямую")).toBeInTheDocument();
  });

  it("calls onRemove with the entry id when remove is clicked", () => {
    renderChip({ entry: makeEntry({ id: "grp_42" }) });
    fireEvent.click(screen.getByLabelText("Удалить запись"));
    expect(onRemove).toHaveBeenCalledWith("grp_42");
  });

  it("moves the group to the target block on a single arrow click (proxy → direct)", () => {
    renderChip({ currentAction: "proxy", entry: makeEntry({ id: "grp_7" }) });
    // No menu to open — click the target arrow directly.
    fireEvent.click(screen.getByLabelText("Переместить в Напрямую"));
    expect(onMove).toHaveBeenCalledWith("grp_7", "direct");
  });

  it("offers both target arrows for a block chip", () => {
    renderChip({ currentAction: "block" });
    expect(screen.getByLabelText("Переместить в Напрямую")).toBeInTheDocument();
    expect(screen.getByLabelText("Переместить в VPN")).toBeInTheDocument();
  });
});
