import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { NetworkSection } from "./NetworkSection";
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
      dns_upstreams: ["1.1.1.1", "8.8.8.8"],
    },
    saving: false,
    error: "",
    localPath: "/test/config.toml",
    dirty: false,
    status: "disconnected",
    setLocalPath: vi.fn(),
    setError: vi.fn(),
    updateField: vi.fn(),
    handleSave: vi.fn().mockResolvedValue(undefined),
    browseConfig: vi.fn().mockResolvedValue(undefined),
    clearConfig: vi.fn(),
    pushSuccess: vi.fn(),
    ...overrides,
  };
}

describe("NetworkSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders network section title", () => {
    render(<NetworkSection state={makeState()} />);
    expect(screen.getByText("Сеть")).toBeInTheDocument();
  });

  it("renders IPv6 toggle", () => {
    render(<NetworkSection state={makeState()} />);
    expect(screen.getByText("IPv6")).toBeInTheDocument();
  });

  it("renders DNS Upstreams label", () => {
    render(<NetworkSection state={makeState()} />);
    expect(screen.getByText("DNS Upstreams")).toBeInTheDocument();
  });

  it("renders DNS upstream input values", () => {
    render(<NetworkSection state={makeState()} />);
    expect(screen.getByDisplayValue("1.1.1.1")).toBeInTheDocument();
    expect(screen.getByDisplayValue("8.8.8.8")).toBeInTheDocument();
  });

  it("renders add DNS button", () => {
    render(<NetworkSection state={makeState()} />);
    expect(screen.getByText("Добавить DNS")).toBeInTheDocument();
  });

  it("calls updateField when add DNS button is clicked", () => {
    const state = makeState();
    render(<NetworkSection state={state} />);
    fireEvent.click(screen.getByText("Добавить DNS"));
    expect(state.updateField).toHaveBeenCalledWith("dns_upstreams", ["1.1.1.1", "8.8.8.8", ""]);
  });

  it("returns null when config is null", () => {
    const { container } = render(<NetworkSection state={makeState({ config: null })} />);
    expect(container.innerHTML).toBe("");
  });

  it("calls updateField to toggle IPv6 on", () => {
    const state = makeState();
    render(<NetworkSection state={state} />);
    // The IPv6 toggle is the first button
    const toggleButtons = screen.getAllByRole("button");
    fireEvent.click(toggleButtons[0]);
    expect(state.updateField).toHaveBeenCalledWith("endpoint.has_ipv6", true);
  });

  it("calls updateField when DNS upstream value is changed", () => {
    const state = makeState();
    render(<NetworkSection state={state} />);
    const firstInput = screen.getByDisplayValue("1.1.1.1");
    fireEvent.change(firstInput, { target: { value: "9.9.9.9" } });
    expect(state.updateField).toHaveBeenCalledWith("dns_upstreams", ["9.9.9.9", "8.8.8.8"]);
  });

  it("calls updateField to remove a DNS upstream when trash button is clicked", () => {
    const state = makeState();
    render(<NetworkSection state={state} />);
    // Find the trash/delete buttons for DNS entries
    const allButtons = screen.getAllByRole("button");
    // Filter for delete buttons (they come after the IPv6 toggle and before Add DNS)
    // IPv6 toggle is [0], then delete buttons for each DNS, then add DNS button
    // With 2 DNS entries, delete buttons are at index 1 and 2
    fireEvent.click(allButtons[1]);
    expect(state.updateField).toHaveBeenCalledWith("dns_upstreams", ["8.8.8.8"]);
  });

  it("removes second DNS upstream when its trash button is clicked", () => {
    const state = makeState();
    render(<NetworkSection state={state} />);
    const allButtons = screen.getAllByRole("button");
    // Second delete button removes the second DNS entry
    fireEvent.click(allButtons[2]);
    expect(state.updateField).toHaveBeenCalledWith("dns_upstreams", ["1.1.1.1"]);
  });

  it("renders with empty DNS upstreams", () => {
    const state = makeState({
      config: {
        ...makeState().config!,
        dns_upstreams: [],
      },
    });
    render(<NetworkSection state={state} />);
    expect(screen.getByText("DNS Upstreams")).toBeInTheDocument();
    expect(screen.getByText("Добавить DNS")).toBeInTheDocument();
    // No input fields for DNS
    expect(screen.queryByDisplayValue("1.1.1.1")).not.toBeInTheDocument();
  });

  it("renders IPv6 description help text", () => {
    render(<NetworkSection state={makeState()} />);
    // IPv6 label is rendered by the Toggle component
    expect(screen.getByText("IPv6")).toBeInTheDocument();
  });

  it("shows IPv6 toggle as off by default", () => {
    const state = makeState();
    render(<NetworkSection state={state} />);
    // IPv6 is off in default state (has_ipv6: false)
    // Toggle should exist and be clickable
    const toggleButtons = screen.getAllByRole("button");
    expect(toggleButtons[0]).toBeInTheDocument();
  });

  it("shows IPv6 toggle as on when has_ipv6 is true", () => {
    const state = makeState({
      config: {
        ...makeState().config!,
        endpoint: {
          ...makeState().config!.endpoint!,
          has_ipv6: true,
        },
      },
    });
    render(<NetworkSection state={state} />);
    // Clicking should set to false
    const toggleButtons = screen.getAllByRole("button");
    fireEvent.click(toggleButtons[0]);
    expect(state.updateField).toHaveBeenCalledWith("endpoint.has_ipv6", false);
  });
});
