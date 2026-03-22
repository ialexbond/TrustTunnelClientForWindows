import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "../../src/test/tauri-mock";
import { invoke } from "@tauri-apps/api/core";
import RoutingPanel from "./RoutingPanel";
import type { VpnStatus } from "../App";

describe("RoutingPanel", () => {
  const defaultProps = {
    configPath: "/test/config.toml",
    status: "disconnected" as VpnStatus,
    onReconnect: vi.fn().mockResolvedValue(undefined),
    vpnMode: "tun",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "load_exclusion_list") return ["example.com", "test.ru"];
      if (cmd === "load_group_cache") return [];
      if (cmd === "load_exclusion_json") return [];
      if (cmd === "load_active_groups") return [];
      if (cmd === "get_iplist_groups") return [];
      return null;
    });
  });

  it("renders routing panel header", async () => {
    render(<RoutingPanel {...defaultProps} vpnMode="selective" />);
    await waitFor(() => {
      expect(screen.getByText("Через VPN")).toBeInTheDocument();
    });
  });

  it("loads and displays domain entries", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText("example.com")).toBeInTheDocument();
    });
    expect(screen.getByText("test.ru")).toBeInTheDocument();
  });

  it("shows domain count after loading", async () => {
    render(<RoutingPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText(/2/)).toBeInTheDocument();
    });
  });
});
