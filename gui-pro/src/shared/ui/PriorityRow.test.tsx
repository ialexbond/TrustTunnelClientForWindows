import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PriorityRow } from "./PriorityRow";
import { ReorderInstructions } from "./ReorderInstructions";
import { PrioritySkeletonRow } from "./PrioritySkeletonRow";

/**
 * The failover priority list is a SETTING, not a status display. Everything asserted here follows
 * from that one sentence:
 *
 *   · an excluded row is still operable, so it is set apart by BACKGROUND, never by opacity —
 *     `--opacity-disabled` means «you cannot use this» in this design system, and here you can;
 *   · numbering counts participating rows only, so an excluded row shows a dash — a number there
 *     would lie about where it stands in the queue;
 *   · no «Текущий» badge and no column caption: the list answers «in what order», the connected
 *     server is already named above it, and a fourth way of saying «this one is off» is noise;
 *   · the reorder gesture is announced FROM THE ROW, because until Phase 27 the only statement that
 *     ↑ / ↓ reorder the queue lived inside a hover-only «?» hint — a keyboard affordance documented
 *     exclusively on a mouse-only surface is not documented at all.
 *
 * `ReorderInstructions` has no behaviour of its own, so it has no test file; its wiring is asserted
 * here, from the row that points at it.
 */

const BASE = {
  name: "Германия — Frankfurt",
  host: "de1.example.com",
  ordinal: 1 as number | null,
  participating: true,
  switchLabel: "Участие сервера «Германия — Frankfurt» в переключении",
  rowLabel: "Германия — Frankfurt, позиция 1 из 3",
  roleDescription: "переставляемая строка",
};

function renderRow(props: Partial<React.ComponentProps<typeof PriorityRow>> = {}) {
  return render(
    <ul>
      <PriorityRow {...BASE} {...props} />
    </ul>,
  );
}

const row = () => screen.getByRole("listitem");

afterEach(() => {
  vi.useRealTimers();
});

