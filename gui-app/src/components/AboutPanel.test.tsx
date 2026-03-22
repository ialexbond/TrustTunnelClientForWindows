import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "../../src/test/tauri-mock";
import AboutPanel from "./AboutPanel";

describe("AboutPanel", () => {
  const defaultProps = {
    updateInfo: {
      available: false,
      latestVersion: "1.5.0",
      currentVersion: "1.5.0",
      downloadUrl: "",
      releaseNotes: "",
      checking: false,
    },
    onCheckUpdates: vi.fn(),
    onOpenDownload: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders app name and version", () => {
    render(<AboutPanel {...defaultProps} />);
    expect(screen.getByText("TrustTunnel Client for Windows")).toBeInTheDocument();
    expect(screen.getByText("v1.5.0")).toBeInTheDocument();
  });

  it("renders about description", () => {
    render(<AboutPanel {...defaultProps} />);
    expect(screen.getByText("О программе")).toBeInTheDocument();
  });

  it("shows 'up to date' when no update available", () => {
    render(<AboutPanel {...defaultProps} />);
    expect(screen.getByText("У вас установлена актуальная версия")).toBeInTheDocument();
  });

  it("shows update available with version", () => {
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{
          ...defaultProps.updateInfo,
          available: true,
          latestVersion: "2.0.0",
          downloadUrl: "https://example.com/update.zip",
        }}
      />
    );
    expect(screen.getByText("Доступна версия 2.0.0")).toBeInTheDocument();
    expect(screen.getByText("Обновить автоматически")).toBeInTheDocument();
  });

  it("shows checking state on check button", () => {
    render(
      <AboutPanel
        {...defaultProps}
        updateInfo={{ ...defaultProps.updateInfo, checking: true }}
      />
    );
    expect(screen.getByText("Проверка...")).toBeInTheDocument();
  });

  it("calls onCheckUpdates when check button clicked", () => {
    render(<AboutPanel {...defaultProps} />);
    fireEvent.click(screen.getByText("Проверить обновления"));
    expect(defaultProps.onCheckUpdates).toHaveBeenCalledOnce();
  });

  it("renders GitHub link", () => {
    render(<AboutPanel {...defaultProps} />);
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("renders vibe-coding mention", () => {
    render(<AboutPanel {...defaultProps} />);
    expect(screen.getByText("вайб-кодинга")).toBeInTheDocument();
  });
});
