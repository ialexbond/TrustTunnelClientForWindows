import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/**
 * className of an element and of every element wrapping it, up to the render root. The D-06 defect
 * never lived on the control itself — it lived on a wrapper div around the arrow group — so an
 * assertion that only inspects the button would have missed it entirely.
 */
function classNameChain(el: HTMLElement): string[] {
  const chain: string[] = [];
  let node: HTMLElement | null = el;
  while (node) {
    chain.push(node.className);
    node = node.parentElement;
  }
  return chain;
}

describe("RuleEntryRow", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onRemove: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onMove: any;

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
    // R21-03: delete/move migrated to the shared IconButton, which exposes its
    // label via aria-label (+ Tooltip portal) rather than a raw `title` attr —
    // query by accessible name; behavioral expectations are unchanged.
    const deleteBtn = screen.getByLabelText("Удалить запись");
    fireEvent.click(deleteBtn);
    expect(onRemove).toHaveBeenCalledWith("rule_1");
  });

  it("shows move button to direct when current action is proxy", () => {
    renderRow({ currentAction: "proxy" });
    const moveBtn = screen.getByLabelText("Переместить в Напрямую");
    expect(moveBtn).toBeInTheDocument();
  });

  it("shows move button to proxy when current action is direct", () => {
    renderRow({ currentAction: "direct" });
    const moveBtn = screen.getByLabelText("Переместить в VPN");
    expect(moveBtn).toBeInTheDocument();
  });

  it("calls onMove with correct parameters", () => {
    renderRow({ currentAction: "proxy", entry: makeEntry({ id: "rule_42" }) });
    const moveBtn = screen.getByLabelText("Переместить в Напрямую");
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
    expect(screen.getByLabelText("Переместить в Напрямую")).toBeInTheDocument();
    expect(screen.getByLabelText("Переместить в VPN")).toBeInTheDocument();
  });

  // The move arrows' D-06 tests.
  //
  // Honest limitation, stated once for the three tests below: jsdom loads no Tailwind and never
  // evaluates `:focus-visible`, so a `toBeVisible()` or computed-style assertion here would have
  // passed on the OLD, hover-gated markup too and would therefore prove nothing. What IS provable
  // in jsdom is the accessible name, keyboard reachability, and the absence of the zero-opacity
  // utility on the arrow and on every element wrapping it. The appearance itself is shown by the
  // Storybook story `ActionsVisible` and confirmed by human UAT in dark and light theme; the
  // repo-level machine check is .planning/phases/24-*/scripts/hover-reveal-guard.sh.

  it("exposes every move arrow by role and accessible name", () => {
    renderRow({ currentAction: "block" });
    // Queried by ROLE + accessible name, never by title: a `title` attribute is an unreliable
    // accessible name, so this lookup only succeeds while each arrow carries a real aria-label.
    expect(screen.getByRole("button", { name: "Переместить в Напрямую" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Переместить в VPN" })).toBeInTheDocument();
  });

  it("move arrow is keyboard reachable and performs the same move a click does", async () => {
    renderRow({ currentAction: "proxy", entry: makeEntry({ id: "rule_kb" }) });
    const user = userEvent.setup();
    const arrow = screen.getByRole("button", { name: "Переместить в Напрямую" });

    // Tab until the arrow takes focus. Under the old gate this focus landed on a control the user
    // could not see — the exact warning raised at 22-VERIFICATION.md:172.
    for (let i = 0; i < 12 && document.activeElement !== arrow; i++) {
      await user.tab();
    }
    expect(arrow).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onMove).toHaveBeenCalledWith("rule_kb", "direct");
  });

  it("no element wrapping a move arrow carries a zero-opacity gate", () => {
    renderRow({ currentAction: "block" });
    const arrow = screen.getByRole("button", { name: "Переместить в Напрямую" });
    // The class-level twin of hover-reveal-guard.sh: neither the arrow nor anything wrapping it
    // may start invisible.
    const chain = classNameChain(arrow);
    expect(chain.some((c) => c.includes("opacity-0"))).toBe(false);
    expect(chain.some((c) => c.includes("group-hover:opacity-100"))).toBe(false);
  });
});
