import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../shared/i18n";
import StatusPanel from "./StatusPanel";
import type { VpnStatus } from "../shared/types";

describe("StatusPanel", () => {
  const defaultProps = {
    status: "disconnected" as VpnStatus,
    error: null,
    connectedSince: null,
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders disconnected state with connect button", () => {
    render(<StatusPanel {...defaultProps} />);
    expect(screen.getByText("Отключен")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Подключить/ })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: /Отключить/ })).toBeInTheDocument();
  });

  it("renders connecting state with cancel button", () => {
    render(<StatusPanel {...defaultProps} status="connecting" />);
    // Status label appears in badge only; button shows "Cancel"
    expect(screen.getByText("Подключение")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: /Отмена/ });
    expect(btn).toBeEnabled();
  });

  it("renders disconnecting state with disabled button", () => {
    render(<StatusPanel {...defaultProps} status="disconnecting" />);
    const texts = screen.getAllByText("Отключение");
    expect(texts.length).toBe(2);
    const btn = screen.getByRole("button", { name: /Отключение/ });
    expect(btn).toBeDisabled();
  });

  it("renders recovering state with disabled button", () => {
    render(<StatusPanel {...defaultProps} status="recovering" />);
    const texts = screen.getAllByText("Восстановление");
    expect(texts.length).toBe(2);
    const btn = screen.getByRole("button", { name: /Восстановление/ });
    expect(btn).toBeDisabled();
  });

  it("renders error state with error message", () => {
    render(
      <StatusPanel {...defaultProps} status="error" error="Test error message" />
    );
    expect(screen.getByText("Ошибка")).toBeInTheDocument();
    expect(screen.getByText("Test error message")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Подключить/ })).toBeInTheDocument();
  });

  it("calls onConnect when connect button clicked", () => {
    render(<StatusPanel {...defaultProps} />);
    fireEvent.click(screen.getByRole("button", { name: /Подключить/ }));
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
    fireEvent.click(screen.getByRole("button", { name: /Отключить/ }));
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
    expect(screen.getByText(/01:01:0/)).toBeInTheDocument();
  });

  it("does not show uptime when disconnected", () => {
    render(<StatusPanel {...defaultProps} />);
    expect(screen.queryByText(/\d{2}:\d{2}:\d{2}/)).not.toBeInTheDocument();
  });
});
