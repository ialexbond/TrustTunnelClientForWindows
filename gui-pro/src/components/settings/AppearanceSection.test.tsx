import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { AppearanceSection } from "./AppearanceSection";

describe("AppearanceSection", () => {
  const defaultProps = {
    theme: "system" as const,
    onThemeChange: vi.fn(),
    language: "ru",
    onLanguageChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders appearance title", () => {
    render(<AppearanceSection {...defaultProps} />);
    expect(screen.getByText("Оформление")).toBeInTheDocument();
  });

  it("renders theme selector with label", () => {
    render(<AppearanceSection {...defaultProps} />);
    expect(screen.getByText("Тема оформления")).toBeInTheDocument();
  });

  it("renders language selector with label", () => {
    render(<AppearanceSection {...defaultProps} />);
    expect(screen.getByText("Язык интерфейса")).toBeInTheDocument();
  });

  it("shows selected theme option (Системная)", () => {
    render(<AppearanceSection {...defaultProps} />);
    expect(screen.getByText("Системная")).toBeInTheDocument();
  });

  it("shows language options", () => {
    render(<AppearanceSection {...defaultProps} />);
    expect(screen.getByText("Русский")).toBeInTheDocument();
  });

  it("calls onThemeChange when a different theme is selected", () => {
    render(<AppearanceSection {...defaultProps} />);
    // Open the theme dropdown
    fireEvent.click(screen.getByText("Системная"));
    // Select dark theme
    fireEvent.click(screen.getByText("Тёмная"));
    expect(defaultProps.onThemeChange).toHaveBeenCalledWith("dark");
  });

  it("calls onLanguageChange when a different language is selected", () => {
    render(<AppearanceSection {...defaultProps} />);
    // Open the language dropdown
    fireEvent.click(screen.getByText("Русский"));
    // Select English
    fireEvent.click(screen.getByText("English"));
    expect(defaultProps.onLanguageChange).toHaveBeenCalledWith("en");
  });
});
