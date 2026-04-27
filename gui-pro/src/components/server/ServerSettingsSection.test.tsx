import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { ServerSettingsSection } from "./ServerSettingsSection";
import { renderWithProviders as render } from "../../test/test-utils";
import type { ServerState } from "./useServerState";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const stableLog = vi.fn();
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: stableLog }),
}));

// Mock useSecurityState — exercises real ServerSettingsSection internals
// without dragging in the security-status SSH IPC during these tests.
vi.mock("./useSecurityState", () => ({
  useSecurityState: () => ({
    status: { firewall: { current_ssh_port: 22, vpn_port: 443 } },
    loading: false,
    portBusy: false,
    changeSshPort: vi.fn(),
  }),
}));

// Stub VersionSection — its internals (dropdown portal, version list) live
// in their own test suite; we only assert ServerSettingsSection includes it.
vi.mock("./VersionSection", () => ({
  VersionSection: () => <div data-testid="version-section" />,
}));

// SshPortSection is light enough to render real, but we stub its inner button
// state for predictable presence assertions.
vi.mock("./SshPortSection", () => ({
  SshPortSection: () => <div data-testid="ssh-port-section" />,
}));

const SAMPLE_BUNDLE = {
  vpnToml: 'listen_address = "0.0.0.0:443"\nlog_level = "info"\n',
  hostsToml:
    '[[main_hosts]]\nhostname = "example.com"\nallowed_sni = ["cdn.example.com"]\n',
  typed: {
    listen_address: "0.0.0.0:443",
    ipv6_available: true,
    allow_private_network_connections: false,
    log_level: "info",
    auth_failure_status_code: 407,
    ping_enable: false,
    speedtest_enable: false,
    ping_path: "/ping",
    speedtest_path: "/speedtest",
    credentials_file: "credentials.toml",
    extra: {},
  },
  allowedSni: [
    { hostname: "example.com", allowedSni: ["cdn.example.com"] },
  ],
  serviceStatus: "active",
};

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    serverInfo: {
      installed: true,
      version: "1.4.0",
      serviceActive: true,
      users: ["alice"],
    },
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    pushSuccess: vi.fn(),
    onPortChanged: vi.fn(),
    setActionResult: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

beforeEach(() => {
  vi.clearAllMocks();
  i18n.changeLanguage("ru");
  vi.mocked(invoke).mockResolvedValue(SAMPLE_BUNDLE);
});

describe("ServerSettingsSection (Phase 15 rewrite)", () => {
  it("invokes server_get_config_bundle exactly once on mount (single hook instance)", async () => {
    const state = makeState();
    render(<ServerSettingsSection state={state} />);
    await waitFor(() =>
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument(),
    );
    const bundleCalls = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "server_get_config_bundle");
    expect(bundleCalls).toHaveLength(1);
  });

  it("renders QuickSettingsSection 6 fields", async () => {
    const state = makeState();
    render(<ServerSettingsSection state={state} />);
    await waitFor(() =>
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Путь Health Check")).toBeInTheDocument();
    expect(screen.getByLabelText("Путь Speed Test")).toBeInTheDocument();
    expect(screen.getByText("Уровень логов")).toBeInTheDocument();
    expect(screen.getByText("Код ошибки авторизации")).toBeInTheDocument();
    expect(screen.getByText("Частные сети")).toBeInTheDocument();
  });

  it("renders AdvancedConfigAccordion trigger", async () => {
    const state = makeState();
    render(<ServerSettingsSection state={state} />);
    await waitFor(() =>
      expect(screen.getByText("Расширенная конфигурация")).toBeInTheDocument(),
    );
  });

  it("renders AllowedSniEditor inside accordion when opened (passes hosts from shared state)", async () => {
    const state = makeState();
    render(<ServerSettingsSection state={state} />);
    await waitFor(() =>
      expect(screen.getByText("Расширенная конфигурация")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Расширенная конфигурация"));
    // Hostname mono legend from AllowedSniEditor + chip for cdn.example.com
    await waitFor(() =>
      expect(screen.getByText("example.com")).toBeVisible(),
    );
    expect(screen.getByText("cdn.example.com")).toBeVisible();
  });

  it("renders SshPortSection card", async () => {
    const state = makeState();
    render(<ServerSettingsSection state={state} />);
    await waitFor(() =>
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("ssh-port-section")).toBeInTheDocument();
  });

  it("renders VersionSection card", async () => {
    const state = makeState();
    render(<ServerSettingsSection state={state} />);
    await waitFor(() =>
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("version-section")).toBeInTheDocument();
  });

  it("does NOT render ping_enable/speedtest_enable/ipv6_available toggles (D-1: those belong to Overview)", async () => {
    const state = makeState();
    render(<ServerSettingsSection state={state} />);
    await waitFor(() =>
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument(),
    );
    // These labels live in Overview tab now — must NOT appear in Configuration
    expect(screen.queryByText(/Health-check Ping/i)).toBeNull();
    expect(screen.queryByText(/Speedtest$/i)).toBeNull();
    expect(screen.queryByText(/^IPv6$/i)).toBeNull();
  });

  it("does NOT render legacy toggles_title section (replaced by QuickSettingsSection)", async () => {
    const state = makeState();
    render(<ServerSettingsSection state={state} />);
    await waitFor(() =>
      expect(screen.getByLabelText("Адрес и порт")).toBeInTheDocument(),
    );
    // Legacy "Переключатели" / "Toggles" section is gone — replaced by Quick Settings
    expect(
      screen.queryByText(i18n.t("server.config.toggles_title")),
    ).toBeNull();
  });
});
