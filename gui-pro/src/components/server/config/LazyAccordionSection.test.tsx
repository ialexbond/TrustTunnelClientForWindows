import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LazyAccordionSection } from "./LazyAccordionSection";

/**
 * Config H-5: the accordion trigger must link to the panel it controls via
 * aria-controls (and the panel must carry the matching id) so SR/keyboard users
 * know which region the toggle expands. Behavior (lazy-mount, open/close) is
 * unchanged — these are pure accessibility-structure assertions.
 */
describe("LazyAccordionSection — aria-controls trigger↔panel link (Config H-5)", () => {
  it("trigger aria-controls references the panel id", () => {
    render(
      <LazyAccordionSection title="vpn.toml">
        <div>content</div>
      </LazyAccordionSection>,
    );
    const trigger = screen.getByRole("button", { name: /vpn\.toml/ });
    const controlsId = trigger.getAttribute("aria-controls");
    expect(controlsId).toBeTruthy();
    // The referenced element must exist in the DOM and be the content region.
    const panel = document.getElementById(controlsId as string);
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("role", "region");
  });

  it("panel is labelled by the trigger (aria-labelledby ↔ trigger id)", () => {
    render(
      <LazyAccordionSection title="credentials.toml">
        <div>content</div>
      </LazyAccordionSection>,
    );
    const trigger = screen.getByRole("button", { name: /credentials\.toml/ });
    const controlsId = trigger.getAttribute("aria-controls") as string;
    const panel = document.getElementById(controlsId);
    expect(panel).toHaveAttribute("aria-labelledby", trigger.id);
    expect(trigger.id).toBeTruthy();
  });

  it("still toggles aria-expanded and lazy-mounts on open (behavior unchanged)", () => {
    render(
      <LazyAccordionSection title="hosts.toml">
        <div data-testid="lazy-child">payload</div>
      </LazyAccordionSection>,
    );
    const trigger = screen.getByRole("button", { name: /hosts\.toml/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Lazy: child not mounted until first open.
    expect(screen.queryByTestId("lazy-child")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("lazy-child")).toBeInTheDocument();
  });
});
