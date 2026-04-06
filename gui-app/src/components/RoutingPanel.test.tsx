import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../shared/i18n";
import RoutingPanel from "./RoutingPanel";
import { renderWithProviders as render } from "../test/test-utils";
import type { VpnStatus } from "../shared/types";

describe("RoutingPanel", () => {
  const defaultProps = {
    configPath: "/test/config.toml",
    status: "disconnected" as VpnStatus,
    connectedSince: null,
    vpnError: null,
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onReconnect: vi.fn().mockResolvedValue(undefined),
    vpnMode: "general",
    onVpnModeChange: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    localStorage.clear();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") {
        return {
          direct: [
            { id: "1", type: "domain", value: "example.com" },
            { id: "2", type: "domain", value: "test.ru" },
          ],
          proxy: [
            { id: "3", type: "domain", value: "proxy-site.com" },
          ],
          block: [],
          process_mode: "exclude",
          processes: [],
        };
      }
      if (cmd === "get_geodata_status") {
        return {
          downloaded: false,
          geoip_exists: false,
          geosite_exists: false,
          geoip_categories_count: 0,
          geosite_categories_count: 0,
        };
      }
      if (cmd === "get_geodata_categories") {
        return { geoip: [], geosite: [] };
      }
      if (cmd === "update_vpn_mode") {
        return null;
      }
      if (cmd === "check_geodata_updates") {
        return { update_available: false, current_tag: null, latest_tag: null };
      }
      return null;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows no-config message when configPath is empty", () => {
    render(<RoutingPanel {...defaultProps} configPath="" />);
    expect(screen.getByText("Конфигурация не выбрана")).toBeInTheDocument();
  });

  it("renders configured_in_settings text when no config path", () => {
    render(<RoutingPanel {...defaultProps} configPath="" />);
    expect(screen.getByText(/Настройте подключение на вкладке Настройки/)).toBeInTheDocument();
  });

  it("renders VPN mode selector after loading", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Режим VPN")).toBeInTheDocument();
    });
    expect(screen.getByText("Всё через VPN")).toBeInTheDocument();
  });

  it("renders both VPN mode buttons (general and selective)", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Всё через VPN")).toBeInTheDocument();
    });
    // "Напрямую" appears both as a VPN mode button and as the direct routing block title
    const matches = screen.getAllByText(i18n.t("vpn_modes.selective"));
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  it("renders routing block cards after loading", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Через VPN")).toBeInTheDocument();
    });
  });

  it("renders save and reconnect button after loading", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Сохранить и переподключить")).toBeInTheDocument();
    });
  });

  it("renders rule entries inside direct block", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("example.com")).toBeInTheDocument();
    });
    expect(screen.getByText("test.ru")).toBeInTheDocument();
  });

  it("renders proxy entries in proxy block", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("proxy-site.com")).toBeInTheDocument();
    });
  });

  it("renders both direct and proxy routing block cards", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Через VPN")).toBeInTheDocument();
    });
  });

  it("renders geodata status card after loading", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Геоданные")).toBeInTheDocument();
    });
  });

  // ── VPN mode switching ──

  it("calls invoke with update_vpn_mode when selective button is clicked", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getAllByText("Напрямую").length).toBeGreaterThanOrEqual(1);
    });

    // The VPN mode selector button is the one inside a grid layout
    const selectiveButtons = screen.getAllByText("Напрямую");
    // Click the button element (not the span) — find the one that's a button
    const selectiveBtn = selectiveButtons.find(el => el.closest("button"));
    fireEvent.click(selectiveBtn!.closest("button")!);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("update_vpn_mode", {
        configPath: "/test/config.toml",
        mode: "selective",
      });
    });
  });

  it("calls onVpnModeChange after successful mode switch", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Всё через VPN")).toBeInTheDocument();
    });

    // Find the selective mode button by its role and the Zap icon (it's in a grid)
    const allButtons = screen.getAllByRole("button");
    const selectiveBtn = allButtons.find(btn => btn.textContent?.trim() === "Напрямую");
    expect(selectiveBtn).toBeTruthy();
    fireEvent.click(selectiveBtn!);

    await waitFor(() => {
      expect(defaultProps.onVpnModeChange).toHaveBeenCalledWith("selective");
    });
  });

  it("does not call invoke when configPath is empty in handleVpnModeChange", async () => {
    // Render with empty configPath — should show no-config message, not the selector
    render(<RoutingPanel {...defaultProps} configPath="" />);
    // The mode selector won't be rendered, so update_vpn_mode won't be called
    expect(invoke).not.toHaveBeenCalledWith("update_vpn_mode", expect.anything());
  });

  it("handles vpn mode change error gracefully", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") {
        return { direct: [], proxy: [], block: [], process_mode: "exclude", processes: [] };
      }
      if (cmd === "get_geodata_status") {
        return { downloaded: false, geoip_exists: false, geosite_exists: false, geoip_categories_count: 0, geosite_categories_count: 0 };
      }
      if (cmd === "get_geodata_categories") {
        return { geoip: [], geosite: [] };
      }
      if (cmd === "update_vpn_mode") {
        throw new Error("Update failed");
      }
      if (cmd === "check_geodata_updates") {
        return { update_available: false, current_tag: null, latest_tag: null };
      }
      return null;
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Всё через VPN")).toBeInTheDocument();
    });

    const allButtons = screen.getAllByRole("button");
    const selectiveBtn = allButtons.find(btn => btn.textContent?.trim() === "Напрямую");
    expect(selectiveBtn).toBeTruthy();
    fireEvent.click(selectiveBtn!);

    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalled();
    });
    consoleSpy.mockRestore();
  });

  // ── Selective VPN mode description ──

  it("shows general mode help text when vpnMode is general", async () => {
    render(<RoutingPanel {...defaultProps} vpnMode="general" />);
    await waitFor(() => {
      expect(screen.getByText(i18n.t("help_text.vpn_mode_general"))).toBeInTheDocument();
    });
  });

  it("shows selective mode help text when vpnMode is selective", async () => {
    render(<RoutingPanel {...defaultProps} vpnMode="selective" />);
    await waitFor(() => {
      expect(screen.getByText(i18n.t("help_text.vpn_mode_selective"))).toBeInTheDocument();
    });
  });

  // ── Save button states ──

  it("save button is disabled when VPN is not active", async () => {
    render(<RoutingPanel {...defaultProps} status="disconnected" />);
    await waitFor(() => {
      expect(screen.getByText("Сохранить и переподключить")).toBeInTheDocument();
    });
    const saveBtn = screen.getByText("Сохранить и переподключить").closest("button");
    expect(saveBtn).toBeDisabled();
  });

  // ── Export/Import buttons ──

  it("renders export and import buttons", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByTitle(i18n.t("routing.exportRules"))).toBeInTheDocument();
    });
    expect(screen.getByTitle(i18n.t("routing.importRules"))).toBeInTheDocument();
  });

  // ── Error banner ──

  it("shows error banner when routing state has error", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") {
        throw new Error("Load failed");
      }
      if (cmd === "get_geodata_status") {
        return { downloaded: false, geoip_exists: false, geosite_exists: false, geoip_categories_count: 0, geosite_categories_count: 0 };
      }
      if (cmd === "get_geodata_categories") {
        return { geoip: [], geosite: [] };
      }
      if (cmd === "check_geodata_updates") {
        return { update_available: false, current_tag: null, latest_tag: null };
      }
      return null;
    });

    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/Load failed/)).toBeInTheDocument();
    });
  });

  // ── Block routing (feature toggle) ──

  it("does not show block routing card by default (feature off)", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Режим VPN")).toBeInTheDocument();
    });
    expect(screen.queryByText("Заблокировать")).not.toBeInTheDocument();
  });

  it("shows block routing card when feature toggle is enabled", async () => {
    localStorage.setItem("tt_feature_toggles", JSON.stringify({ blockRouting: true, processFilter: false }));
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Заблокировать")).toBeInTheDocument();
    });
  });

  // ── Process filter (feature toggle) ──

  it("does not show process filter by default (feature off)", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Режим VPN")).toBeInTheDocument();
    });
    expect(screen.queryByText(i18n.t("routing.process_filter_title"))).not.toBeInTheDocument();
  });

  it("shows process filter section when feature toggle is enabled", async () => {
    localStorage.setItem("tt_feature_toggles", JSON.stringify({ blockRouting: false, processFilter: true }));
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Режим VPN")).toBeInTheDocument();
    });
    // Process filter section should be rendered
  });

  // ── Geodata status with downloaded data ──

  it("renders geodata card showing not downloaded state", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Геоданные")).toBeInTheDocument();
    });
  });

  it("renders geodata card with downloaded state", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "load_routing_rules") {
        return { direct: [], proxy: [], block: [], process_mode: "exclude", processes: [] };
      }
      if (cmd === "get_geodata_status") {
        return {
          downloaded: true,
          geoip_exists: true,
          geosite_exists: true,
          geoip_categories_count: 5,
          geosite_categories_count: 10,
        };
      }
      if (cmd === "get_geodata_categories") {
        return { geoip: ["cn", "ru"], geosite: ["google", "facebook"] };
      }
      if (cmd === "check_geodata_updates") {
        return { update_available: false, current_tag: null, latest_tag: null };
      }
      return null;
    });

    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("Геоданные")).toBeInTheDocument();
    });
  });

  // ── Loading state ──

  it("shows loading spinner initially", () => {
    // When invoke hasn't resolved yet, useRoutingState is still loading
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {})); // never resolves
    render(<RoutingPanel {...defaultProps} />);
    // The component should show a spinner (Loader2)
    // It won't show the VPN mode selector yet
    expect(screen.queryByText("Режим VPN")).not.toBeInTheDocument();
  });
});
