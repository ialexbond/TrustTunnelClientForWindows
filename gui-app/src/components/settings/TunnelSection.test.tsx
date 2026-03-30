import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { TunnelSection } from "./TunnelSection";
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

describe("TunnelSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders tunnel section title", () => {
    render(<TunnelSection state={makeState()} />);
    expect(screen.getByText("Туннель")).toBeInTheDocument();
  });

  it("renders protocol label", () => {
    render(<TunnelSection state={makeState()} />);
    expect(screen.getByText("Протокол")).toBeInTheDocument();
  });

  it("renders HTTP/2 and HTTP/3 protocol buttons", () => {
    render(<TunnelSection state={makeState()} />);
    expect(screen.getByText("HTTP/2")).toBeInTheDocument();
    expect(screen.getByText("HTTP/3")).toBeInTheDocument();
  });

  it("renders MTU label", () => {
    render(<TunnelSection state={makeState()} />);
    expect(screen.getByText("MTU")).toBeInTheDocument();
  });

  it("shows current MTU value", () => {
    render(<TunnelSection state={makeState()} />);
    expect(screen.getByDisplayValue("1280")).toBeInTheDocument();
  });

  it("calls updateField when HTTP/3 button is clicked", () => {
    const state = makeState();
    render(<TunnelSection state={state} />);
    fireEvent.click(screen.getByText("HTTP/3"));
    expect(state.updateField).toHaveBeenCalledWith("endpoint.upstream_protocol", "http3");
  });

  it("calls updateField when MTU plus button is clicked", () => {
    const state = makeState();
    render(<TunnelSection state={state} />);
    // Plus button is the last button in the MTU control
    const buttons = screen.getAllByRole("button");
    // Find the MTU +/- buttons (they contain Minus and Plus icons)
    // The minus button and plus button are the last two non-protocol buttons
    const mtuPlusButton = buttons[buttons.length - 1];
    fireEvent.click(mtuPlusButton);
    expect(state.updateField).toHaveBeenCalledWith("listener.tun.mtu_size", 1290);
  });

  it("returns null when config is null", () => {
    const { container } = render(<TunnelSection state={makeState({ config: null })} />);
    expect(container.innerHTML).toBe("");
  });

  it("calls updateField when HTTP/2 button is clicked", () => {
    const state = makeState();
    render(<TunnelSection state={state} />);
    fireEvent.click(screen.getByText("HTTP/2"));
    expect(state.updateField).toHaveBeenCalledWith("endpoint.upstream_protocol", "http2");
  });

  it("calls updateField when MTU minus button is clicked", () => {
    const state = makeState();
    render(<TunnelSection state={state} />);
    const buttons = screen.getAllByRole("button");
    // Minus button is the first non-protocol button
    // TUN/SOCKS5 buttons: TUN (index 0), SOCKS5 (index 1)
    // Protocol buttons: HTTP/2 (index 2), HTTP/3 (index 3)
    // MTU buttons: Minus (index 4), Plus (index 5)
    const mtuMinusButton = buttons[4];
    fireEvent.click(mtuMinusButton);
    expect(state.updateField).toHaveBeenCalledWith("listener.tun.mtu_size", 1270);
  });

  it("MTU minus does not go below 576", () => {
    const state = makeState({
      config: {
        ...makeState().config!,
        listener: {
          tun: {
            ...makeState().config!.listener!.tun!,
            mtu_size: 580,
          },
        },
      },
    });
    render(<TunnelSection state={state} />);
    const buttons = screen.getAllByRole("button");
    const mtuMinusButton = buttons[4];
    fireEvent.click(mtuMinusButton);
    expect(state.updateField).toHaveBeenCalledWith("listener.tun.mtu_size", 576);
  });

  it("MTU plus does not exceed 9000", () => {
    const state = makeState({
      config: {
        ...makeState().config!,
        listener: {
          tun: {
            ...makeState().config!.listener!.tun!,
            mtu_size: 8995,
          },
        },
      },
    });
    render(<TunnelSection state={state} />);
    const buttons = screen.getAllByRole("button");
    const mtuPlusButton = buttons[buttons.length - 1];
    fireEvent.click(mtuPlusButton);
    expect(state.updateField).toHaveBeenCalledWith("listener.tun.mtu_size", 9000);
  });

  it("renders MTU input field that accepts numeric input", () => {
    const state = makeState();
    render(<TunnelSection state={state} />);
    const mtuInput = screen.getByDisplayValue("1280");
    fireEvent.change(mtuInput, { target: { value: "1400" } });
    expect(state.updateField).toHaveBeenCalledWith("listener.tun.mtu_size", 1400);
  });

  it("strips non-numeric characters from MTU input", () => {
    const state = makeState();
    render(<TunnelSection state={state} />);
    const mtuInput = screen.getByDisplayValue("1280");
    fireEvent.change(mtuInput, { target: { value: "12abc" } });
    expect(state.updateField).toHaveBeenCalledWith("listener.tun.mtu_size", 12);
  });

  it("clamps MTU to max 9000 on input", () => {
    const state = makeState();
    render(<TunnelSection state={state} />);
    const mtuInput = screen.getByDisplayValue("1280");
    fireEvent.change(mtuInput, { target: { value: "9999" } });
    expect(state.updateField).toHaveBeenCalledWith("listener.tun.mtu_size", 9000);
  });

  it("enforces min MTU of 576 on blur when value is too low", () => {
    const state = makeState({
      config: {
        ...makeState().config!,
        listener: {
          tun: {
            ...makeState().config!.listener!.tun!,
            mtu_size: 100,
          },
        },
      },
    });
    render(<TunnelSection state={state} />);
    const mtuInput = screen.getByDisplayValue("100");
    fireEvent.blur(mtuInput);
    expect(state.updateField).toHaveBeenCalledWith("listener.tun.mtu_size", 576);
  });

  it("shows HTTP/3 protocol when selected", () => {
    const state = makeState({
      config: {
        ...makeState().config!,
        endpoint: {
          ...makeState().config!.endpoint!,
          upstream_protocol: "http3",
        },
      },
    });
    render(<TunnelSection state={state} />);
    // Both buttons should be present
    expect(screen.getByText("HTTP/2")).toBeInTheDocument();
    expect(screen.getByText("HTTP/3")).toBeInTheDocument();
  });
});
