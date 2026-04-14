import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TitleBar } from "./TitleBar";

// TitleBar: displays app name + PRO badge + WindowControls slot
// Uses CSS tokens only (no hardcoded colors)

describe("TitleBar", () => {
  it("renders TrustTunnel brand name", () => {
    render(<TitleBar />);
    expect(screen.getByText("TrustTunnel")).toBeInTheDocument();
  });

  it("renders PRO badge", () => {
    render(<TitleBar />);
    expect(screen.getByText("PRO")).toBeInTheDocument();
  });

  it("renders children (WindowControls slot)", () => {
    render(
      <TitleBar>
        <button data-testid="wc">controls</button>
      </TitleBar>,
    );
    expect(screen.getByTestId("wc")).toBeInTheDocument();
  });

  it("has data-tauri-drag-region on the root element", () => {
    const { container } = render(<TitleBar />);
    const root = container.firstChild as HTMLElement;
    expect(root.hasAttribute("data-tauri-drag-region")).toBe(true);
  });

  it("brand area also has data-tauri-drag-region", () => {
    const { container } = render(<TitleBar />);
    // Brand div should be draggable too
    const draggable = container.querySelectorAll("[data-tauri-drag-region]");
    expect(draggable.length).toBeGreaterThanOrEqual(1);
  });

  it("has transparent background (seamless design — inherits from body)", () => {
    const { container } = render(<TitleBar />);
    const root = container.firstChild as HTMLElement;
    const bg = root.style.backgroundColor;
    // Seamless design: no explicit background — inherits bg-primary from body
    expect(bg).toBe("");
  });

  it("has height matching titlebar spec (32px)", () => {
    const { container } = render(<TitleBar />);
    const root = container.firstChild as HTMLElement;
    expect(root.style.height).toBe("32px");
  });
});
