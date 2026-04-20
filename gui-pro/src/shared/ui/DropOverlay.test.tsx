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

  it("uses token-based text color (not hardcoded #fff)", () => {
    const { container } = render(<DropOverlay isDragging={true} />);
    // The inner content div should NOT have hardcoded color: #fff
    const allElements = container.querySelectorAll("[style]");
    const hasHardcodedWhite = Array.from(allElements).some((el) => {
      const style = (el as HTMLElement).style;
      return style.color === "#fff" || style.color === "rgb(255, 255, 255)";
    });
    expect(hasHardcodedWhite).toBe(false);
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
