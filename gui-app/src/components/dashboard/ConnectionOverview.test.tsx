import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { ConnectionOverview } from "./ConnectionOverview";
import type { VpnStatus } from "../../App";
import type { ClientConfig } from "../settings/useSettingsState";

describe("ConnectionOverview", () => {
  const mockConfig: ClientConfig = {
    endpoint: {
      upstream_protocol: "quic",
      anti_dpi: false,
      has_ipv6: false,
    },
    listener: { tun: { mtu_size: 1280 } },
    killswitch_enabled: false,
    post_quantum_group_enabled: false,
    dns_upstreams: [],
  } as unknown as ClientConfig;

  const defaultProps = {
    status: "disconnected" as VpnStatus,
    connectedSince: null,
    currentPing: null,
    clientConfig: mockConfig,
    vpnMode: "general",
    isLoading: false,
    onDisconnect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders disconnected state with status badge", () => {
    render(<ConnectionOverview {...defaultProps} />);
    expect(screen.getByText("Отключен")).toBeInTheDocument();
  });

  it("does not show disconnect button when disconnected", () => {
    render(<ConnectionOverview {...defaultProps} />);
    expect(screen.queryByText("Отключить")).not.toBeInTheDocument();
  });

  it("renders connected state with disconnect button", () => {
    render(
      <ConnectionOverview
        {...defaultProps}
        status="connected"
        connectedSince={new Date()}
      />
    );
    expect(screen.getByText("Подключен")).toBeInTheDocument();
    expect(screen.getByText("Отключить")).toBeInTheDocument();
  });

  it("shows protocol from config", () => {
    render(<ConnectionOverview {...defaultProps} />);
    expect(screen.getByText("QUIC")).toBeInTheDocument();
  });

  it("shows VPN mode label", () => {
    render(<ConnectionOverview {...defaultProps} vpnMode="general" />);
    expect(screen.getByText("Всё через VPN")).toBeInTheDocument();
  });

  it("shows selective mode label", () => {
    render(<ConnectionOverview {...defaultProps} vpnMode="selective" />);
    expect(screen.getByText("Напрямую")).toBeInTheDocument();
  });

  it("shows ping when connected", () => {
    render(
      <ConnectionOverview
        {...defaultProps}
        status="connected"
        connectedSince={new Date()}
        currentPing={42}
      />
    );
    expect(screen.getByText("42 ms")).toBeInTheDocument();
  });

  it("shows dash for negative ping", () => {
    render(
      <ConnectionOverview
        {...defaultProps}
        status="connected"
        connectedSince={new Date()}
        currentPing={-1}
      />
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("calls onDisconnect when disconnect button clicked", () => {
    const onDisconnect = vi.fn();
    render(
      <ConnectionOverview
        {...defaultProps}
        status="connected"
        connectedSince={new Date()}
        onDisconnect={onDisconnect}
      />
    );
    fireEvent.click(screen.getByText("Отключить"));
    expect(onDisconnect).toHaveBeenCalledOnce();
  });

  it("shows loading state with disabled button", () => {
    render(
      <ConnectionOverview
        {...defaultProps}
        status="connecting"
        isLoading={true}
      />
    );
    const allMatches = screen.getAllByText("Подключение");
    expect(allMatches.length).toBe(2); // badge + button
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
  });

  it("shows dash for protocol when no config", () => {
    render(<ConnectionOverview {...defaultProps} clientConfig={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
