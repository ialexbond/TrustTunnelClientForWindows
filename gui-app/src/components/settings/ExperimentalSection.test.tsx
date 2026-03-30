import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { ExperimentalSection } from "./ExperimentalSection";

// Mock useFeatureToggles
const mockUpdate = vi.fn();
vi.mock("../../shared/hooks/useFeatureToggles", () => ({
  useFeatureToggles: () => ({
    toggles: { blockRouting: false, processFilter: false },
    update: mockUpdate,
  }),
}));

describe("ExperimentalSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders experimental section title", () => {
    render(<ExperimentalSection />);
    expect(screen.getByText("Экспериментальные функции")).toBeInTheDocument();
  });

  it("renders description text", () => {
    render(<ExperimentalSection />);
    expect(screen.getByText("Функции в разработке. Могут быть нестабильны.")).toBeInTheDocument();
  });

  it("renders block routing toggle", () => {
    render(<ExperimentalSection />);
    expect(screen.getByText("Блокировка сайтов")).toBeInTheDocument();
  });

  it("renders process filter toggle", () => {
    render(<ExperimentalSection />);
    expect(screen.getByText("Фильтрация по процессам")).toBeInTheDocument();
  });

  it("calls update when block routing toggle is clicked", () => {
    render(<ExperimentalSection />);
    const toggleButtons = screen.getAllByRole("button");
    // Find the toggle button for blockRouting (first toggle)
    fireEvent.click(toggleButtons[0]);
    expect(mockUpdate).toHaveBeenCalledWith("blockRouting", true);
  });

  it("calls update when process filter toggle is clicked", () => {
    render(<ExperimentalSection />);
    const toggleButtons = screen.getAllByRole("button");
    // Second toggle is processFilter
    fireEvent.click(toggleButtons[1]);
    expect(mockUpdate).toHaveBeenCalledWith("processFilter", true);
  });
});
