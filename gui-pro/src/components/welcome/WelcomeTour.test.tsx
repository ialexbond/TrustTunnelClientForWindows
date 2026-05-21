import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { WelcomeTour } from "./WelcomeTour";

describe("WelcomeTour", () => {
  beforeEach(() => {
    localStorage.clear();
    i18n.changeLanguage("ru");
  });

  it("renders Screen 1 by default (initial mount)", () => {
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);
    // Screen 1 видим, screens 2/3 — нет.
    expect(screen.getByTestId("welcome-tour-screen-1")).toBeVisible();
    expect(screen.getByTestId("welcome-tour-screen-2")).not.toBeVisible();
    expect(screen.getByTestId("welcome-tour-screen-3")).not.toBeVisible();
  });

  it("clicking «Далее» on S1 advances to Screen 2 (visibility, not DOM)", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-next"));

    expect(screen.getByTestId("welcome-tour-screen-1")).not.toBeVisible();
    expect(screen.getByTestId("welcome-tour-screen-2")).toBeVisible();
    expect(screen.getByTestId("welcome-tour-screen-3")).not.toBeVisible();
  });

  it("clicking «Назад» on S2 returns to Screen 1", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-next")); // → S2
    expect(screen.getByTestId("welcome-tour-screen-2")).toBeVisible();

    await user.click(screen.getByTestId("welcome-tour-back"));
    expect(screen.getByTestId("welcome-tour-screen-1")).toBeVisible();
    expect(screen.getByTestId("welcome-tour-screen-2")).not.toBeVisible();
  });

  it("Screen 3 показывается после двух «Далее» с кнопкой «Начать» вместо «Далее»", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-next")); // → S2
    await user.click(screen.getByTestId("welcome-tour-next")); // → S3

    expect(screen.getByTestId("welcome-tour-screen-3")).toBeVisible();
    expect(screen.getByTestId("welcome-tour-start")).toBeInTheDocument();
    expect(screen.queryByTestId("welcome-tour-next")).not.toBeInTheDocument();
  });

  it("clicking «Пропустить» on S1 calls onComplete + пишет tt_welcome_completed = \"true\"", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-skip"));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("tt_welcome_completed")).toBe("true");
  });

  it("clicking «Пропустить» on S2 also completes", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-next")); // → S2
    await user.click(screen.getByTestId("welcome-tour-skip"));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("tt_welcome_completed")).toBe("true");
  });

  it("clicking «Начать» on S3 completes (same as Skip)", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-next")); // → S2
    await user.click(screen.getByTestId("welcome-tour-next")); // → S3
    await user.click(screen.getByTestId("welcome-tour-start"));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("tt_welcome_completed")).toBe("true");
  });

  it("WelcomeDotIndicator: active dot matches currentStep, aria-label дина��ичен", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    // S1 — dot 0 активен, aria-label="Шаг 1 из 3"
    let indicator = screen.getByTestId("welcome-dot-indicator");
    expect(indicator).toHaveAttribute("aria-label", "Шаг 1 из 3");
    expect(screen.getByTestId("welcome-dot-0")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("welcome-dot-1")).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("welcome-dot-2")).toHaveAttribute("data-active", "false");

    await user.click(screen.getByTestId("welcome-tour-next")); // → S2
    indicator = screen.getByTestId("welcome-dot-indicator");
    expect(indicator).toHaveAttribute("aria-label", "Шаг 2 из 3");
    expect(screen.getByTestId("welcome-dot-1")).toHaveAttribute("data-active", "true");

    await user.click(screen.getByTestId("welcome-tour-next")); // → S3
    indicator = screen.getByTestId("welcome-dot-indicator");
    expect(indicator).toHaveAttribute("aria-label", "Шаг 3 из 3");
    expect(screen.getByTestId("welcome-dot-2")).toHaveAttribute("data-active", "true");
  });

  it("Escape key does NOT close overlay (D-DECISION-UI-1.2)", () => {
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });

    expect(onComplete).not.toHaveBeenCalled();
    expect(localStorage.getItem("tt_welcome_completed")).toBeNull();
    // Overlay по-прежнему отрисован.
    expect(screen.getByTestId("welcome-tour-overlay")).toBeInTheDocument();
  });

  it("overlay имеет правильные ARIA атрибуты (role=dialog aria-modal aria-labelledby)", () => {
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    const overlay = screen.getByTestId("welcome-tour-overlay");
    expect(overlay).toHaveAttribute("role", "dialog");
    expect(overlay).toHaveAttribute("aria-modal", "true");
    expect(overlay).toHaveAttribute("aria-labelledby", "welcome-heading");
  });

  it("Screen 1 на русском: heading и description рендерятся из ru.json", () => {
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    expect(
      screen.getByRole("heading", { level: 1, name: /Добро пожаловать/i }),
    ).toBeVisible();
    expect(screen.getByText(/Свой VPN-сервер за пару минут/i)).toBeVisible();
  });

  it("Screen 2 на русском показывает 3-block diagram labels", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-next")); // → S2

    expect(screen.getByText("Ваш ПК")).toBeVisible();
    expect(screen.getByText("Ваш VPS")).toBeVisible();
    expect(screen.getByText("Интернет")).toBeVisible();
    expect(screen.getByText("по шифрованному каналу")).toBeVisible();
    expect(screen.getByText("защищённый выход")).toBeVisible();
  });

  it("WithEnglishLocale: i18n.changeLanguage('en') рендерит английский heading", async () => {
    await i18n.changeLanguage("en");
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    expect(
      screen.getByRole("heading", { level: 1, name: /Welcome to TrustTunnel/i }),
    ).toBeVisible();
  });
});
