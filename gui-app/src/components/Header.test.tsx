import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "../../src/test/tauri-mock";
import Header from "./Header";
import type { AppTab, VpnStatus } from "../App";

describe("Header", () => {
  const defaultProps = {
    activeTab: "setup" as AppTab,
    onTabChange: vi.fn(),
    hasConfig: true,
    vpnStatus: "disconnected" as VpnStatus,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders app title", () => {
    render(<Header {...defaultProps} />);
    expect(screen.getByText("TrustTunnel")).toBeInTheDocument();
    expect(screen.getByText("VPN Client")).toBeInTheDocument();
  });

  it("renders all navigation tabs", () => {
    render(<Header {...defaultProps} />);
    expect(screen.getByText("Установка VPN")).toBeInTheDocument();
    expect(screen.getByText("Настройки")).toBeInTheDocument();
    expect(screen.getByText("Маршрутизация")).toBeInTheDocument();
    expect(screen.getByText("О программе")).toBeInTheDocument();
  });

  it("highlights active tab", () => {
    render(<Header {...defaultProps} activeTab="settings" />);
    const settingsBtn = screen.getByText("Настройки").closest("button");
    expect(settingsBtn?.className).toContain("bg-white/10");
  });

  it("disables settings/routing tabs when no config", () => {
    render(<Header {...defaultProps} hasConfig={false} />);
    const settingsBtn = screen.getByText("Настройки").closest("button");
    expect(settingsBtn?.className).toContain("cursor-not-allowed");
  });

  it("settings tab clickable when config exists", () => {
    render(<Header {...defaultProps} hasConfig={true} />);
    fireEvent.click(screen.getByText("Настройки"));
    expect(defaultProps.onTabChange).toHaveBeenCalledWith("settings");
  });

  it("settings tab not clickable when no config", () => {
    render(<Header {...defaultProps} hasConfig={false} />);
    fireEvent.click(screen.getByText("Настройки"));
    expect(defaultProps.onTabChange).not.toHaveBeenCalled();
  });

  it("shows update button when update available", () => {
    render(
      <Header
        {...defaultProps}
        updateInfo={{
          available: true,
          latestVersion: "2.0.0",
          currentVersion: "1.5.0",
          downloadUrl: "https://example.com",
          releaseNotes: "",
          checking: false,
        }}
        onOpenDownload={vi.fn()}
      />
    );
    expect(screen.getByText("v2.0.0")).toBeInTheDocument();
  });

  it("shows VPN status dot when connected", () => {
    const { container } = render(
      <Header {...defaultProps} vpnStatus="connected" />
    );
    const dot = container.querySelector(".bg-emerald-400");
    expect(dot).toBeInTheDocument();
  });

  it("does not show status dot when disconnected", () => {
    const { container } = render(
      <Header {...defaultProps} vpnStatus="disconnected" />
    );
    const dot = container.querySelector(".bg-emerald-400");
    expect(dot).not.toBeInTheDocument();
  });
});
