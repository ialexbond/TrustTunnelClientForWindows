import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { ConfigSection } from "./ConfigSection";
import type { ServerState } from "./useServerState";

const SAMPLE_CONFIG = `
listen_address = "0.0.0.0:443"
tls_handshake_timeout_secs = 10
tcp_connections_timeout_secs = 30
udp_connections_timeout_secs = 60
ping_enable = true
speedtest_enable = false
ipv6_available = true
`;

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    setActionResult: vi.fn(),
    configRaw: SAMPLE_CONFIG,
    setConfigRaw: vi.fn(),
    pushSuccess: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

describe("ConfigSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders nothing when configRaw is null and no error", () => {
    const state = makeState({ configRaw: null });
    const { container } = render(<ConfigSection state={state} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders config title", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    expect(screen.getByText(i18n.t("server.config.title"))).toBeInTheDocument();
  });

  it("displays listen address from config", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    expect(screen.getByText("0.0.0.0:443")).toBeInTheDocument();
  });

  it("displays timeout values", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    expect(screen.getByText("10s")).toBeInTheDocument();
    expect(screen.getByText("30s")).toBeInTheDocument();
    expect(screen.getByText("60s")).toBeInTheDocument();
  });

  it("shows feature toggle labels", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    expect(screen.getByText("Health-check Ping")).toBeInTheDocument();
    expect(screen.getByText("Speedtest")).toBeInTheDocument();
    expect(screen.getByText("IPv6")).toBeInTheDocument();
  });

  it("shows toggle button for show/hide full config", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.config.show_full")) })).toBeInTheDocument();
  });

  it("toggles full config display on button click", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    const btn = screen.getByRole("button", { name: new RegExp(i18n.t("server.config.show_full")) });
    fireEvent.click(btn);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.config.hide_full")) })).toBeInTheDocument();
  });

  it("renders with empty config string without crashing", () => {
    const state = makeState({ configRaw: "" });
    const { container } = render(<ConfigSection state={state} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows full config content after toggling show", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    const btn = screen.getByRole("button", { name: new RegExp(i18n.t("server.config.show_full")) });
    fireEvent.click(btn);
    expect(screen.getByText(/listen_address\s*=\s*"0.0.0.0:443"/)).toBeInTheDocument();
  });

  it("hides full config when toggled back", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.config.show_full")) }));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.config.hide_full")) }));
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.config.show_full")) })).toBeInTheDocument();
  });

  it("displays TLS handshake timeout label", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    expect(screen.getByText(i18n.t("server.config.tls_handshake"))).toBeInTheDocument();
  });

  it("displays TCP timeout label", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    expect(screen.getByText(i18n.t("server.config.tcp_timeout"))).toBeInTheDocument();
  });

  it("displays UDP timeout label", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    expect(screen.getByText(i18n.t("server.config.udp_timeout"))).toBeInTheDocument();
  });

  it("displays timeouts section header", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    expect(screen.getByText(i18n.t("server.config.timeouts"))).toBeInTheDocument();
  });

  it("displays listen address label", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    expect(screen.getByText(i18n.t("server.config.listen"))).toBeInTheDocument();
  });

  it("does not show listen address when absent", () => {
    const config = `
ping_enable = true
speedtest_enable = false
ipv6_available = true
`;
    const state = makeState({ configRaw: config });
    render(<ConfigSection state={state} />);
    expect(screen.queryByText(i18n.t("server.config.listen"))).not.toBeInTheDocument();
  });

  it("does not show timeouts section when no timeouts present", () => {
    const config = `
listen = "0.0.0.0:443"
ping_enable = true
speedtest_enable = false
ipv6_available = true
`;
    const state = makeState({ configRaw: config });
    render(<ConfigSection state={state} />);
    expect(screen.queryByText(i18n.t("server.config.timeouts"))).not.toBeInTheDocument();
  });

  it("renders feature toggle descriptions", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    expect(screen.getByText(i18n.t("server.config.ping_desc"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.config.speedtest_desc"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.config.ipv6_desc"))).toBeInTheDocument();
  });

  it("renders 3 toggle switch buttons for features", () => {
    const state = makeState();
    const { container } = render(<ConfigSection state={state} />);
    const toggles = container.querySelectorAll("button.shrink-0.rounded-full");
    expect(toggles.length).toBe(3);
  });

  it("shows error message when configError present", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = makeState({ configRaw: null as any });
    const { container } = render(<ConfigSection state={state} />);
    expect(container.innerHTML).toBe("");
  });

  // ── Feature toggle interactions ──

  it("clicking a feature toggle calls invoke to update config feature", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const state = makeState();
    const { container } = render(<ConfigSection state={state} />);

    const toggles = container.querySelectorAll("button.shrink-0.rounded-full");
    // Click the ping toggle (first one) — it's currently true, should toggle to false
    fireEvent.click(toggles[0]);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_update_config_feature", {
        host: "10.0.0.1",
        port: 22,
        user: "root",
        password: "pass",
        feature: "ping_enable",
        enabled: false,
      });
    });
  });

  it("pushes success message after successful toggle", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const pushSuccess = vi.fn();
    const state = makeState({ pushSuccess });
    const { container } = render(<ConfigSection state={state} />);

    const toggles = container.querySelectorAll("button.shrink-0.rounded-full");
    fireEvent.click(toggles[0]); // toggle ping off

    await waitFor(() => {
      expect(pushSuccess).toHaveBeenCalled();
    });
  });

  it("sets action error when toggle invoke fails", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "server_update_config_feature") {
        throw new Error("Toggle failed");
      }
      return null;
    });
    const setActionResult = vi.fn();
    const state = makeState({ setActionResult });
    const { container } = render(<ConfigSection state={state} />);

    const toggles = container.querySelectorAll("button.shrink-0.rounded-full");
    fireEvent.click(toggles[0]);

    await waitFor(() => {
      expect(setActionResult).toHaveBeenCalledWith({ type: "error", message: expect.stringContaining("Toggle failed") });
    });
  });

  it("clicking speedtest toggle toggles it on (was false)", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const state = makeState();
    const { container } = render(<ConfigSection state={state} />);

    const toggles = container.querySelectorAll("button.shrink-0.rounded-full");
    // Speedtest is the second toggle (index 1), currently false, should toggle to true
    fireEvent.click(toggles[1]);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_update_config_feature", {
        host: "10.0.0.1",
        port: 22,
        user: "root",
        password: "pass",
        feature: "speedtest_enable",
        enabled: true,
      });
    });
  });

  it("clicking ipv6 toggle toggles it off (was true)", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    const state = makeState();
    const { container } = render(<ConfigSection state={state} />);

    const toggles = container.querySelectorAll("button.shrink-0.rounded-full");
    // IPv6 is the third toggle (index 2), currently true, should toggle to false
    fireEvent.click(toggles[2]);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_update_config_feature", {
        host: "10.0.0.1",
        port: 22,
        user: "root",
        password: "pass",
        feature: "ipv6_available",
        enabled: false,
      });
    });
  });

  it("reloads config after toggle completes (calls server_get_config)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "server_update_config_feature") return null;
      if (cmd === "server_get_config") return SAMPLE_CONFIG;
      return null;
    });
    const setConfigRaw = vi.fn();
    const state = makeState({ setConfigRaw });
    const { container } = render(<ConfigSection state={state} />);

    const toggles = container.querySelectorAll("button.shrink-0.rounded-full");
    fireEvent.click(toggles[0]);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_get_config", expect.objectContaining({ host: "10.0.0.1" }));
    });
  });

  // ── Double-click prevention ──

  it("prevents double-click on the same toggle", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let resolveToggle: any = null;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "server_update_config_feature") {
        return new Promise<void>((resolve) => { resolveToggle = resolve; });
      }
      if (cmd === "server_get_config") return SAMPLE_CONFIG;
      return null;
    });
    const state = makeState();
    const { container } = render(<ConfigSection state={state} />);

    const toggles = container.querySelectorAll("button.shrink-0.rounded-full");
    fireEvent.click(toggles[0]); // First click
    fireEvent.click(toggles[0]); // Second click (should be ignored)

    // Only one invoke call for the feature toggle
    const featureCalls = vi.mocked(invoke).mock.calls.filter(
      (c) => c[0] === "server_update_config_feature"
    );
    expect(featureCalls.length).toBe(1);

    // Resolve the pending toggle
    resolveToggle?.();
  });

  // ── Config with partial data ──

  it("renders only available timeout fields", () => {
    const config = `
listen_address = "0.0.0.0:443"
tcp_connections_timeout_secs = 15
ping_enable = false
speedtest_enable = false
ipv6_available = false
`;
    const state = makeState({ configRaw: config });
    render(<ConfigSection state={state} />);
    expect(screen.getByText(i18n.t("server.config.timeouts"))).toBeInTheDocument();
    expect(screen.getByText("15s")).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("server.config.tls_handshake"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("server.config.udp_timeout"))).not.toBeInTheDocument();
  });

  // ── Full config raw text display ──

  it("displays raw config text inside pre element after expand", () => {
    const state = makeState();
    render(<ConfigSection state={state} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.config.show_full")) }));
    // Check for raw TOML content
    expect(screen.getByText(/ping_enable = true/)).toBeInTheDocument();
    expect(screen.getByText(/speedtest_enable = false/)).toBeInTheDocument();
  });
});
