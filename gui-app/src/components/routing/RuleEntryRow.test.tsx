import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { RuleEntryRow } from "./RuleEntryRow";
import type { RuleEntry, RouteAction } from "./useRoutingState";

function makeEntry(overrides: Partial<RuleEntry> = {}): RuleEntry {
  return {
    id: "rule_1",
    type: "domain",
    value: "example.com",
    ...overrides,
  };
}

describe("RuleEntryRow", () => {
  let onRemove: ReturnType<typeof vi.fn>;
  let onMove: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    i18n.changeLanguage("ru");
    onRemove = vi.fn();
    onMove = vi.fn();
  });

  function renderRow(overrides: { entry?: RuleEntry; currentAction?: RouteAction } = {}) {
    return render(
      <RuleEntryRow
        entry={overrides.entry ?? makeEntry()}
        currentAction={overrides.currentAction ?? "proxy"}
        onRemove={onRemove}
        onMove={onMove}
      />,
    );
  }

  it("renders without crashing", () => {
    renderRow();
    expect(screen.getByText("example.com")).toBeInTheDocument();
  });

  it("displays entry value", () => {
    renderRow({ entry: makeEntry({ value: "test.org" }) });
    expect(screen.getByText("test.org")).toBeInTheDocument();
  });

  it("displays entry type badge", () => {
    renderRow({ entry: makeEntry({ type: "domain" }) });
    expect(screen.getByText("domain")).toBeInTheDocument();
  });

  it("displays geoip type badge", () => {
    renderRow({ entry: makeEntry({ type: "geoip", value: "geoip:RU" }) });
    expect(screen.getByText("geoip")).toBeInTheDocument();
  });

  it("displays ip type badge", () => {
    renderRow({ entry: makeEntry({ type: "ip", value: "192.168.1.1" }) });
    expect(screen.getByText("ip")).toBeInTheDocument();
  });

  it("displays cidr type badge", () => {
    renderRow({ entry: makeEntry({ type: "cidr", value: "10.0.0.0/8" }) });
    expect(screen.getByText("cidr")).toBeInTheDocument();
  });

  it("calls onRemove with entry id when delete button clicked", () => {
    renderRow();
    const deleteBtn = screen.getByTitle("Удалить запись");
    fireEvent.click(deleteBtn);
    expect(onRemove).toHaveBeenCalledWith("rule_1");
  });

  it("shows move button to direct when current action is proxy", () => {
    renderRow({ currentAction: "proxy" });
    const moveBtn = screen.getByTitle("Переместить в Напрямую");
    expect(moveBtn).toBeInTheDocument();
  });

  it("shows move button to proxy when current action is direct", () => {
    renderRow({ currentAction: "direct" });
    const moveBtn = screen.getByTitle("Переместить в VPN");
    expect(moveBtn).toBeInTheDocument();
  });

  it("calls onMove with correct parameters", () => {
    renderRow({ currentAction: "proxy", entry: makeEntry({ id: "rule_42" }) });
    const moveBtn = screen.getByTitle("Переместить в Напрямую");
    fireEvent.click(moveBtn);
    expect(onMove).toHaveBeenCalledWith("rule_42", "direct");
  });

  it("renders geosite entry correctly", () => {
    renderRow({ entry: makeEntry({ type: "geosite", value: "geosite:google" }) });
    expect(screen.getByText("geosite")).toBeInTheDocument();
    expect(screen.getByText("geosite:google")).toBeInTheDocument();
  });

  it("renders with block action (shows both direct and proxy move targets)", () => {
    renderRow({ currentAction: "block" });
    expect(screen.getByTitle("Переместить в Напрямую")).toBeInTheDocument();
    expect(screen.getByTitle("Переместить в VPN")).toBeInTheDocument();
  });
});
