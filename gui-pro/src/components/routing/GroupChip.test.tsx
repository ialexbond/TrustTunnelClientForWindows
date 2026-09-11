import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  // Была версия «у чипа в блоке „Заблокировать“ две стрелки». Блокировка удалена 2026-09-03, блоков
  // осталось два — значит у каждого ровно ОДНА цель переноса, и это теперь и есть проверяемое
  // свойство: лишняя стрелка означала бы, что в карту `moveTargets` вернулось направление, которого
  // на вкладке нет.
  it("offers exactly one move arrow — there are two blocks, so one destination", () => {
    renderChip({ currentAction: "direct" });
    expect(screen.getByLabelText("Переместить в VPN")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Переместить в / })).toHaveLength(1);
  });

  // The move arrows' D-06 tests.
  //
  // Honest limitation, stated once for the three tests below: jsdom loads no Tailwind and never
  // evaluates `:focus-visible`, so a `toBeVisible()` or computed-style assertion here would have
  // passed on the OLD, hover-gated markup too and would therefore prove nothing. What IS provable
  // in jsdom is the accessible name, keyboard reachability, and the absence of the zero-opacity
  // utility on the arrow and on every element wrapping it. The appearance itself is shown by the
  // Storybook story `Removable` and confirmed by human UAT in dark and light theme; the repo-level
  // machine check is .planning/phases/24-*/scripts/hover-reveal-guard.sh.

  it("exposes every move arrow by role and accessible name", () => {
    renderChip({ currentAction: "proxy" });
    // Queried by ROLE + accessible name, never by title: a `title` attribute is an unreliable
    // accessible name, so this lookup only succeeds while each arrow carries a real aria-label.
    expect(screen.getByRole("button", { name: "Переместить в Напрямую" })).toBeInTheDocument();
  });

  it("move arrow is keyboard reachable and performs the same move a click does", async () => {
    renderChip({ currentAction: "proxy", entry: makeEntry({ id: "grp_kb" }) });
    const user = userEvent.setup();
    const arrow = screen.getByRole("button", { name: "Переместить в Напрямую" });

    // Tab until the arrow takes focus. Under the old gate this focus landed on a control the user
    // could not see — the exact warning raised at 22-VERIFICATION.md:172.
    for (let i = 0; i < 12 && document.activeElement !== arrow; i++) {
      await user.tab();
    }
    expect(arrow).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onMove).toHaveBeenCalledWith("grp_kb", "direct");
  });

  it("no element wrapping a move arrow carries a zero-opacity gate", () => {
    renderChip({ currentAction: "proxy" });
    const arrow = screen.getByRole("button", { name: "Переместить в Напрямую" });
    // The class-level twin of hover-reveal-guard.sh: neither the arrow nor anything wrapping it
    // may start invisible.
    const chain = classNameChain(arrow);
    expect(chain.some((c) => c.includes("opacity-0"))).toBe(false);
    expect(chain.some((c) => c.includes("group-hover:opacity-100"))).toBe(false);
  });
});
