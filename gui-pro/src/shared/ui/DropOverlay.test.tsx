import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { DropOverlay } from "./DropOverlay";
import i18n from "../i18n";

describe("DropOverlay", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
  });

  it("renders nothing when isDragging is false", () => {
    const { container } = render(<DropOverlay isDragging={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders overlay when isDragging is true", () => {
    render(<DropOverlay isDragging={true} />);
    expect(screen.getByText("Перетащите файл сюда")).toBeInTheDocument();
  });

  it("shows hint text about supported formats", () => {
    render(<DropOverlay isDragging={true} />);
    expect(screen.getByText(/\.toml.*\.json/)).toBeInTheDocument();
  });

  it("has backdrop-filter blur style", () => {
    const { container } = render(<DropOverlay isDragging={true} />);
    const overlay = container.firstChild as HTMLElement;
    expect(overlay.style.backdropFilter).toBe("blur(8px)");
  });

  it("has pointer-events none to not block drag events", () => {
    const { container } = render(<DropOverlay isDragging={true} />);
    const overlay = container.firstChild as HTMLElement;
    expect(overlay.style.pointerEvents).toBe("none");
  });

  it("renders with English text when language is en", () => {
    i18n.changeLanguage("en");
    render(<DropOverlay isDragging={true} />);
    expect(screen.getByText("Drop file here")).toBeInTheDocument();
  });

  it("uses theme-aware token text color, NOT hardcoded white", () => {
    // Regression: the content used the Tailwind `text-white` class, which is
    // invisible on the LIGHT-theme glass backdrop (white-on-light). The old
    // assertion only checked inline `color: #fff` and so missed the class.
    const { container } = render(<DropOverlay isDragging={true} />);

    // 1. No element may carry the hardcoded `text-white` utility.
    expect(container.querySelector(".text-white")).toBeNull();

    // 2. No inline hardcoded white either.
    const hasHardcodedWhite = Array.from(
      container.querySelectorAll("[style]")
    ).some((el) => {
      const c = (el as HTMLElement).style.color;
      return c === "#fff" || c === "rgb(255, 255, 255)" || c === "white";
    });
    expect(hasHardcodedWhite).toBe(false);

    // 3. The content wrapper drives colour from the theme token (the SVG icon
    //    inherits it via stroke="currentColor"), so it adapts per theme. Assert
    //    via the raw style attribute — jsdom's typed `.style.color` getter
    //    returns "" for a `var(...)` value (it fails the <color> validator).
    const content = screen.getByText("Перетащите файл сюда").parentElement!;
    expect(content.getAttribute("style")).toContain(
      "color: var(--color-text-primary)"
    );
  });

  it("uses token-based font size (not hardcoded 18px)", () => {
    const { container } = render(<DropOverlay isDragging={true} />);
    const allElements = container.querySelectorAll("[style]");
    const hasHardcoded18px = Array.from(allElements).some((el) => {
      const style = (el as HTMLElement).style;
      return style.fontSize === "18px";
    });
    expect(hasHardcoded18px).toBe(false);
  });
});
