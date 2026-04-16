import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { ServerSettingsSection } from "./ServerSettingsSection";
import { renderWithProviders as render } from "../../test/test-utils";
import type { ServerState } from "./useServerState";

// Mock sub-hooks that call Tauri commands
vi.mock("./useBbrState", () => ({
  useBbrState: () => ({
    enabled: false,
    loading: false,
    toggling: false,
    toggle: vi.fn(),
  }),
}));

vi.mock("./useMtProtoState", () => ({
  useMtProtoState: () => ({
    status: null,
    loading: false,
    confirm: null,
    setConfirm: vi.fn(),
  }),
}));

vi.mock("./useSecurityState", () => ({
  useSecurityState: () => ({
    confirm: null,
    setConfirm: vi.fn(),
  }),
}));

// Mock complex sub-components
vi.mock("./SshPortSection", () => ({
  SshPortSection: () => <div data-testid="ssh-port-section" />,
}));

vi.mock("./VersionSection", () => ({
  VersionSection: () => <div data-testid="version-section" />,
}));

vi.mock("./MtProtoSection", () => ({
  MtProtoSection: () => <div data-testid="mtproto-section" />,
}));

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    serverInfo: {
      installed: true,
      version: "1.4.0",
      serviceActive: true,
      users: ["alice"],
    },
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    configRaw:
      "ping_enable = true\nspeedtest_enable = false\nipv6_available = false\n",
    setConfigRaw: vi.fn(),
    setActionResult: vi.fn(),
    pushSuccess: vi.fn(),
    onPortChanged: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

describe("ServerSettingsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("renders feature toggles section title", () => {
    const state = makeState();
    render(<ServerSettingsSection state={state} />);
    expect(screen.getByText(i18n.t("server.config.toggles_title"))).toBeInTheDocument();
  });

  it("no longer embeds BBR toggle (moved to UtilitiesTabSection in Phase 11)", () => {
    const state = makeState();
    render(<ServerSettingsSection state={state} />);
    // BBR and the network_title heading were relocated to UtilitiesTabSection's
    // "BBR Toggle" block in Phase 11 (4-tab restructure). The feature-toggles
    // area remains here but no longer contains BBR.
    expect(screen.queryByText(i18n.t("server.utilities.bbr.label"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("server.config.network_title"))).not.toBeInTheDocument();
    // Sanity: feature toggles title still rendered by this section.
    expect(screen.getByText(i18n.t("server.config.toggles_title"))).toBeInTheDocument();
  });

  it("renders Advanced accordion collapsed by default", () => {
    const state = makeState();
    render(<ServerSettingsSection state={state} />);
    // Accordion trigger should be visible
    const advancedTitle = screen.getByText(i18n.t("server.config.advanced"));
    expect(advancedTitle).toBeInTheDocument();
    // VersionSection inside accordion should not be visible (collapsed)
    const versionSection = screen.queryByTestId("version-section");
    if (versionSection) {
      expect(versionSection).not.toBeVisible();
    }
  });

  it("renders save settings button with concrete label", () => {
    const state = makeState();
    render(<ServerSettingsSection state={state} />);
    expect(
      screen.getByRole("button", { name: new RegExp(i18n.t("server.config.save_settings")) })
    ).toBeInTheDocument();
  });

  it("renders SshPortSection in network block", () => {
    const state = makeState();
    render(<ServerSettingsSection state={state} />);
    expect(screen.getByTestId("ssh-port-section")).toBeInTheDocument();
  });

  it("shows feature toggles when configRaw is loaded", () => {
    const state = makeState();
    render(<ServerSettingsSection state={state} />);
    // Feature labels (hardcoded in component, not i18n)
    expect(screen.getByText("Health-check Ping")).toBeInTheDocument();
    expect(screen.getByText("Speedtest")).toBeInTheDocument();
    expect(screen.getByText("IPv6")).toBeInTheDocument();
  });

  it("shows loading indicator when configRaw is null", () => {
    const state = makeState({ configRaw: null });
    render(<ServerSettingsSection state={state} />);
    // Component shows loading text in both features section and warning banner when configRaw is null
    const loadingElements = screen.getAllByText(i18n.t("server.config.loading"));
    expect(loadingElements.length).toBeGreaterThanOrEqual(1);
  });
});
