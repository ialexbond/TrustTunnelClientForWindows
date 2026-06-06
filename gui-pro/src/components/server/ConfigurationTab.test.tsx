import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { ConfirmDialogProvider } from "../../shared/ui/ConfirmDialogProvider";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import i18n from "../../shared/i18n";
import { ConfigurationTab } from "./ConfigurationTab";
import { makeBundle } from "../../test/fixtures";

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

// [Phase 3] The inlined MOCK_BUNDLE literal was deduped into the Wave-0
// makeBundle() factory (gui-pro/src/test/fixtures/config.ts). Values — including
// the D-29 probe secret TOPSECRET123 — are byte-identical to the old literal.
const MOCK_BUNDLE = makeBundle();

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
 *
 * Phase 3 safety-net additions (Stream 3): retry→second invoke, accordion
 * expand/collapse aria-expanded, content-on-expand, edit-in-Users nav+log,
 * empty-file body, storybook forceLoading/forceError/null states; the
 * loading-state false green (svg-count) rewritten to accordions-absent.
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

  // ════════════════════════════════════════════════════════════════════════
  // Loading / error / empty states (Phase 3 gap-fill + false-green fix)
  // ════════════════════════════════════════════════════════════════════════

  it("Loading state shows skeleton placeholders and NO file accordions", () => {
    // [Phase 3 FG-1] Previously asserted `[aria-hidden="true"]` count > 0 — a
    // false green (D-04) that matched ANY decorative svg/element on the page,
    // including the chevrons/icons of a rendered accordion. The real loading
    // contract: the 4 file accordions are ABSENT (no vpn.toml trigger button
    // exists) while skeleton placeholders are shown in their place.
    mockInvoke.mockImplementation(() => new Promise(() => {}));
    renderTab();
    expect(
      screen.queryByRole("button", { name: /vpn\.toml/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /credentials\.toml/i }),
    ).not.toBeInTheDocument();
    // Skeleton placeholders (aria-hidden divs) render in the loading layout.
    const skeletons = document.querySelectorAll('[aria-hidden="true"]');
    expect(skeletons.length).toBe(4);
  });

  it("Error state shows retry button", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("SSH_FAILED"));
    renderTab();
    const retryBtn = await screen.findByRole("button", {
      name: /Попробовать снова|Повторить/i,
    });
    expect(retryBtn).toBeInTheDocument();
  });

  it("Error retry button triggers a SECOND server_get_config_bundle invoke", async () => {
    // First load fails → error state; clicking Retry re-invokes the bundle load.
    mockInvoke.mockRejectedValueOnce(new Error("SSH_FAILED"));
    renderTab();
    const retryBtn = await screen.findByRole("button", {
      name: /Повторить|Попробовать снова/i,
    });
    // Second attempt succeeds.
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    fireEvent.click(retryBtn);
    await waitFor(() => {
      const bundleCalls = mockInvoke.mock.calls.filter(
        (c) => c[0] === "server_get_config_bundle",
      );
      expect(bundleCalls.length).toBe(2);
    });
    // Recovery: accordions appear after the successful retry.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /vpn\.toml/i }),
      ).toBeInTheDocument(),
    );
  });

  it("_forceLoading escape hatch shows skeleton (no accordions)", () => {
    renderTab({ _storybook: true, _mockBundle: MOCK_BUNDLE, _forceLoading: true });
    expect(
      screen.queryByRole("button", { name: /vpn\.toml/i }),
    ).not.toBeInTheDocument();
  });

  it("_forceError escape hatch shows the error body + retry button", async () => {
    renderTab({ _storybook: true, _forceError: "BOOM" });
    expect(await screen.findByText("BOOM")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Повторить|Попробовать снова/i }),
    ).toBeInTheDocument();
  });

  it("renders nothing meaningful when storybook bundle is null", () => {
    const { container } = renderTab({ _storybook: true, _mockBundle: undefined });
    // bundle === null → component returns null (no accordions, no error).
    expect(
      screen.queryByRole("button", { name: /vpn\.toml/i }),
    ).not.toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();
  });

  // ════════════════════════════════════════════════════════════════════════
  // Accordion expand/collapse + content (Phase 3 gap-fill)
  // ════════════════════════════════════════════════════════════════════════

  it("accordions start collapsed (aria-expanded=false) and toggle on click", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    const vpnTrigger = await screen.findByRole("button", { name: /vpn\.toml/i });
    expect(vpnTrigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(vpnTrigger);
    await waitFor(() =>
      expect(vpnTrigger).toHaveAttribute("aria-expanded", "true"),
    );
    fireEvent.click(vpnTrigger);
    await waitFor(() =>
      expect(vpnTrigger).toHaveAttribute("aria-expanded", "false"),
    );
  });

  it("expanding vpn.toml reveals its raw content", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    const vpnTrigger = await screen.findByRole("button", { name: /vpn\.toml/i });
    fireEvent.click(vpnTrigger);
    await waitFor(() =>
      expect(
        screen.getByText((c) => c.includes("listen_address")),
      ).toBeInTheDocument(),
    );
  });

  it("expanding hosts.toml reveals its raw content", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    const hostsTrigger = await screen.findByRole("button", {
      name: /hosts\.toml/i,
    });
    fireEvent.click(hostsTrigger);
    await waitFor(() =>
      expect(
        screen.getByText((c) => c.includes("main_hosts")),
      ).toBeInTheDocument(),
    );
  });

  it("expanding rules.toml reveals its raw content", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    const rulesTrigger = await screen.findByRole("button", {
      name: /rules\.toml/i,
    });
    fireEvent.click(rulesTrigger);
    await waitFor(() =>
      expect(
        screen.getByText((c) => c.includes("10.0.0.0/8")),
      ).toBeInTheDocument(),
    );
  });

  it("empty file shows the empty-file body instead of a <pre>", async () => {
    mockInvoke.mockResolvedValueOnce(makeBundle({ vpnToml: "" }));
    renderTab();
    const vpnTrigger = await screen.findByRole("button", { name: /vpn\.toml/i });
    fireEvent.click(vpnTrigger);
    await waitFor(() =>
      expect(
        screen.getByText(
          i18n.t("server.config.empty_file", { defaultValue: "Файл пуст" }),
        ),
      ).toBeInTheDocument(),
    );
  });

  // ════════════════════════════════════════════════════════════════════════
  // Edit-in-Users navigation (Phase 3 gap-fill)
  // ════════════════════════════════════════════════════════════════════════

  it("credentials «Редактировать в Пользователях» calls onNavigateToTab('users') + logs", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    const onNavigateToTab = vi.fn();
    renderTab({ onNavigateToTab });
    const credTrigger = await screen.findByRole("button", {
      name: /credentials\.toml/i,
    });
    fireEvent.click(credTrigger);
    const editBtn = await screen.findByRole("button", {
      name: i18n.t("server.config.edit_in_users", {
        defaultValue: "Редактировать в Пользователях",
      }),
    });
    fireEvent.click(editBtn);
    expect(onNavigateToTab).toHaveBeenCalledWith("users");
    // Navigation is recorded in the activity log (not the credential value).
    expect(mockActivityLog).toHaveBeenCalledWith(
      "USER",
      "config.navigate.users",
      "ConfigurationTab",
    );
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

  it("only the edit-in-users button lives under the credentials accordion", async () => {
    mockInvoke.mockResolvedValueOnce(MOCK_BUNDLE);
    renderTab();
    const credTrigger = await screen.findByRole("button", {
      name: /credentials\.toml/i,
    });
    fireEvent.click(credTrigger);
    const editBtn = await screen.findByRole("button", {
      name: i18n.t("server.config.edit_in_users", {
        defaultValue: "Редактировать в Пользователях",
      }),
    });
    // The edit button is scoped to the credentials region; vpn/hosts/rules do
    // not get one. Sanity-check there is exactly one edit-in-users button.
    const allEdit = screen.getAllByRole("button", {
      name: i18n.t("server.config.edit_in_users", {
        defaultValue: "Редактировать в Пользователях",
      }),
    });
    expect(allEdit).toHaveLength(1);
    expect(within(document.body).getByText(/credentials\.toml/i)).toBeInTheDocument();
    expect(editBtn).toBeInTheDocument();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Phase 04 Plan 15 — Config H-1 regression (reload() has no cancellation guard).
  // audit/03-configuration.md H-1: the imperative reload() (Retry button) did NOT
  // use the `cancelled` pattern the mount-load effect uses. If the user switches
  // servers (sshParams change) while a manual reload is still in flight, the late
  // resolution carries STALE data from the OLD server — and without a guard it
  // overwrites the freshly-loaded new-server bundle. Both loaders now share one
  // cancellation token so the sshParams-change effect cleanup drops the stale
  // reload. Fixed regression-test-first (D-02 rail).
  // ══════════════════════════════════════════════════════════════════════════
  it("H-1: a manual reload from the OLD server is dropped after sshParams change", async () => {
    const PARAMS_A = { host: "server-a", port: "22", user: "u", password: "p" };
    const PARAMS_B = { host: "server-b", port: "22", user: "u", password: "p" };
    const staleBundle = makeBundle({ vpnToml: "stale_from_server_a = true" });
    const freshBundle = makeBundle({ vpnToml: "fresh_from_server_b = true" });

    // Mount against server A: load fails → error state with a Retry button.
    mockInvoke.mockRejectedValueOnce(new Error("SSH_FAILED"));
    const { rerender } = render(
      <SnackBarProvider>
        <ConfirmDialogProvider>
          <ConfigurationTab sshParams={PARAMS_A} onNavigateToTab={vi.fn()} />
        </ConfirmDialogProvider>
      </SnackBarProvider>,
    );
    const retryBtn = await screen.findByRole("button", {
      name: /Повторить|Попробовать снова/i,
    });

    // Click Retry → manual reload against server A, held pending (skeleton).
    let resolveStale: (b: typeof staleBundle) => void = () => {};
    mockInvoke.mockImplementationOnce(
      () => new Promise((res) => { resolveStale = res; }),
    );
    fireEvent.click(retryBtn);

    // User switches to server B → mount effect re-runs and loads B's bundle.
    mockInvoke.mockResolvedValueOnce(freshBundle);
    await act(async () => {
      rerender(
        <SnackBarProvider>
          <ConfirmDialogProvider>
            <ConfigurationTab sshParams={PARAMS_B} onNavigateToTab={vi.fn()} />
          </ConfirmDialogProvider>
        </SnackBarProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /vpn\.toml/i })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /vpn\.toml/i }));
    await waitFor(() =>
      expect(screen.getByText((c) => c.includes("fresh_from_server_b"))).toBeInTheDocument(),
    );

    // The server-A reload resolves LATE. The shared cancellation token (flipped by
    // the sshParams-change cleanup) must drop it — server B's content stays.
    await act(async () => {
      resolveStale(staleBundle);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      screen.queryByText((c) => c.includes("stale_from_server_a")),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText((c) => c.includes("fresh_from_server_b")),
    ).toBeInTheDocument();
  });
});
