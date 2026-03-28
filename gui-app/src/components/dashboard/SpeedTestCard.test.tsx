import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { SpeedTestCard } from "./SpeedTestCard";
import type { SpeedResult } from "./useDashboardState";

describe("SpeedTestCard", () => {
  const defaultProps = {
    speed: null,
    testing: false,
    error: null,
    onRunTest: vi.fn(),
    isConnected: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders speed test card title", () => {
    render(<SpeedTestCard {...defaultProps} />);
    expect(screen.getByText("Тест скорости")).toBeInTheDocument();
  });

  it("renders test button", () => {
    render(<SpeedTestCard {...defaultProps} />);
    expect(screen.getByText("Тест")).toBeInTheDocument();
  });

  it("shows prompt to run speed test when connected and no results", () => {
    render(<SpeedTestCard {...defaultProps} />);
    expect(screen.getByText("Запустите тест скорости")).toBeInTheDocument();
  });

  it("shows no data message when disconnected", () => {
    render(<SpeedTestCard {...defaultProps} isConnected={false} />);
    expect(screen.getByText("Нет данных")).toBeInTheDocument();
  });

  it("disables test button when disconnected", () => {
    render(<SpeedTestCard {...defaultProps} isConnected={false} />);
    const btn = screen.getByText("Тест").closest("button");
    expect(btn).toBeDisabled();
  });

  it("disables test button during testing", () => {
    render(<SpeedTestCard {...defaultProps} testing={true} />);
    const btn = screen.getByText("Тест").closest("button");
    expect(btn).toBeDisabled();
  });

  it("calls onRunTest when button clicked", () => {
    const onRunTest = vi.fn();
    render(<SpeedTestCard {...defaultProps} onRunTest={onRunTest} />);
    fireEvent.click(screen.getByText("Тест"));
    expect(onRunTest).toHaveBeenCalledOnce();
  });

  it("shows download and upload results when speed data available", () => {
    const speed: SpeedResult = {
      download_mbps: 95.3,
      upload_mbps: 48.7,
      timestamp: Date.now(),
    };
    render(<SpeedTestCard {...defaultProps} speed={speed} />);
    expect(screen.getByText("Download")).toBeInTheDocument();
    expect(screen.getByText("Upload")).toBeInTheDocument();
    expect(screen.getByText(/95\.3/)).toBeInTheDocument();
    expect(screen.getByText(/48\.7/)).toBeInTheDocument();
  });

  it("shows error state when error and not testing", () => {
    render(
      <SpeedTestCard
        {...defaultProps}
        error="connection timeout"
        speed={null}
      />
    );
    expect(screen.getByText("Не удалось выполнить тест. Попробуйте позже.")).toBeInTheDocument();
  });

  it("does not show error while testing", () => {
    render(
      <SpeedTestCard
        {...defaultProps}
        error="connection timeout"
        testing={true}
      />
    );
    expect(screen.queryByText("Не удалось выполнить тест. Попробуйте позже.")).not.toBeInTheDocument();
  });
});
