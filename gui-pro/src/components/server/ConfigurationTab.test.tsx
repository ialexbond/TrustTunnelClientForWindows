import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmDialogProvider } from "../../shared/ui/ConfirmDialogProvider";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import i18n from "../../shared/i18n";
import { ConfigurationTab } from "./ConfigurationTab";
import type { ConfigBundle } from "./config/types";

const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(() => Promise.resolve()),
}));

const mockActivityLog = vi.fn();
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: mockActivityLog }),
}));

const SSH_PARAMS = { host: "test", port: "22", user: "u", password: "p" };

const MOCK_BUNDLE: ConfigBundle = {
  vpnToml: `listen_address = "0.0.0.0:443"
ipv6_available = true
`,
  hostsToml: `[[main_hosts]]
hostname = "a.com"
`,
  credentialsToml: `[[client]]
username = "user1"
password = "TOPSECRET123"
`,
  rulesToml: `[[rule]]
cidr = "10.0.0.0/8"
action = "allow"
`,
  typed: {
    listen_address: "0.0.0.0:443",
    ipv6_available: true,
    allow_private_network_connections: false,
    log_level: null,
    auth_failure_status_code: 407,
    ping_enable: false,
    speedtest_enable: false,
    ping_path: "/ping",
    speedtest_path: "/speedtest",
    credentials_file: "credentials.toml",
  },
  allowedSni: [],
  serviceStatus: "active",
};

function renderTab(
  overrides: Partial<Parameters<typeof ConfigurationTab>[0]> = {},
) {
  return render(
    <SnackBarProvider>
      <ConfirmDialogProvider>
        <ConfigurationTab
          sshParams={SSH_PARAMS}
          onNavigateToTab={vi.fn()}
          {...overrides}
        />
      </ConfirmDialogProvider>
    </SnackBarProvider>,
  );
}

/**
 * Phase 15.1 (raw-view) — ConfigurationTab tests.
 *
 * Coverage:
 *   REQ-15.0  — single SSH channel (server_get_config_bundle invoked exactly once)
 *   D-11.1    — credentials.toml passwords rendered as ••••••••
 *   D-29      — activity log NEVER receives raw credentials.toml content
 *   D-PRE-4   — Storybook escape hatch (_storybook + _mockBundle bypass invoke)
 *   REQ-15.0  — loading + error states render
 *   D-17.1    — Footer docs link opens external URL
 */
describe("ConfigurationTab (raw-view)", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
    mockInvoke.mockReset();
  });

  it("loads bundle via single server_get_config_bundle invoke (REQ-15.0)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "server_get_config_bundle",
        expect.any(Object),
      ),
    );
    const bundleCalls = mockInvoke.mock.calls.filter(
      (c) => c[0] === "server_get_config_bundle",
    );
    expect(bundleCalls.length).toBe(1);
  });

  it("renders 4 file accordions (vpn / hosts / credentials / rules)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /vpn\.toml/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: /hosts\.toml/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /credentials\.toml/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /rules\.toml/i }),
    ).toBeInTheDocument();
  });

  it("credentials.toml accordion shows password as •••••••• (D-11.1)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /credentials\.toml/i }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /credentials\.toml/i }),
    );
    await waitFor(() =>
      expect(
        screen.getByText((content) => content.includes("••••••••")),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/TOPSECRET123/)).not.toBeInTheDocument();
  });

  it("activity log NEVER receives raw credentials.toml content (D-29)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /vpn\.toml/i }),
      ).toBeInTheDocument(),
    );
    for (const call of mockActivityLog.mock.calls) {
      for (const arg of call) {
        if (typeof arg === "string") {
          expect(arg).not.toContain("TOPSECRET123");
        }
      }
    }
  });

  it("Storybook escape hatch — _storybook + _mockBundle (D-PRE-4)", async () => {
    renderTab({ _storybook: true, _mockBundle: MOCK_BUNDLE });
    expect(mockInvoke).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /vpn\.toml/i }),
      ).toBeInTheDocument(),
    );
  });

  it("Loading state shows skeleton", () => {
    mockInvoke.mockImplementation(() => new Promise(() => {}));
    renderTab();
    const skeletons = document.querySelectorAll('[aria-hidden="true"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("Error state shows retry button", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("SSH_FAILED"));
    renderTab();
    const retryBtn = await screen.findByRole("button", {
      name: /Попробовать снова|Повторить/i,
    });
    expect(retryBtn).toBeInTheDocument();
  });

  it("Footer docs link opens external URL (D-17.1)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    const { open } = await import("@tauri-apps/plugin-shell");
    renderTab();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /vpn\.toml/i }),
      ).toBeInTheDocument(),
    );
    const docsBtn = screen.getByRole("button", {
      name: /Документация|configuration/i,
    });
    fireEvent.click(docsBtn);
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        expect.stringContaining("CONFIGURATION.md"),
      ),
    );
  });
});
