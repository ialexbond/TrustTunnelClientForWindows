import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "../../src/test/tauri-mock";
import StatusPanel from "./StatusPanel";
import type { VpnStatus } from "../App";

describe("StatusPanel", () => {
  const defaultProps = {
    status: "disconnected" as VpnStatus,
    error: null,
    connectedSince: null,
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    configPath: "/test/config.toml",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders disconnected state with connect button", () => {
    render(<StatusPanel {...defaultProps} />);
    expect(screen.getByText("Отключен")).toBeInTheDocument();
    expect(screen.getByText("Подключить")).toBeInTheDocument();
  });

  it("renders connected state with disconnect button", () => {
    render(
      <StatusPanel
        {...defaultProps}
        status="connected"
        connectedSince={new Date()}
      />
    );
    expect(screen.getByText("Подключен")).toBeInTheDocument();
    expect(screen.getByText("Отключить")).toBeInTheDocument();
  });

  it("renders connecting state with disabled button", () => {
    render(<StatusPanel {...defaultProps} status="connecting" />);
    const btns = screen.getAllByText("Подключение...");
    expect(btns.length).toBeGreaterThanOrEqual(1);
    const btn = screen.getByRole("button", { name: "Подключение..." });
    expect(btn).toBeDisabled();
  });

  it("renders disconnecting state with disabled button", () => {
    render(<StatusPanel {...defaultProps} status="disconnecting" />);
    const texts = screen.getAllByText("Отключение...");
    expect(texts.length).toBeGreaterThanOrEqual(1);
    const btn = screen.getByRole("button", { name: "Отключение..." });
    expect(btn).toBeDisabled();
  });

  it("renders recovering state with disabled button", () => {
    render(<StatusPanel {...defaultProps} status="recovering" />);
    expect(screen.getByText("Ожидание сети...")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Переподключение..." });
    expect(btn).toBeDisabled();
  });

  it("renders error state with error message", () => {
    render(
      <StatusPanel {...defaultProps} status="error" error="Test error message" />
    );
    expect(screen.getByText("Ошибка")).toBeInTheDocument();
    expect(screen.getByText("Test error message")).toBeInTheDocument();
    expect(screen.getByText("Подключить")).toBeInTheDocument();
  });

  it("calls onConnect when connect button clicked", () => {
    render(<StatusPanel {...defaultProps} />);
    fireEvent.click(screen.getByText("Подключить"));
    expect(defaultProps.onConnect).toHaveBeenCalledOnce();
  });

  it("calls onDisconnect when disconnect button clicked", () => {
    render(
      <StatusPanel
        {...defaultProps}
        status="connected"
        connectedSince={new Date()}
      />
    );
    fireEvent.click(screen.getByText("Отключить"));
    expect(defaultProps.onDisconnect).toHaveBeenCalledOnce();
  });

  it("shows uptime counter when connected", () => {
    render(
      <StatusPanel
        {...defaultProps}
        status="connected"
        connectedSince={new Date(Date.now() - 3661000)} // 1h 1m 1s ago
      />
    );
    // Uptime should be approximately 01:01:01
    expect(screen.getByText(/01:01:0/)).toBeInTheDocument();
  });

  it("does not show uptime when disconnected", () => {
    render(<StatusPanel {...defaultProps} />);
    expect(screen.queryByText(/\d{2}:\d{2}:\d{2}/)).not.toBeInTheDocument();
  });
});
