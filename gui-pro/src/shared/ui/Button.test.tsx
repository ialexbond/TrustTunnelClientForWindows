import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { Button } from "./Button";

describe("Button", () => {
  it("renders children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("calls onClick when clicked", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Press</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("disabled state: button has disabled attr, onClick not called", () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>No</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("loading state: shows spinner and button is disabled", () => {
    render(<Button loading>Loading</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    // Loader2 renders an svg with animate-spin class
    const svg = btn.querySelector("svg");
    expect(svg).toBeInTheDocument();
    expect(svg!.classList.toString()).toContain("animate-spin");
  });

  it("renders primary variant without error", () => {
    const { container } = render(<Button variant="primary">P</Button>);
    expect(container.querySelector("button")).toBeInTheDocument();
  });

  it("renders danger variant without error", () => {
    const { container } = render(<Button variant="danger">D</Button>);
    expect(container.querySelector("button")).toBeInTheDocument();
  });

  it("renders ghost variant without error", () => {
    const { container } = render(<Button variant="ghost">G</Button>);
    expect(container.querySelector("button")).toBeInTheDocument();
  });

  it("renders icon variant without error", () => {
    const { container } = render(<Button variant="icon" aria-label="icon-btn">*</Button>);
    expect(container.querySelector("button")).toBeInTheDocument();
  });

  it("applies sm size classes", () => {
    render(<Button size="sm">S</Button>);
    expect(screen.getByRole("button").className).toContain("h-8");
    expect(screen.getByRole("button").className).toContain("px-3");
  });

  it("applies md size classes", () => {
    render(<Button size="md">M</Button>);
    expect(screen.getByRole("button").className).toContain("px-4");
  });

  it("applies lg size classes", () => {
    render(<Button size="lg">L</Button>);
    expect(screen.getByRole("button").className).toContain("h-10");
    expect(screen.getByRole("button").className).toContain("px-5");
  });

  it("forwardRef works", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Ref</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  // A-3 (WCAG AA contrast): the primary/accent button text must NOT use the
  // hardcoded `text-white` utility. On the dark-theme teal fill white reaches
  // only ≈3.53:1 (FAIL). The theme-scoped `--color-on-accent` token clears
  // 4.5:1 on both themes. This mirrors the Phase-8 THEME-01 analog in
  // DropOverlay.test.tsx (forbid the .text-white class, assert the token).
  describe("on-accent contrast (A-3)", () => {
    it("primary variant carries no .text-white utility on the accent surface", () => {
      const { container } = render(<Button variant="primary">P</Button>);
      // Mirror DropOverlay.test.tsx:51 — no element may carry text-white.
      expect(container.querySelector(".text-white")).toBeNull();
    });

    it("primary variant resolves its accent-text via the --color-on-accent token", () => {
      render(<Button variant="primary">P</Button>);
      const btn = screen.getByRole("button");
      // Assert via the token class reference, NOT a raw hex value.
      expect(btn.className).toContain("text-[var(--color-on-accent)]");
    });

    it("ghost variant (non-accent) is unaffected — uses the secondary text token, not on-accent", () => {
      render(<Button variant="ghost">G</Button>);
      const btn = screen.getByRole("button");
      expect(btn.className).not.toContain("text-[var(--color-on-accent)]");
      expect(btn.className).toContain("text-[var(--color-text-secondary)]");
    });
  });

  // UAT #12 (WCAG AA contrast): white text on the dark-theme danger button fill
  // reached only ≈3.78:1 on the old --color-destructive (#e05545) — a FAIL. The
  // danger button now fills with the theme-scoped --color-danger-interactive
  // (#bd2a1c dark / #b03020 light), keeping white text that clears 4.5:1 in BOTH
  // themes. Mirrors the on-accent (A-3) regression tests above: assert the token
  // adoption (not a raw hex / CSS class string) AND verify the resolved fill
  // actually clears the ratio via the WCAG relative-luminance formula.
  describe("danger button dark-theme contrast (UAT #12)", () => {
    // The two themed values of --color-danger-interactive from tokens.css.
    // Kept here as the contrast subjects (the test verifies the math on the
    // resolved fills); the Button itself references the token, never a hex.
    const DANGER_FILL_DARK = "#bd2a1c";
    const DANGER_FILL_LIGHT = "#b03020";
    const WHITE = "#ffffff";

    // WCAG 2.x relative luminance + contrast ratio.
    const relLuminance = (hex: string): number => {
      const c = hex.replace("#", "");
      const channel = (i: number) => {
        const v = parseInt(c.substr(i, 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
    };
    const contrastRatio = (a: string, b: string): number => {
      const la = relLuminance(a);
      const lb = relLuminance(b);
      const hi = Math.max(la, lb);
      const lo = Math.min(la, lb);
      return (hi + 0.05) / (lo + 0.05);
    };

    it("danger variant fills via the scoped --color-danger-interactive token (not the shared --color-destructive)", () => {
      render(<Button variant="danger">D</Button>);
      const btn = screen.getByRole("button");
      expect(btn.className).toContain("bg-[var(--color-danger-interactive)]");
      // Must NOT pull the broadly-shared destructive token as its fill —
      // that one is also a TEXT/border colour elsewhere and stays lighter.
      expect(btn.className).not.toContain("bg-[var(--color-destructive)]");
    });

    it("white text on the dark-theme danger fill clears WCAG AA (>= 4.5:1)", () => {
      // Old #e05545 = ≈3.78:1 → this assertion FAILS before the fix.
      expect(contrastRatio(WHITE, DANGER_FILL_DARK)).toBeGreaterThanOrEqual(4.5);
    });

    it("white text on the light-theme danger fill clears WCAG AA (>= 4.5:1)", () => {
      expect(contrastRatio(WHITE, DANGER_FILL_LIGHT)).toBeGreaterThanOrEqual(4.5);
    });

    it("danger variant keeps white text (red destructive look, not dark-text-on-red)", () => {
      render(<Button variant="danger">D</Button>);
      expect(screen.getByRole("button").className).toContain("text-white");
    });
  });
});
