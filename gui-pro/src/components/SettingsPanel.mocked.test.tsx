import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../shared/i18n";
import type { VpnStatus } from "../shared/types";
import { useSettingsState } from "./settings/useSettingsState";
import type { SettingsState } from "./settings/useSettingsState";

// Mock the hook so SettingsPanel uses our controlled state
vi.mock("./settings/useSettingsState", () => ({
  useSettingsState: vi.fn(),
}));

// Must import SettingsPanel AFTER mocking
import SettingsPanel from "./SettingsPanel";

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

const baseMockState: SettingsState = {
  config: mockConfig,
  saving: false,
  error: "",
  localPath: "/test/config.toml",
  dirty: false,
  status: "disconnected" as VpnStatus,
  setLocalPath: vi.fn(),
  setError: vi.fn(),
  updateField: vi.fn(),
  handleSave: vi.fn().mockResolvedValue(undefined),
  browseConfig: vi.fn(),
  clearConfig: vi.fn(),
  pushSuccess: vi.fn(),
};

const defaultProps = {
  configPath: "/test/config.toml",
  onConfigChange: vi.fn(),
  status: "disconnected" as VpnStatus,
  onReconnect: vi.fn().mockResolvedValue(undefined),
  onSwitchToSetup: vi.fn(),
  onClearConfig: vi.fn(),
};

describe("SettingsPanel (mocked state)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    vi.mocked(useSettingsState).mockReturnValue({ ...baseMockState });
  });

  it("calls handleSave(true) when save button clicked", () => {
    const handleSave = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useSettingsState).mockReturnValue({
      ...baseMockState,
      status: "connected",
      dirty: true,
      handleSave,
    });
    render(
      <SettingsPanel {...defaultProps} status={"connected" as VpnStatus} />
    );
    const saveBtn = screen
      .getByText("Сохранить и переподключить")
      .closest("button")!;
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);
    expect(handleSave).toHaveBeenCalledWith(true);
  });

  it("shows saving label when saving is true", () => {
    vi.mocked(useSettingsState).mockReturnValue({
      ...baseMockState,
      saving: true,
    });
    render(<SettingsPanel {...defaultProps} />);
    expect(screen.getByText("Сохранение...")).toBeInTheDocument();
  });

  it("save button is disabled when dirty but VPN not active", () => {
    vi.mocked(useSettingsState).mockReturnValue({
      ...baseMockState,
      dirty: true,
      status: "disconnected",
    });
    render(<SettingsPanel {...defaultProps} />);
    const saveBtn = screen
      .getByText("Сохранить и переподключить")
      .closest("button");
    expect(saveBtn).toBeDisabled();
  });

  it("save button is disabled when VPN active but not dirty", () => {
    vi.mocked(useSettingsState).mockReturnValue({
      ...baseMockState,
      dirty: false,
      status: "connected",
    });
    render(<SettingsPanel {...defaultProps} />);
    const saveBtn = screen
      .getByText("Сохранить и переподключить")
      .closest("button");
    expect(saveBtn).toBeDisabled();
  });

  it("shows placeholder when config is null", () => {
    vi.mocked(useSettingsState).mockReturnValue({
      ...baseMockState,
      config: null,
    });
    render(<SettingsPanel {...defaultProps} />);
    expect(
      screen.getByText("Укажите путь к конфигу...")
    ).toBeInTheDocument();
  });
});
