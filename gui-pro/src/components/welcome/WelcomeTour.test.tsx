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
    expect(screen.getByTestId("welcome-tour-screen-1").parentElement).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByTestId("welcome-tour-screen-2").parentElement).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("welcome-tour-screen-3").parentElement).toHaveAttribute("aria-hidden", "true");
  });

  it("S1 показывает только правую стрелочку (нет левой)", () => {
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);
    expect(screen.queryByTestId("welcome-tour-arrow-left")).not.toBeInTheDocument();
    expect(screen.getByTestId("welcome-tour-arrow-right")).toBeInTheDocument();
  });

  it("clicking правая стрелочка на S1 → S2", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-arrow-right"));

    expect(screen.getByTestId("welcome-tour-screen-1").parentElement).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("welcome-tour-screen-2").parentElement).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByTestId("welcome-tour-screen-3").parentElement).toHaveAttribute("aria-hidden", "true");
  });

  it("S2 показывает обе стрелочки (back + next)", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-arrow-right")); // → S2
    expect(screen.getByTestId("welcome-tour-arrow-left")).toBeInTheDocument();
    expect(screen.getByTestId("welcome-tour-arrow-right")).toBeInTheDocument();
  });

  it("clicking левая стрелочка на S2 → S1", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-arrow-right")); // → S2
    expect(screen.getByTestId("welcome-tour-screen-2").parentElement).toHaveAttribute("aria-hidden", "false");

    await user.click(screen.getByTestId("welcome-tour-arrow-left"));
    expect(screen.getByTestId("welcome-tour-screen-1").parentElement).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByTestId("welcome-tour-screen-2").parentElement).toHaveAttribute("aria-hidden", "true");
  });

  it("S3 показывает только левую стрелочку + кнопку «Начать» внутри слайда", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-arrow-right")); // → S2
    await user.click(screen.getByTestId("welcome-tour-arrow-right")); // → S3

    expect(screen.getByTestId("welcome-tour-screen-3").parentElement).toHaveAttribute("aria-hidden", "false");
    expect(screen.getByTestId("welcome-tour-arrow-left")).toBeInTheDocument();
    expect(screen.queryByTestId("welcome-tour-arrow-right")).not.toBeInTheDocument();
    expect(screen.getByTestId("welcome-tour-start")).toBeInTheDocument();
  });

  it("X corner close на S1 calls onComplete('skip') + пишет tt_welcome_completed", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-close"));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("skip");
    expect(localStorage.getItem("tt_welcome_completed")).toBe("true");
  });

  it("X corner close на S2 тоже completes с intent='skip'", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-arrow-right")); // → S2
    await user.click(screen.getByTestId("welcome-tour-close"));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("skip");
    expect(localStorage.getItem("tt_welcome_completed")).toBe("true");
  });

  it("clicking «Начать» на S3 completes с intent='start' (navigate signal)", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-arrow-right")); // → S2
    await user.click(screen.getByTestId("welcome-tour-arrow-right")); // → S3
    await user.click(screen.getByTestId("welcome-tour-start"));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith("start");
    expect(localStorage.getItem("tt_welcome_completed")).toBe("true");
  });

  it("WelcomeDotIndicator: active dot matches currentStep, aria-label динамичен", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    let indicator = screen.getByTestId("welcome-dot-indicator");
    expect(indicator).toHaveAttribute("aria-label", "Шаг 1 из 3");
    expect(screen.getByTestId("welcome-dot-0")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("welcome-dot-1")).toHaveAttribute("data-active", "false");
    expect(screen.getByTestId("welcome-dot-2")).toHaveAttribute("data-active", "false");

    await user.click(screen.getByTestId("welcome-tour-arrow-right")); // → S2
    indicator = screen.getByTestId("welcome-dot-indicator");
    expect(indicator).toHaveAttribute("aria-label", "Шаг 2 из 3");
    expect(screen.getByTestId("welcome-dot-1")).toHaveAttribute("data-active", "true");

    await user.click(screen.getByTestId("welcome-tour-arrow-right")); // → S3
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
      screen.getByRole("heading", { level: 1, name: /Добро пожаловать в.*Trust.*Tunnel/i }),
    ).toBeVisible();
    expect(screen.getByText(/Свой VPN-сервер за пару минут/i)).toBeVisible();
  });

  it("Screen 1: heading имеет PRO badge", () => {
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    expect(screen.getByText("PRO")).toBeVisible();
  });

  it("Screen 2 на русском показывает 3-block diagram labels", async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    await user.click(screen.getByTestId("welcome-tour-arrow-right")); // → S2

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
      screen.getByRole("heading", { level: 1, name: /Welcome to.*Trust.*Tunnel/i }),
    ).toBeVisible();
  });

  it("overlay начинается с top: 32px (TitleBar видим)", () => {
    const onComplete = vi.fn();
    render(<WelcomeTour onComplete={onComplete} />);

    const overlay = screen.getByTestId("welcome-tour-overlay");
    expect(overlay).toHaveStyle({ top: "32px" });
  });
});
