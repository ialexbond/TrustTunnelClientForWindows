import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConfirmDialogProvider } from "../../shared/ui/ConfirmDialogProvider";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import i18n from "../../shared/i18n";
import { ConfigurationTab } from "./ConfigurationTab";
import type { ConfigBundle } from "./config/types";

// Mock @tauri-apps/api/core
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

// Mock @tauri-apps/api/event для useTomlConfigState (если listen used directly)
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Mock @tauri-apps/plugin-shell
vi.mock("@tauri-apps/plugin-shell", () => ({
  open: vi.fn(() => Promise.resolve()),
}));

// Mock useActivityLog spy — D-29 invariant assertion target.
const mockActivityLog = vi.fn();
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: mockActivityLog }),
}));

const SSH_PARAMS = { host: "test", port: "22", user: "u", password: "p" };

const MOCK_BUNDLE: ConfigBundle = {
  vpnToml: `listen_address = "0.0.0.0:443"
ipv6_available = true
allow_private_network_connections = false
speedtest_enable = false
ping_enable = false
`,
  hostsToml: `[[main_hosts]]
hostname = "a.com"
cert_chain_path = "/etc/c.pem"
private_key_path = "/etc/k.pem"
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
 * Phase 15.1 Plan 06 — ConfigurationTab orchestrator tests.
 *
 * Coverage matrix:
 *   D-1.1   — 4 Quick Settings toggles render
 *   REQ-15.0 — single SSH channel (server_get_config_bundle invoked exactly once)
 *   D-11.1  — credentials.toml passwords rendered as ••••••••
 *   D-29    — activity log NEVER receives raw credentials.toml content
 *   D-1.3   — Save/Discard buttons disabled when no dirty fields
 *   D-PRE-4 — Storybook escape hatch (_storybook + _mockBundle bypass invoke)
 *   REQ-15.0 — loading + error states render
 *   D-17.1  — Footer docs link opens external URL
 */
describe("ConfigurationTab", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
    mockInvoke.mockReset();
  });

  it("renders Quick Settings Card with 4 toggles (D-1.1)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    await waitFor(() =>
      expect(screen.queryByText(/Быстрые настройки/i)).toBeInTheDocument(),
    );
    // 4 toggle keys appear как text-mono labels (raw English D-3.1).
    expect(screen.getByText("ipv6_available")).toBeInTheDocument();
    expect(
      screen.getByText("allow_private_network_connections"),
    ).toBeInTheDocument();
    expect(screen.getByText("speedtest_enable")).toBeInTheDocument();
    expect(screen.getByText("ping_enable")).toBeInTheDocument();
  });

  it("loads bundle via single server_get_config_bundle invoke (REQ-15.0, Pitfall 4)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith(
        "server_get_config_bundle",
        expect.any(Object),
      ),
    );
    // ONLY ONE invoke на mount
    const bundleCalls = mockInvoke.mock.calls.filter(
      (c) => c[0] === "server_get_config_bundle",
    );
    expect(bundleCalls.length).toBe(1);
  });

  it("credentials.toml preview shows passwords as •••••••• (D-11.1)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    await waitFor(() =>
      expect(screen.queryByText(/Быстрые настройки/i)).toBeInTheDocument(),
    );
    // Open credentials accordion via accessible name.
    const credentialsTrigger = screen.getByRole("button", {
      name: /credentials\.toml/i,
    });
    fireEvent.click(credentialsTrigger);
    // Mask is rendered, real password is NOT rendered
    await waitFor(() =>
      expect(screen.queryByText("••••••••")).toBeInTheDocument(),
    );
    expect(screen.queryByText("TOPSECRET123")).not.toBeInTheDocument();
  });

  it("activity log NEVER receives raw credentials.toml content (D-29)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    await waitFor(() =>
      expect(screen.queryByText(/Быстрые настройки/i)).toBeInTheDocument(),
    );
    // Verify across all activity log calls (load + any internal)
    for (const call of mockActivityLog.mock.calls) {
      for (const arg of call) {
        if (typeof arg === "string") {
          expect(arg).not.toContain("TOPSECRET123");
        }
      }
    }
  });

  it("Save button disabled when no dirty fields", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    await waitFor(() =>
      expect(screen.queryByText(/Быстрые настройки/i)).toBeInTheDocument(),
    );
    const saveBtn = screen.getByRole("button", {
      name: /Сохранить настройки/i,
    });
    expect(saveBtn).toBeDisabled();
  });

  it("Discard button disabled when no dirty fields", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    await waitFor(() =>
      expect(screen.queryByText(/Быстрые настройки/i)).toBeInTheDocument(),
    );
    const discardBtn = screen.getByRole("button", {
      name: /Отменить изменения/i,
    });
    expect(discardBtn).toBeDisabled();
  });

  it("Storybook escape hatch — _storybook + _mockBundle (D-PRE-4)", async () => {
    renderTab({ _storybook: true, _mockBundle: MOCK_BUNDLE });
    // Should NOT call invoke
    expect(mockInvoke).not.toHaveBeenCalled();
    // Should still render Quick Settings (placeholder schema fallback)
    await waitFor(() =>
      expect(screen.queryByText(/Быстрые настройки/i)).toBeInTheDocument(),
    );
  });

  it("Loading state shows skeleton", () => {
    mockInvoke.mockImplementation(() => new Promise(() => {})); // never resolves
    renderTab();
    // Skeleton renders aria-hidden divs — verify via container query.
    const skeletons = document.querySelectorAll('[aria-hidden="true"]');
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("Error state shows retry button", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("SSH_FAILED"));
    renderTab();
    // i18n key `errors.retry` resolves to "Попробовать снова" in RU.
    const retryBtn = await screen.findByRole("button", {
      name: /Попробовать снова/i,
    });
    expect(retryBtn).toBeInTheDocument();
  });

  it("Footer docs link opens external URL (D-17.1)", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    const { open } = await import("@tauri-apps/plugin-shell");
    renderTab();
    await waitFor(() =>
      expect(screen.queryByText(/Быстрые настройки/i)).toBeInTheDocument(),
    );
    const docsBtn = screen.getByRole("button", {
      name: /Документация TrustTunnel/i,
    });
    fireEvent.click(docsBtn);
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        expect.stringContaining("CONFIGURATION.md"),
      ),
    );
  });
});
