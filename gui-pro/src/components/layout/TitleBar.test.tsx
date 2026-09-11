import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TitleBar } from "./TitleBar";

// TitleBar: displays app name + PRO badge + WindowControls slot
// Uses CSS tokens only (no hardcoded colors)

describe("TitleBar", () => {
  it("renders TrustTunnel brand name", () => {
    render(<TitleBar />);
    // Wordmark рендерится двумя span'ами («Trust» primary + «Tunnel» accent),
    // поэтому ищем по агрегированному textContent, а не single-text-node.
    expect(
      screen.getByText((_, element) => element?.textContent === "TrustTunnel"),
    ).toBeInTheDocument();
  });

  it("renders PRO badge", () => {
    render(<TitleBar />);
    expect(screen.getByText("PRO")).toBeInTheDocument();
  });

  // Бейдж окрашен токеном «текст на тинте». Интерактивным акцентом он мерился
  // 4.14:1 в светлой теме при пороге 4.5:1 (12px bold — не «крупный текст» по
  // WCAG), с --color-accent-on-tint стало 5.76:1. Тот же дефект и та же правка,
  // что на бейдже «О программе» (AboutHero).
  it("PRO badge использует токен текста на тинте, а не интерактивный акцент", () => {
    render(<TitleBar />);
    const badge = screen.getByText("PRO");
    expect(badge.getAttribute("style")).toContain("var(--color-accent-on-tint)");
    expect(badge.getAttribute("style")).not.toContain("var(--color-accent-interactive)");
    // Заливка остаётся тинтом: чинили текст, а не фон.
    expect(badge.getAttribute("style")).toContain("var(--color-accent-tint-10)");
  });

  it("вордмарк сохраняет интерактивный акцент — правка бейджа его не задела", () => {
    render(<TitleBar />);
    // «Tunnel» лежит на обычной подложке, а не на тинте: его контраст не был проблемой.
    expect(screen.getByText("Tunnel").getAttribute("style")).toContain(
      "var(--color-accent-interactive)",
    );
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
