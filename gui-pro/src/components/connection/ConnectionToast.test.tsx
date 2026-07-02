// Phase 13 / Plan 13-03 (Wave 2) — GREEN tests for the production ConnectionToast plate.
//
// Wave 0 (13-01) shipped these as `it.todo` seams; this fills them against the real component.
// The component is purely presentational (props in, two callbacks out), so no real Tauri window
// is needed — the D-04 body-click/close handlers are plain mocked functions, and the per-kind
// render is driven from the production `notificationCopy` map (the D-25 single source of truth).
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectionToast } from "./ConnectionToast";
import { notificationCopy, buildBody, plateCloseCopy, type NotifyKind } from "./notificationCopy";

// The 7 production kinds (D-01) — the exact keys the plate can render.
const KINDS = Object.keys(notificationCopy) as NotifyKind[];

/** Render ConnectionToast for a kind, driving props from the production copy map — mirroring how
 *  notification.tsx (Task 2) assembles the plate from a `notify-plate` event. */
function renderKind(
  kind: NotifyKind,
  configName: string,
  handlers?: {
    onBodyClick?: () => void;
    onClose?: () => void;
    variant?: "card" | "plate";
    closeLabel?: string;
    closeTooltip?: string;
  },
) {
  const copy = notificationCopy[kind];
  return render(
    <ConnectionToast
      variant={handlers?.variant}
      icon={createElement(copy.icon, { className: "h-5 w-5" })}
      iconColor={copy.iconColor}
      // The component takes a resolved title/body STRING; drive it from the Russian copy (these tests
      // are language-agnostic — the ru↔en selection is covered in notificationCopy.test.ts).
      title={copy.title.ru}
      body={buildBody(kind, configName, "ru")}
      closeLabel={handlers?.closeLabel}
      closeTooltip={handlers?.closeTooltip}
      onBodyClick={handlers?.onBodyClick}
      onClose={handlers?.onClose}
    />,
  );
}

describe("ConnectionToast", () => {
  it("renders per-state title/body for each of the 7 production kinds (D-25)", () => {
    for (const kind of KINDS) {
      const { unmount } = renderKind(kind, "Германия — Frankfurt");
      const plate = screen.getByRole("status");
      // Title is the exact Russian state word from the copy map.
      expect(within(plate).getByText(notificationCopy[kind].title.ru)).toBeInTheDocument();
      // Body is the copy map's built body for this kind + config name.
      expect(
        within(plate).getByText(buildBody(kind, "Германия — Frankfurt", "ru")),
      ).toBeInTheDocument();
      unmount();
    }
  });

  it("body click invokes onBodyClick exactly once (D-04 — restore the window)", async () => {
    const user = userEvent.setup();
    const onBodyClick = vi.fn();
    const onClose = vi.fn();
    renderKind("connected", "Германия — Frankfurt", { onBodyClick, onClose });

    // Click the plate body (the title area) — the whole plate is the body-click target.
    await user.click(screen.getByText(notificationCopy.connected.title.ru));

    expect(onBodyClick).toHaveBeenCalledTimes(1);
    // A body click must NOT also fire the close handler.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("× (close) hides the plate only — calls onClose, NOT onBodyClick (D-04)", async () => {
    const user = userEvent.setup();
    const onBodyClick = vi.fn();
    const onClose = vi.fn();
    renderKind("connectionError", "Германия — Frankfurt", { onBodyClick, onClose });

    // The × is the labelled close affordance.
    await user.click(screen.getByRole("button", { name: "Закрыть уведомление" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    // stopPropagation on the × means the body-click (restore) must NOT fire.
    expect(onBodyClick).not.toHaveBeenCalled();
  });

  it("× label/tooltip localize via closeLabel/closeTooltip; default stays Russian (review #11)", () => {
    // Default (no props): the Russian pair — Storybook/card usages are unchanged.
    const { unmount } = renderKind("connected", "Германия — Frankfurt");
    expect(
      screen.getByRole("button", { name: plateCloseCopy.ru.label }),
    ).toBeInTheDocument();
    unmount();

    // Explicit pair (what notification.tsx passes for an English plate): the × accessible name is
    // the English label — the close affordance no longer stays Russian on an English plate.
    renderKind("connected", "Sweden", {
      closeLabel: plateCloseCopy.en.label,
      closeTooltip: plateCloseCopy.en.tooltip,
    });
    expect(
      screen.getByRole("button", { name: plateCloseCopy.en.label }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: plateCloseCopy.ru.label })).not.toBeInTheDocument();
  });

  it("renders a long config name as wrapping text, never truncated or injected as HTML (V5)", () => {
    // A pathologically long name that would tempt truncation. It must be present in the DOM as
    // TEXT (React-escaped), and the plate must not apply a `truncate` class to the body.
    const longName = "Очень-длинное-имя-конфигурации-которое-точно-не-помещается-в-одну-строку-плашки-".repeat(2);
    renderKind("connected", longName);

    const body = screen.getByText(buildBody("connected", longName, "ru"));
    expect(body).toBeInTheDocument();
    // Body wraps (width-capped), never truncates — assert no `truncate` utility on the body line.
    expect(body.className).not.toContain("truncate");
  });

  it("renders body as React text — an HTML-looking config name is escaped, not parsed (V5)", () => {
    // A config name carrying markup must appear verbatim as text (no injected <img> element).
    const markupName = '<img src=x onerror="alert(1)">';
    const { container } = renderKind("connected", markupName);

    // The exact string is present as text …
    expect(screen.getByText(buildBody("connected", markupName, "ru"))).toBeInTheDocument();
    // … and NO real <img> element was created from it (would exist if innerHTML were used).
    expect(container.querySelector("img")).toBeNull();
  });

  it("variant=plate fills the window, keeps the border, drops rounding+shadow; card keeps all (13-07)", () => {
    // variant="plate" (production desktop plate): the DWM-rounded opaque WINDOW provides the rounding,
    // so the toast must NOT draw its OWN rounding or shadow — but it KEEPS the 1px border and top-aligns
    // (items-start) to match the Storybook design 1:1, and it FILLS the window (h-full w-full) so the
    // window (sized to the content height) has no «подложка».
    const { unmount } = renderKind("connected", "Sweden", { variant: "plate" });
    const plate = screen.getByRole("status");
    expect(plate.className).toContain("h-full");
    expect(plate.className).toContain("w-full");
    expect(plate.className).toContain("items-start");
    expect(plate.className).toMatch(/\bborder\b/); // border KEPT (matches the design edge)
    expect(plate.className).not.toMatch(/\brounded-/); // rounding comes from the DWM window, not the card
    expect(plate.className).not.toMatch(/\bshadow-/); // the design has no drop shadow
    unmount();

    // variant="card" (default, Storybook/preview): unchanged — keeps rounding + border + shadow.
    renderKind("connected", "Sweden", { variant: "card" });
    const card = screen.getByRole("status");
    expect(card.className).toMatch(/\brounded-/);
    expect(card.className).toMatch(/\bborder\b/);
    expect(card.className).toMatch(/\bshadow-/);
  });
});
