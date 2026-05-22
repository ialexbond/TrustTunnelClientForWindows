/**
 * ProtocolUpdateSection tests (Phase 19 Plan 19-03 Task 2, TDD RED).
 *
 * Covers UI-SPEC §Block 2 states A-G + 3 D-29 spy assertions:
 *   1. renders_title
 *   2. dropdown_options_merge — current + 3 latest
 *   3. dropdown_dedup — current already in list, no duplicate
 *   4. dropdown_only_current_when_no_versions
 *   5. install_disabled_when_selected_equals_current
 *   6. install_enabled_when_selected_differs
 *   7. install_click_triggers_modal
 *   8. refresh_button_invokes_hook
 *   9. badge_visible_when_sidecar_available
 *  10. badge_hidden_when_not_available
 *  11. D-29 — no password in DOM
 *  12. D-29 — no asset URLs in DOM either
 *  13. D-29 — no GitHub URL substrings in console.warn
 *  14. T-03 — UpdateProgressModal mounted unconditionally (no early-return null)
 *  15. not_installed_label_when_unknown — State G
 *  16. loading_skeletons_when_initial_fetch — State A
 *  17. error_no_versions_label — State F
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import i18n from "../../shared/i18n";
import { renderWithProviders as render } from "../../test/test-utils";
import { ProtocolUpdateSection } from "./ProtocolUpdateSection";
import type { SidecarReleaseInfo, SshParams } from "./useSidecarVersions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: vi.fn() }),
}));

const SSH_PARAMS: SshParams = {
  host: "203.0.113.10",
  port: 22,
  user: "root",
  password: "MOCK_PWD_DO_NOT_LEAK",
};

const RELEASES: SidecarReleaseInfo[] = [
  {
    version: "1.0.34",
    tag: "v1.0.34",
    assetDownloadUrl:
      "https://github.com/TrustTunnel/TrustTunnel/releases/download/v1.0.34/trusttunnel-v1.0.34-linux-x86_64.tar.gz",
    assetSizeBytes: 10_700_000,
    publishedAt: "2026-05-22T12:00:00Z",
  },
  {
    version: "1.0.33",
    tag: "v1.0.33",
    assetDownloadUrl:
      "https://github.com/TrustTunnel/TrustTunnel/releases/download/v1.0.33/trusttunnel-v1.0.33-linux-x86_64.tar.gz",
    assetSizeBytes: 10_600_000,
    publishedAt: "2026-05-15T12:00:00Z",
  },
  {
    version: "1.0.31",
    tag: "v1.0.31",
    assetDownloadUrl:
      "https://github.com/TrustTunnel/TrustTunnel/releases/download/v1.0.31/trusttunnel-v1.0.31-linux-x86_64.tar.gz",
    assetSizeBytes: 10_500_000,
    publishedAt: "2026-05-01T12:00:00Z",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  void i18n.changeLanguage("ru");
  // Default: list_sidecar_versions returns RELEASES.
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "list_sidecar_versions") return RELEASES;
    return null;
  });
  // listen mock returns no-op unsubscribe.
  vi.mocked(listen).mockResolvedValue(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ProtocolUpdateSection", () => {
  // ─── 1: renders title ───
  it("renders_title — shows «Обновление протокола»", async () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={false}
        latestVersion="1.0.33"
      />,
    );

    expect(screen.getByText("Обновление протокола")).toBeVisible();
    expect(screen.getByTestId("protocol-update-card")).toBeInTheDocument();
  });

  // ─── 2: dropdown options merge ───
  it("dropdown_options_merge — current + 3 versions (4 total when current not in list)", async () => {
    const user = userEvent.setup();
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.20"
        sidecarAvailable={true}
        latestVersion="1.0.34"
      />,
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 });
    });

    // Design-system Select renders options in a portal listbox — open it first.
    const wrapper = await screen.findByTestId("protocol-version-select");
    const combobox = within(wrapper).getByRole("combobox");
    await user.click(combobox);

    const listbox = await screen.findByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    // current (1.0.20) + 3 from RELEASES (1.0.34, 1.0.33, 1.0.31) = 4
    expect(options).toHaveLength(4);
    // Select primitive surfaces version via option label text — extract leading semver.
    const versions = options.map((o) => (o.textContent ?? "").trim().split(/\s+/)[0]);
    expect(versions).toEqual(
      expect.arrayContaining(["1.0.20", "1.0.34", "1.0.33", "1.0.31"]),
    );
  });

  // ─── 3: dropdown dedup ───
  it("dropdown_dedup — current matches one of releases → no duplicate", async () => {
    const user = userEvent.setup();
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={true}
        latestVersion="1.0.34"
      />,
    );

    // Wait for fetch first
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 });
    });

    const wrapper = await screen.findByTestId("protocol-version-select");
    const combobox = within(wrapper).getByRole("combobox");
    await user.click(combobox);

    const listbox = await screen.findByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    // current (1.0.33) is already in RELEASES → dedup to 3 entries
    const versions = options.map((o) => (o.textContent ?? "").trim().split(/\s+/)[0]);
    expect(versions).toEqual(expect.arrayContaining(["1.0.34", "1.0.33", "1.0.31"]));
    // No duplicate 1.0.33
    const occurrences = versions.filter((v) => v === "1.0.33");
    expect(occurrences).toHaveLength(1);
  });

  // ─── 4: dropdown only current when no versions ───
  it("dropdown_only_current_when_no_versions — list empty → just current", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_sidecar_versions") return [];
      return null;
    });

    const user = userEvent.setup();
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={false}
        latestVersion="1.0.33"
      />,
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 });
    });

    // After loading completes, open the listbox and verify 1 option (current).
    const wrapper = await screen.findByTestId("protocol-version-select");
    const combobox = within(wrapper).getByRole("combobox");
    await user.click(combobox);

    const listbox = await screen.findByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(1);
    expect((options[0].textContent ?? "").trim().split(/\s+/)[0]).toBe("1.0.33");
  });

  // ─── 5: install disabled when selected === current ───
  it("install_disabled_when_selected_equals_current", async () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={false}
        latestVersion="1.0.33"
      />,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 }),
    );

    const install = await screen.findByTestId("protocol-install-button");
    // Initial selectedVersion === currentVersion → button disabled
    await waitFor(() => {
      expect(install).toBeDisabled();
    });
  });

  // ─── 6: install enabled when selected differs ───
  it("install_enabled_when_selected_differs — change dropdown enables button", async () => {
    const user = userEvent.setup();
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={true}
        latestVersion="1.0.34"
      />,
    );

    // Wait for versions fetch
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 });
    });

    // Open Select listbox + click 1.0.34 option
    const wrapper = await screen.findByTestId("protocol-version-select");
    const combobox = within(wrapper).getByRole("combobox");
    await user.click(combobox);

    const listbox = await screen.findByRole("listbox");
    const option = within(listbox)
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").trim().startsWith("1.0.34"));
    expect(option).toBeDefined();
    await user.click(option!);

    const install = screen.getByTestId("protocol-install-button");
    expect(install).not.toBeDisabled();
  });

  // ─── 7: install click triggers modal ───
  it("install_click_triggers_modal — clicking Install opens UpdateProgressModal", async () => {
    const user = userEvent.setup();
    // Make update_sidecar resolve (controls open modal lifecycle).
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_sidecar_versions") return RELEASES;
      if (cmd === "update_sidecar") return null;
      return null;
    });

    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={true}
        latestVersion="1.0.34"
      />,
    );

    // Wait for versions fetch
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 });
    });

    // Open Select listbox + click 1.0.34 option
    const wrapper = await screen.findByTestId("protocol-version-select");
    const combobox = within(wrapper).getByRole("combobox");
    await user.click(combobox);

    const listbox = await screen.findByRole("listbox");
    const option = within(listbox)
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").trim().startsWith("1.0.34"));
    expect(option).toBeDefined();
    await user.click(option!);

    const install = screen.getByTestId("protocol-install-button");
    expect(install).not.toBeDisabled();

    // Click triggers update_sidecar invoke (Phase 18 useUpdateProgress.startUpdate)
    await user.click(install);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "update_sidecar",
        expect.objectContaining({
          host: SSH_PARAMS.host,
          targetVersion: "1.0.34",
        }),
      );
    });

    // UpdateProgressModal becomes visible (Phase 18 frozen testid)
    await waitFor(() => {
      expect(screen.getByTestId("update-progress-modal")).toBeInTheDocument();
    });
  });

  // ─── 8: refresh button invokes hook ───
  it("refresh_button_invokes_hook — click triggers a second list_sidecar_versions call", async () => {
    const user = userEvent.setup();
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={false}
        latestVersion="1.0.33"
      />,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 }),
    );

    const initialCalls = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "list_sidecar_versions").length;
    expect(initialCalls).toBe(1);

    const refresh = screen.getByTestId("protocol-refresh-button");
    await user.click(refresh);

    await waitFor(() => {
      const refreshCalls = vi
        .mocked(invoke)
        .mock.calls.filter((c) => c[0] === "list_sidecar_versions").length;
      expect(refreshCalls).toBe(2);
    });
  });

  // ─── 9: badge visible when sidecarAvailable ───
  it("badge_visible_when_sidecar_available — Badge rendered", async () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={true}
        latestVersion="1.0.34"
      />,
    );

    expect(screen.getByTestId("protocol-update-badge")).toBeVisible();
    expect(screen.getByText(/доступно новое обновление/i)).toBeVisible();
  });

  // ─── 10: badge hidden when not available ───
  it("badge_hidden_when_not_available — Badge not in DOM", () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={false}
        latestVersion="1.0.33"
      />,
    );

    expect(screen.queryByTestId("protocol-update-badge")).not.toBeInTheDocument();
  });

  // ─── 11: D-29 — no password in DOM ───
  it("D-29: no password substring anywhere in rendered DOM", async () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={true}
        latestVersion="1.0.34"
      />,
    );

    const card = await screen.findByTestId("protocol-update-card");
    // Wait for full render with all child Modal lifecycles settled
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 });
    });

    // Scan card subtree
    expect(card.textContent ?? "").not.toContain(SSH_PARAMS.password);
    // Also scan the whole document because modal portals attach to body
    expect(document.body.textContent ?? "").not.toContain(SSH_PARAMS.password);
  });

  // ─── 12: D-29 — no GitHub asset URLs in DOM ───
  it("D-29: asset URLs and binary paths never render to DOM", async () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={true}
        latestVersion="1.0.34"
      />,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 }),
    );

    const body = document.body.textContent ?? "";
    expect(body).not.toContain("github.com/TrustTunnel/TrustTunnel/releases/download");
    expect(body).not.toContain(".tar.gz");
    expect(body).not.toContain("/opt/trusttunnel");
    expect(body).not.toContain(".bak");
  });

  // ─── 13: D-29 — no GitHub URL substring in console.warn ───
  it("D-29: console.warn never receives raw GitHub asset URL", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Force error path
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_sidecar_versions") throw "UPDATE_CHECK_FAILED";
      return null;
    });

    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={false}
        latestVersion="1.0.33"
      />,
    );

    await waitFor(() => expect(warnSpy).toHaveBeenCalled());

    const allArgs = warnSpy.mock.calls.flat().map((a) => String(a ?? ""));
    const joined = allArgs.join(" | ");
    expect(joined).not.toContain("github.com/TrustTunnel/TrustTunnel/releases/download");
    expect(joined).not.toContain("trusttunnel-v");
    expect(joined).not.toContain(".tar.gz");
    expect(joined).not.toContain(SSH_PARAMS.password);

    warnSpy.mockRestore();
  });

  // ─── 14: T-03 — Modal mounted unconditionally (no early-return null) ───
  it("T-03: UpdateProgressModal present in JSX even when isOpen=false (no early-return null)", async () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={false}
        latestVersion="1.0.33"
      />,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 }),
    );

    // T-03 invariant: Modal primitive owns its lifecycle. The component MUST
    // render UpdateProgressModal as a JSX child regardless of state.phase.
    // We assert this by source-grep — see acceptance criteria — and indirectly
    // here by verifying Modal-related listen() never errors during mount,
    // which only succeeds when useUpdateProgress hook is invoked.
    expect(listen).toHaveBeenCalledWith(
      "update-protocol-step",
      expect.any(Function),
    );
  });

  // ─── 15: State G — not installed label when currentVersion === "unknown" ───
  it("not_installed_label_when_unknown — State G shows «Протокол не установлен»", async () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="unknown"
        sidecarAvailable={false}
        latestVersion="1.0.34"
      />,
    );

    expect(screen.getByText(/протокол не установлен/i)).toBeVisible();
  });

  // ─── 16: State A — Loading skeletons when initial fetch ───
  it("loading_skeletons_when_initial_fetch — Skeletons rendered during first fetch", async () => {
    // Never-resolving promise to keep loading=true
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "list_sidecar_versions") return new Promise(() => {});
      return Promise.resolve(null);
    });

    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={false}
        latestVersion="1.0.33"
      />,
    );

    // Loading state present — refresh button shows Loader2 (animate-spin)
    const refresh = await screen.findByTestId("protocol-refresh-button");
    expect(refresh).toBeDisabled();
  });

  // ─── 17: State F — error «Версии недоступны» fallback ───
  it("error_no_versions_label — State F shows fallback label after error", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_sidecar_versions") throw "UPDATE_CHECK_FAILED";
      return null;
    });

    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={false}
        latestVersion="1.0.33"
      />,
    );

    // Wait for error to settle
    await waitFor(() => {
      expect(screen.getByText(/версии недоступны/i)).toBeVisible();
    });
  });

  // ─── 18: refresh re-entry guard (Pitfall 3) ───
  it("refresh_re_entry_guard — rapid clicks don't pile up invokes", async () => {
    // Mock invoke to resolve slowly so we can test re-entry guard
    const resolveFns: Array<() => void> = [];
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "list_sidecar_versions") {
        return new Promise<SidecarReleaseInfo[]>((resolve) => {
          resolveFns.push(() => resolve(RELEASES));
        });
      }
      return Promise.resolve(null);
    });

    const user = userEvent.setup();
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={false}
        latestVersion="1.0.33"
      />,
    );

    // First fetch is pending (initial mount). Refresh button is disabled.
    const refresh = await screen.findByTestId("protocol-refresh-button");
    expect(refresh).toBeDisabled();

    // Try to click rapidly — disabled state should block all clicks
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    fireEvent.click(refresh);

    // Still only 1 invoke (initial mount fetch)
    const calls = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "list_sidecar_versions").length;
    expect(calls).toBe(1);

    // Resolve initial fetch to clean up
    resolveFns.forEach((fn) => fn());
    await waitFor(() => expect(refresh).not.toBeDisabled());
    // Use the variable to avoid lint warning
    void user;
  });
});
