import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { RoutingBlockCard } from "./RoutingBlockCard";
import type { RuleEntry, RouteAction, GeoDataStatus, GeoDataIndex } from "./useRoutingState";

// Mock child components to simplify testing
vi.mock("./RuleEntryRow", () => ({
  RuleEntryRow: ({ entry, onRemove, onMove, currentAction }: any) => (
    <div data-testid={`rule-entry-${entry.id}`}>
      <span>{entry.value}</span>
      <button onClick={() => onRemove(entry.id)} data-testid={`remove-${entry.id}`}>remove</button>
      <button onClick={() => onMove(entry.id, currentAction === "direct" ? "proxy" : "direct")} data-testid={`move-${entry.id}`}>move</button>
    </div>
  ),
}));

vi.mock("./AddRuleInput", () => ({
  AddRuleInput: ({ action }: any) => (
    <div data-testid={`add-rule-input-${action}`}>add-rule-input</div>
  ),
}));

describe("RoutingBlockCard", () => {
  let onAdd: ReturnType<typeof vi.fn>;
  let onRemove: ReturnType<typeof vi.fn>;
  let onMove: ReturnType<typeof vi.fn>;

  const defaultGeoStatus: GeoDataStatus = {
    downloaded: false,
    geoip_exists: false,
    geosite_exists: false,
  };

  const defaultGeoCategories: GeoDataIndex = {
    geoip: [],
    geosite: [],
  };

  const sampleEntries: RuleEntry[] = [
    { id: "1", type: "domain", value: "example.com" },
    { id: "2", type: "ip", value: "1.2.3.4" },
    { id: "3", type: "geosite", value: "geosite:category-ads" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    onAdd = vi.fn();
    onRemove = vi.fn();
    onMove = vi.fn();
  });

  function renderCard(overrides: {
    action?: RouteAction;
    entries?: RuleEntry[];
  } = {}) {
    return render(
      <RoutingBlockCard
        action={overrides.action ?? "direct"}
        entries={overrides.entries ?? sampleEntries}
        geodataStatus={defaultGeoStatus}
        geodataCategories={defaultGeoCategories}
        onAdd={onAdd}
        onRemove={onRemove}
        onMove={onMove}
      />,
    );
  }

  it("renders direct card with correct title", () => {
    renderCard({ action: "direct" });
    expect(screen.getByText("Напрямую")).toBeInTheDocument();
  });

  it("renders proxy card with correct title", () => {
    renderCard({ action: "proxy" });
    expect(screen.getByText("Через VPN")).toBeInTheDocument();
  });

  it("renders block card with correct title", () => {
    renderCard({ action: "block" });
    expect(screen.getByText("Заблокировать")).toBeInTheDocument();
  });

  it("shows description text for direct action", () => {
    renderCard({ action: "direct" });
    // Description should be visible (not collapsed)
    expect(screen.getByText(/минуя VPN-туннель/)).toBeInTheDocument();
  });

  it("renders all rule entries", () => {
    renderCard();
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("1.2.3.4")).toBeInTheDocument();
    expect(screen.getByText("geosite:category-ads")).toBeInTheDocument();
  });

  it("renders empty state when no entries", () => {
    renderCard({ entries: [] });
    expect(screen.getByText("Нет записей")).toBeInTheDocument();
  });

  it("renders AddRuleInput for the action", () => {
    renderCard({ action: "proxy" });
    expect(screen.getByTestId("add-rule-input-proxy")).toBeInTheDocument();
  });

  it("collapses content when header is clicked", () => {
    renderCard();
    // Initially content is visible
    expect(screen.getByText("example.com")).toBeInTheDocument();

    // Click header button to collapse
    const headerButton = screen.getByRole("button", { name: /напрямую/i });
    fireEvent.click(headerButton);

    // Content should be hidden
    expect(screen.queryByText("example.com")).not.toBeInTheDocument();
  });

  it("expands content when header is clicked again after collapse", () => {
    renderCard();

    const headerButton = screen.getByRole("button", { name: /напрямую/i });
    // Collapse
    fireEvent.click(headerButton);
    expect(screen.queryByText("example.com")).not.toBeInTheDocument();

    // Expand
    fireEvent.click(headerButton);
    expect(screen.getByText("example.com")).toBeInTheDocument();
  });

  it("calls onRemove with correct action and id when entry remove is clicked", () => {
    renderCard({ action: "direct" });
    fireEvent.click(screen.getByTestId("remove-1"));
    expect(onRemove).toHaveBeenCalledWith("direct", "1");
  });

  it("calls onMove with correct actions when entry move is clicked", () => {
    renderCard({ action: "direct" });
    fireEvent.click(screen.getByTestId("move-1"));
    expect(onMove).toHaveBeenCalledWith("direct", "proxy", "1");
  });

  it("does not render entries or AddRuleInput when collapsed", () => {
    renderCard();
    const headerButton = screen.getByRole("button", { name: /напрямую/i });
    fireEvent.click(headerButton);

    expect(screen.queryByTestId("add-rule-input-direct")).not.toBeInTheDocument();
    expect(screen.queryByTestId("rule-entry-1")).not.toBeInTheDocument();
  });

  it("renders AddRuleInput for direct action", () => {
    renderCard({ action: "direct" });
    expect(screen.getByTestId("add-rule-input-direct")).toBeInTheDocument();
  });

  it("renders AddRuleInput for block action", () => {
    renderCard({ action: "block" });
    expect(screen.getByTestId("add-rule-input-block")).toBeInTheDocument();
  });
});
