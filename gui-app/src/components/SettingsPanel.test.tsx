import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "../../src/test/tauri-mock";
import { invoke } from "@tauri-apps/api/core";
import SettingsPanel from "./SettingsPanel";
import type { VpnStatus } from "../App";

const mockConfig = {
  loglevel: "info",
  vpn_mode: "tun",
  killswitch_enabled: false,
  post_quantum_group_enabled: true,
  endpoint: {
    hostname: "example.com:443",
    addresses: ["1.2.3.4"],
    upstream_protocol: "https",
    anti_dpi: false,
    skip_verification: false,
    custom_sni: "",
    has_ipv6: false,
    username: "user",
    password: "pass",
  },
  listener: {
    tun: {
      mtu_size: 1280,
      change_system_dns: true,
      included_routes: ["0.0.0.0/0"],
      excluded_routes: [],
    },
  },
  dns_upstreams: ["1.1.1.1"],
};

describe("SettingsPanel", () => {
  const defaultProps = {
    configPath: "/test/config.toml",
    onConfigChange: vi.fn(),
    status: "disconnected" as VpnStatus,
    onReconnect: vi.fn().mockResolvedValue(undefined),
    onSwitchToSetup: vi.fn(),
    onClearConfig: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "read_client_config") return mockConfig;
      return null;
    });
  });

  it("renders settings header", async () => {
    render(<SettingsPanel {...defaultProps} />);
    expect(screen.getByText("Настройки")).toBeInTheDocument();
  });

  it("renders config file path input", () => {
    render(<SettingsPanel {...defaultProps} />);
    expect(screen.getByText("Файл конфигурации")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("trusttunnel_client.toml")).toBeInTheDocument();
  });

  it("loads and displays config fields", async () => {
    render(<SettingsPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Подключение")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Kill Switch")).toBeInTheDocument();
    });
  });

  it("shows toggle labels for security features", async () => {
    render(<SettingsPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Post-Quantum")).toBeInTheDocument();
    });
    expect(screen.getByText("Anti-DPI")).toBeInTheDocument();
  });

  it("does NOT show System DNS toggle (hidden, always forced on)", async () => {
    render(<SettingsPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Kill Switch")).toBeInTheDocument();
    });
    expect(screen.queryByText("Системный DNS")).not.toBeInTheDocument();
  });

  it("shows save button", async () => {
    render(<SettingsPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Настройки сохранены")).toBeInTheDocument();
    });
  });
});
