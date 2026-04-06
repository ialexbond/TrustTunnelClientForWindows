import { describe, it, expect } from "vitest";
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
});
