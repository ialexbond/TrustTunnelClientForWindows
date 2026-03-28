import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { ConnectionSection } from "./ConnectionSection";
import type { SettingsState } from "./useSettingsState";

function makeState(overrides: Partial<SettingsState> = {}): SettingsState {
  return {
    config: {
      loglevel: "info",
      vpn_mode: "tun",
      killswitch_enabled: false,
      post_quantum_group_enabled: true,
      endpoint: {
        hostname: "vpn.example.com:443",
        addresses: ["1.2.3.4"],
        upstream_protocol: "http2",
        anti_dpi: false,
        skip_verification: false,
        custom_sni: "",
        has_ipv6: false,
        username: "testuser",
        password: "testpass",
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
    },
    saving: false,
    error: "",
    localPath: "/test/config.toml",
    dirty: false,
    status: "disconnected",
    successQueue: [],
    setLocalPath: vi.fn(),
    setError: vi.fn(),
    updateField: vi.fn(),
    handleSave: vi.fn().mockResolvedValue(undefined),
    browseConfig: vi.fn().mockResolvedValue(undefined),
    clearConfig: vi.fn(),
    pushSuccess: vi.fn(),
    shiftSuccess: vi.fn(),
    ...overrides,
  };
}

describe("ConnectionSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders connection section title", () => {
    render(<ConnectionSection state={makeState()} />);
    expect(screen.getByText("Подключение")).toBeInTheDocument();
  });

  it("renders config file label", () => {
    render(<ConnectionSection state={makeState()} />);
    expect(screen.getByText("Файл конфигурации")).toBeInTheDocument();
  });

  it("shows the config file path in input", () => {
    render(<ConnectionSection state={makeState()} />);
    const input = screen.getByDisplayValue("/test/config.toml");
    expect(input).toBeInTheDocument();
  });

  it("renders host, username, password fields when config exists", () => {
    render(<ConnectionSection state={makeState()} />);
    expect(screen.getByText("Доменное имя")).toBeInTheDocument();
    expect(screen.getByText("Имя пользователя")).toBeInTheDocument();
    expect(screen.getByText("Пароль")).toBeInTheDocument();
  });

  it("shows endpoint hostname value", () => {
    render(<ConnectionSection state={makeState()} />);
    expect(screen.getByDisplayValue("vpn.example.com:443")).toBeInTheDocument();
  });

  it("shows endpoint username value", () => {
    render(<ConnectionSection state={makeState()} />);
    expect(screen.getByDisplayValue("testuser")).toBeInTheDocument();
  });

  it("does not render host/username/password when config is null", () => {
    render(<ConnectionSection state={makeState({ config: null })} />);
    expect(screen.queryByText("Доменное имя")).not.toBeInTheDocument();
  });
});
