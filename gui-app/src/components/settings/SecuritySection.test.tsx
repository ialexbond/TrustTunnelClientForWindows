import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { SecuritySection } from "./SecuritySection";
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

describe("SecuritySection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders security section title", () => {
    render(<SecuritySection state={makeState()} />);
    expect(screen.getByText("Безопасность")).toBeInTheDocument();
  });

  it("renders kill switch toggle", () => {
    render(<SecuritySection state={makeState()} />);
    expect(screen.getByText("Kill Switch")).toBeInTheDocument();
    expect(screen.getByText("Блокировать интернет при обрыве VPN")).toBeInTheDocument();
  });

  it("renders anti-DPI toggle", () => {
    render(<SecuritySection state={makeState()} />);
    expect(screen.getByText("Anti-DPI")).toBeInTheDocument();
    expect(screen.getByText("Обход блокировок DPI")).toBeInTheDocument();
  });

  it("renders post-quantum toggle", () => {
    render(<SecuritySection state={makeState()} />);
    expect(screen.getByText("Post-Quantum")).toBeInTheDocument();
    expect(screen.getByText("Постквантовая криптография")).toBeInTheDocument();
  });

  it("calls updateField when kill switch toggle is clicked", () => {
    const state = makeState();
    render(<SecuritySection state={state} />);
    const toggleButtons = screen.getAllByRole("button");
    fireEvent.click(toggleButtons[0]);
    expect(state.updateField).toHaveBeenCalledWith("killswitch_enabled", true);
  });

  it("calls updateField when anti-DPI toggle is clicked", () => {
    const state = makeState();
    render(<SecuritySection state={state} />);
    const toggleButtons = screen.getAllByRole("button");
    fireEvent.click(toggleButtons[1]);
    expect(state.updateField).toHaveBeenCalledWith("endpoint.anti_dpi", true);
  });

  it("calls updateField when post-quantum toggle is clicked", () => {
    const state = makeState();
    render(<SecuritySection state={state} />);
    const toggleButtons = screen.getAllByRole("button");
    fireEvent.click(toggleButtons[2]);
    expect(state.updateField).toHaveBeenCalledWith("post_quantum_group_enabled", false);
  });

  it("returns null when config is null", () => {
    const { container } = render(<SecuritySection state={makeState({ config: null })} />);
    expect(container.innerHTML).toBe("");
  });
});