describe("PriorityRow", () => {
  describe("numbering", () => {
    it("renders the ordinal of a participating row", () => {
      renderRow({ ordinal: 2 });
      expect(screen.getByText("2")).toBeInTheDocument();
    });

    it("renders a dash instead of a number for an excluded row", () => {
      renderRow({ participating: false, ordinal: null });
      expect(screen.getByText("—")).toBeInTheDocument();
      expect(screen.queryByText("1")).not.toBeInTheDocument();
    });
  });

  describe("the excluded row is set apart, not switched off", () => {
    it("differs from a participating row by BACKGROUND", () => {
      const { unmount } = renderRow();
      const participatingSurface = row().style.backgroundColor;
      unmount();

      renderRow({ participating: false, ordinal: null });
      const excludedSurface = row().style.backgroundColor;

      expect(excludedSurface).not.toBe("");
      expect(excludedSurface).not.toBe(participatingSurface);
    });

    it("is NOT dimmed — no opacity treatment anywhere on the row", () => {
      renderRow({ participating: false, ordinal: null });

      const element = row();
      expect(element.className).not.toMatch(/opacity/);
      expect(element.style.opacity).toBe("");
    });

    it("mutes the NAME rather than the whole row", () => {
      const { unmount } = renderRow();
      const participatingName = screen.getByText(BASE.name).style.color;
      unmount();

      renderRow({ participating: false, ordinal: null });
      expect(screen.getByText(BASE.name).style.color).not.toBe(participatingName);
    });

    it("keeps the participation switch operable", async () => {
      const user = userEvent.setup();
      const onParticipationChange = vi.fn();
      renderRow({ participating: false, ordinal: null, onParticipationChange });

      const toggle = screen.getByRole("switch", { name: BASE.switchLabel });
      expect(toggle).toBeEnabled();

      await user.click(toggle);
      expect(onParticipationChange).toHaveBeenCalledWith(true);
    });
  });

  describe("what the row deliberately does NOT carry", () => {
    // There is no prop that could produce one: the row's shape cannot express «this is the
    // connected server», because the queue answers «in what order», and the status panel above the
    // list already names the current connection.
    it("has no «Текущий» badge, and no prop that could ask for one", () => {
      renderRow();
      expect(screen.queryByText(/текущ/i)).not.toBeInTheDocument();
      expect(Object.keys(BASE)).not.toContain("lastUsed");
    });

    it("has no caption over the switch column", () => {
      renderRow();
      expect(screen.queryByText(/участ/i)).not.toBeInTheDocument();
      // The visible text of the row is exactly: ordinal, name, host. Nothing else.
      expect(row()).toHaveTextContent(`1${BASE.name}${BASE.host}`);
    });
  });

  describe("the reorder gesture is announced from the row", () => {
    it("describes itself as movable and points at the shared instructions node", () => {
      const sentence = "Стрелки вверх и вниз переставляют выбранную строку на одну позицию.";
      render(
        <>
          <ul>
            <PriorityRow {...BASE} instructionsId="reorder-help" />
          </ul>
          <ReorderInstructions id="reorder-help" text={sentence} />
        </>,
      );

      const element = row();
      expect(element).toHaveAttribute("aria-roledescription", BASE.roleDescription);
      expect(element).toHaveAttribute("aria-describedby", "reorder-help");
      expect(document.getElementById("reorder-help")).toHaveTextContent(sentence);
      expect(element).toHaveAccessibleDescription(sentence);
    });

    it("is NOT a listbox option — the switch inside it must stay visible to assistive tech", () => {
      renderRow();
      expect(screen.queryByRole("option")).not.toBeInTheDocument();
      expect(screen.getByRole("switch", { name: BASE.switchLabel })).toBeInTheDocument();
    });

    it("takes focus and forwards its key presses to the caller", async () => {
      const user = userEvent.setup();
      const onKeyDown = vi.fn();
      renderRow({ onKeyDown });

      await user.tab();
      expect(row()).toHaveFocus();

      await user.keyboard("{ArrowDown}");
      expect(onKeyDown).toHaveBeenCalled();
    });
  });

  describe("the participation switch", () => {
    it("carries its own name, naming the server", () => {
      renderRow();
      expect(screen.getByRole("switch", { name: BASE.switchLabel })).toBeInTheDocument();
    });

    it("does not start a drag", () => {
      const onDragStart = vi.fn();
      renderRow({ onDragStart });

      fireEvent.dragStart(screen.getByRole("switch", { name: BASE.switchLabel }));
      expect(onDragStart).not.toHaveBeenCalled();

      // ...while the row itself still drags.
      fireEvent.dragStart(row());
      expect(onDragStart).toHaveBeenCalledTimes(1);
    });
  });

  describe("reorderable and locked are two different things", () => {
    it("reorderable=false: no grab handle, not draggable, nothing to announce", () => {
      renderRow({ reorderable: false, instructionsId: "reorder-help" });

      expect(screen.queryByTestId("priority-row-grip")).not.toBeInTheDocument();
      expect(row()).not.toHaveAttribute("draggable", "true");
      expect(row()).not.toHaveAttribute("aria-roledescription");
      expect(row()).not.toHaveAttribute("aria-describedby");
    });

    it("locked=true: the handle STAYS and everything is disabled", () => {
      renderRow({ locked: true, switchDisabled: true });

      // The handle must not vanish mid-operation: a card that changes shape under a spinner reads
      // as a second, unrelated thing going wrong.
      expect(screen.getByTestId("priority-row-grip")).toBeInTheDocument();
      expect(row()).not.toHaveAttribute("draggable", "true");
      expect(screen.getByRole("switch", { name: BASE.switchLabel })).toBeDisabled();
    });

    it("the default row is draggable and shows the handle", () => {
      renderRow();
      expect(screen.getByTestId("priority-row-grip")).toBeInTheDocument();
      expect(row()).toHaveAttribute("draggable", "true");
    });
  });

  describe("a very long name", () => {
    const longName =
      "Нидерланды — Amsterdam, резервный узел для европейского направления, узел №4";

    it("keeps the switch in its own cell beside the name column", () => {
      expect(longName.length).toBeGreaterThanOrEqual(60);
      renderRow({ name: longName, switchLabel: "Участие" });

      const toggle = screen.getByRole("switch", { name: "Участие" });
      const nameNode = screen.getByText(longName);
      // The structural guarantee: the switch cell is NOT nested inside the flexible name column.
      // A row that nested it there is exactly how a control gets pushed off the row.
      expect(nameNode.closest("li")).toBe(toggle.closest("li"));
      expect(nameNode.contains(toggle)).toBe(false);
    });

    it("exposes the full name in a tooltip", () => {
      vi.useFakeTimers();
      renderRow({ name: longName });

      // The name lives inside the Tooltip wrapper; hovering it shows the full value.
      fireEvent.mouseEnter(screen.getByText(longName).parentElement!);
      act(() => {
        vi.advanceTimersByTime(450);
      });

      expect(screen.getByRole("tooltip")).toHaveTextContent(longName);
    });
  });

  describe("the address column", () => {
    it("renders the host when there is one", () => {
      renderRow();
      expect(screen.getByText(BASE.host)).toBeInTheDocument();
    });

    it("renders nothing when there is none", () => {
      renderRow({ host: undefined });
      expect(screen.queryByText(BASE.host)).not.toBeInTheDocument();
    });
  });
});

describe("PrioritySkeletonRow", () => {
  it("occupies the same columns as a real row, minus the address", () => {
    const { container } = render(
      <ul>
        <PrioritySkeletonRow />
      </ul>,
    );

    // grip · ordinal · name · switch — four placeholders, no fifth for the host, because the
    // address arrives with the data. A skeleton in a different shape makes the panel jump the
    // moment real data lands, which is the one thing a skeleton exists to prevent.
    expect(container.querySelectorAll("li > div")).toHaveLength(4);
    expect(screen.getByRole("listitem")).toHaveTextContent("");
  });
});
