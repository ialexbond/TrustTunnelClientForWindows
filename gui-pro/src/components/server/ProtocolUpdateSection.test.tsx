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
import { activityLogSpy, expectNoSecretLogged } from "../../test/fixtures";
import { ProtocolUpdateSection } from "./ProtocolUpdateSection";
import type { SidecarReleaseInfo, SshParams } from "./useSidecarVersions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
// D-29 net (09-VALIDATION.md): route the activity-log channel through the shared
// named spy so a test can prove the GitHub release asset URL never reaches it.
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: activityLogSpy }),
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
  activityLogSpy.mockReset();
  // Wipe useSidecarVersions localStorage cache so each test starts with an
  // empty initial state — otherwise tests that need a refresh-fired invoke
  // get a cache short-circuit and the mock is never called.
  localStorage.removeItem("tt_sidecar_versions_cache");
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

  // ─── 9: badge visible when sidecarAvailable (FIXED false green :362) ───
  it("badge_visible_when_sidecar_available — Badge rendered with i18n text scoped to the badge testid", async () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={true}
        latestVersion="1.0.34"
      />,
    );

    // FIX false green :362 — was an unscoped page-wide `/доступно обновление/i`
    // regex that would pass even if the text leaked anywhere else on the page.
    // Now scoped to the actual badge element + asserted against the i18n value
    // (locale-driven, not a hardcoded RU substring).
    const badge = screen.getByTestId("protocol-update-badge");
    expect(badge).toBeVisible();
    expect(badge).toHaveTextContent(
      i18n.t("server.service.protocol.update_available_badge"),
    );
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

    // Loading state present — refresh button disabled (shows Loader2 spinner).
    const refresh = await screen.findByTestId("protocol-refresh-button");
    expect(refresh).toBeDisabled();

    // FIX false green :513 — the original test asserted ONLY the disabled refresh
    // button, which is a weak signal. State A (initial fetch, no versions) must
    // render the action-row Skeletons INSTEAD of the dropdown + install button.
    // Assert the dropdown + install controls are absent so a refactor that leaks
    // a half-dead dropdown during loading flips this red.
    expect(screen.queryByTestId("protocol-version-select")).not.toBeInTheDocument();
    expect(screen.queryByTestId("protocol-install-button")).not.toBeInTheDocument();
  });

  // ─── 17: State F — when GitHub fails AND current is unknown → fallback shown ───
  it("error_no_versions_label — State F shows fallback label when current unknown AND fetch fails", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_sidecar_versions") throw "UPDATE_CHECK_FAILED";
      return null;
    });

    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="unknown"
        sidecarAvailable={false}
        latestVersion=""
      />,
    );

    // Fallback shows only when we have absolutely nothing to put in the
    // dropdown — i.e. no GitHub list and no installed current version.
    await waitFor(() => {
      expect(screen.getByText(/версии недоступны/i)).toBeVisible();
    });
  });

  // ─── 17b: when current IS known but GitHub fetch fails, dropdown still
  //         renders with the installed option — no «Версии недоступны» ───
  it("error_with_known_current — dropdown still usable, no fallback label", async () => {
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

    // Wait for the failed fetch to settle, then assert UX fallback:
    // the dropdown wrapper is rendered (not the «Версии недоступны» label).
    await waitFor(() => {
      expect(screen.getByTestId("protocol-version-select")).toBeInTheDocument();
    });
    expect(screen.queryByText(/версии недоступны/i)).toBeNull();
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

  // ════════════════════════════════════════════════════════════════════════
  // Phase 3 safety-net Stream 5 (Plan 03-06) — KEY cascade gap + remaining gaps
  // ════════════════════════════════════════════════════════════════════════

  // ─── 19 (KEY cascade gap): badge DYNAMIC reactivity via rerender() ───
  //
  // The badge appear/disappear was previously tested STATICALLY only (cases 9 +
  // 10 — two separate renders). The actual REACTIVITY — that flipping
  // `sidecarAvailable` false→true makes the badge APPEAR, and true→false (the
  // post-update state) makes it DISAPPEAR — was never pinned. This is exactly the
  // slice of the Card #8 cascade a Phase 4 refactor could silently break.
  it("badge_dynamic_transition — false→true APPEARS, true→false DISAPPEARS via rerender()", async () => {
    const { rerender } = render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={false}
        latestVersion="1.0.33"
      />,
    );

    // Initial: no update available → badge absent.
    expect(screen.queryByTestId("protocol-update-badge")).not.toBeInTheDocument();

    // An update becomes available (newer GitHub release) → badge APPEARS, scoped
    // to its testid and asserted against the i18n value.
    rerender(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={true}
        latestVersion="1.0.34"
      />,
    );
    const appeared = await screen.findByTestId("protocol-update-badge");
    expect(appeared).toBeVisible();
    expect(appeared).toHaveTextContent(
      i18n.t("server.service.protocol.update_available_badge"),
    );

    // After the update is applied the parent re-probes and `sidecarAvailable`
    // returns to false (now on latest) → badge DISAPPEARS.
    rerender(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.34"
        sidecarAvailable={false}
        latestVersion="1.0.34"
      />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("protocol-update-badge")).not.toBeInTheDocument();
    });
  });

  // ─── 20: caption shows current version (mono) when known ───
  it("caption_shows_current_version — «Текущая версия: 1.0.33» rendered", async () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={false}
        latestVersion="1.0.33"
      />,
    );

    expect(
      screen.getByText(i18n.t("server.service.protocol.current_label_prefix")),
    ).toBeVisible();
    // Installed version value is shown inline (mono).
    expect(screen.getByText("1.0.33")).toBeVisible();
  });

  // ─── 21: caption skeleton while current version still loading ("") ───
  it("caption_skeleton_when_current_loading — empty currentVersion shows skeleton, not version text", async () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        // "" = SSH probe in flight (NOT "unknown" = State G). Component shows a
        // Skeleton in the caption row instead of an empty "Текущая версия: ".
        currentVersion=""
        sidecarAvailable={false}
        latestVersion="1.0.34"
      />,
    );

    // The prefix is still rendered (it's not State G) ...
    expect(
      screen.getByText(i18n.t("server.service.protocol.current_label_prefix")),
    ).toBeVisible();
    // ... but the «не установлен» State-G label is NOT shown (this is loading,
    // not not-installed).
    expect(
      screen.queryByText(i18n.t("server.service.protocol.not_installed_label")),
    ).not.toBeInTheDocument();
  });

  // ─── 22: dropdown option suffixes — installed gets «(установлена)», newer gets «(новая)» ───
  it("dropdown_option_suffixes — installed «(установлена)», newer «(новая)»", async () => {
    const user = userEvent.setup();
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

    const wrapper = await screen.findByTestId("protocol-version-select");
    await user.click(within(wrapper).getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    const labels = options.map((o) => (o.textContent ?? "").trim());

    const installedSuffix = i18n.t("server.service.protocol.current_label_suffix_active");
    const newSuffix = i18n.t("server.service.protocol.current_label_suffix_new");

    // Installed 1.0.33 carries «(установлена)».
    expect(labels.find((l) => l.startsWith("1.0.33"))).toContain(installedSuffix);
    // Newer 1.0.34 carries «(новая)».
    expect(labels.find((l) => l.startsWith("1.0.34"))).toContain(newSuffix);
  });

  // ─── 23: install enabled in State G (current unknown) when a version is selected ───
  it("install_enabled_when_unknown — State G enables Install once a version is selected", async () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="unknown"
        sidecarAvailable={false}
        latestVersion="1.0.34"
      />,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 }),
    );

    // selectedVersion defaults to the newest GitHub release (current is "unknown",
    // so the re-sync effect falls back to versions[0]). Install is enabled.
    const install = await screen.findByTestId("protocol-install-button");
    await waitFor(() => {
      expect(install).not.toBeDisabled();
    });
  });

  // ─── 24: action-row shows Skeleton (no dropdown) while modal open ───
  it("action_row_skeleton_while_modal_open — dropdown + install hidden during in-flight update", async () => {
    const user = userEvent.setup();
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

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 }),
    );

    // Select a newer version + open the install modal.
    const wrapper = await screen.findByTestId("protocol-version-select");
    await user.click(within(wrapper).getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    const option = within(listbox)
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").trim().startsWith("1.0.34"));
    await user.click(option!);
    await user.click(screen.getByTestId("protocol-install-button"));

    // Modal opens → action row swaps to Skeletons: dropdown + install removed.
    await waitFor(() => {
      expect(screen.queryByTestId("protocol-version-select")).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId("protocol-install-button")).not.toBeInTheDocument();
  });

  // ─── 25: refresh button has an accessible label ───
  it("refresh_button_aria_label — refresh button exposes check_update_aria", async () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.33"
        sidecarAvailable={false}
        latestVersion="1.0.33"
      />,
    );

    const refresh = await screen.findByTestId("protocol-refresh-button");
    expect(refresh).toHaveAttribute(
      "aria-label",
      i18n.t("server.service.protocol.check_update_aria"),
    );
  });

  // ─── 26: install button shows disabled-current tooltip when selected === current ───
  it("install_disabled_current_tooltip — title explains why Install is disabled", async () => {
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
    // Initial selectedVersion === currentVersion → disabled with explanatory title.
    await waitFor(() => expect(install).toBeDisabled());
    expect(install).toHaveAttribute(
      "title",
      i18n.t("server.service.protocol.install_disabled_current"),
    );
  });

  // ─── 27: modal success → onSidecarUpdateApplied fires + GitHub list re-fetched ───
  it("modal_success_triggers_callback_and_refresh — onSidecarUpdateApplied + extra list_sidecar_versions", async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn();
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
        onSidecarUpdateApplied={onApplied}
      />,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 }),
    );

    const listCallsBefore = vi
      .mocked(invoke)
      .mock.calls.filter((c) => c[0] === "list_sidecar_versions").length;

    // Open dropdown, pick newer version, click Install → modal opens.
    const wrapper = await screen.findByTestId("protocol-version-select");
    await user.click(within(wrapper).getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    const option = within(listbox)
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").trim().startsWith("1.0.34"));
    await user.click(option!);
    await user.click(screen.getByTestId("protocol-install-button"));

    // Wait for the update_sidecar invoke (the modal drives the lifecycle), then
    // for the success step that fires onSuccess → handleModalSuccess.
    await waitFor(() => {
      expect(onApplied).toHaveBeenCalled();
    });

    // handleModalSuccess also re-fetches the GitHub list (refresh()) so the
    // dropdown «(установлена)» suffix moves to the newly-installed version.
    await waitFor(() => {
      const after = vi
        .mocked(invoke)
        .mock.calls.filter((c) => c[0] === "list_sidecar_versions").length;
      expect(after).toBeGreaterThan(listCallsBefore);
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // Phase 9 Plan 09-20 — E-16 / E-7 / E-8 / §K CTA-03 regression net
  // ════════════════════════════════════════════════════════════════════════

  // ─── E-16: clicking Refresh must NOT snap the chosen version back to the
  //          installed one. The re-sync effect previously listed `versions`
  //          in its deps; a refresh returns a NEW array ref (equal content),
  //          which re-fired the effect → setSelectedVersion(currentVersion).
  it("E-16: refresh preserves the chosen target version (does not snap to installed)", async () => {
    const user = userEvent.setup();
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.31"
        sidecarAvailable={true}
        latestVersion="1.0.34"
      />,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 }),
    );

    // Pick 1.0.34 (a non-installed target) → Install enabled.
    const wrapper = await screen.findByTestId("protocol-version-select");
    await user.click(within(wrapper).getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    const target = within(listbox)
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").trim().startsWith("1.0.34"));
    await user.click(target!);

    const install = screen.getByTestId("protocol-install-button");
    expect(install).not.toBeDisabled();

    // Click Refresh → list_sidecar_versions re-resolves to an equal-content
    // but NEW array instance (mock returns a fresh array each call).
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_sidecar_versions") return [...RELEASES];
      return null;
    });
    await user.click(screen.getByTestId("protocol-refresh-button"));

    await waitFor(() => {
      const calls = vi
        .mocked(invoke)
        .mock.calls.filter((c) => c[0] === "list_sidecar_versions").length;
      expect(calls).toBeGreaterThanOrEqual(2);
    });

    // The pick must survive: Install still enabled, and the Select still shows
    // 1.0.34 as its selected option (assert by combobox value text, never CSS).
    await waitFor(() => {
      expect(screen.getByTestId("protocol-install-button")).not.toBeDisabled();
    });
    const wrapper2 = screen.getByTestId("protocol-version-select");
    const combobox = within(wrapper2).getByRole("combobox");
    expect((combobox.textContent ?? "")).toContain("1.0.34");
  });

  // ─── E-16 positive control: when currentVersion legitimately CHANGES (e.g.
  //          after a successful update + re-probe), the selection follows it. ───
  it("E-16 positive control: a real currentVersion change moves the selection", async () => {
    const { rerender } = render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.31"
        sidecarAvailable={true}
        latestVersion="1.0.34"
      />,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 }),
    );

    // currentVersion changes (parent re-probed after an update) → selection
    // re-syncs to the new installed version, so Install is disabled again.
    rerender(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="1.0.34"
        sidecarAvailable={false}
        latestVersion="1.0.34"
      />,
    );

    const install = await screen.findByTestId("protocol-install-button");
    await waitFor(() => {
      expect(install).toBeDisabled();
    });
    const combobox = within(
      screen.getByTestId("protocol-version-select"),
    ).getByRole("combobox");
    expect((combobox.textContent ?? "")).toContain("1.0.34");
  });

  // ─── E-7: Install must be disabled when the resolved selection is "unknown"
  //          or empty — never install a literal "unknown" version. With an empty
  //          GitHub list (but no fetch error) the dropdown renders with no real
  //          options, so the Install button is present yet DISABLED. ───
  it("E-7: Install disabled when no real version can be selected (unknown + empty list)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_sidecar_versions") return [];
      return null;
    });

    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="unknown"
        sidecarAvailable={false}
        latestVersion=""
      />,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 }),
    );

    // No real version is selectable (empty list, current="unknown") → the
    // Install button must be disabled so a literal "unknown"/empty value can
    // never reach `update_sidecar`.
    const install = await screen.findByTestId("protocol-install-button");
    await waitFor(() => {
      expect(install).toBeDisabled();
    });
  });

  // ─── E-7 positive control: a real list + concrete pick → Install enabled,
  //          and never with a literal "unknown" value. ───
  it("E-7 positive control: a concrete real pick enables Install (value !== 'unknown')", async () => {
    const user = userEvent.setup();
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion="unknown"
        sidecarAvailable={false}
        latestVersion="1.0.34"
      />,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 }),
    );

    // State G: selection defaults to the newest GitHub release (versions[0]).
    const install = await screen.findByTestId("protocol-install-button");
    await waitFor(() => expect(install).not.toBeDisabled());

    const combobox = within(
      screen.getByTestId("protocol-version-select"),
    ).getByRole("combobox");
    // The selected option is a real semver, never the literal "unknown".
    expect((combobox.textContent ?? "")).not.toContain("unknown");
    expect((combobox.textContent ?? "")).toMatch(/1\.0\.3\d/);

    // Picking a concrete version keeps Install enabled.
    await user.click(combobox);
    const listbox = await screen.findByRole("listbox");
    const opt = within(listbox)
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").trim().startsWith("1.0.33"));
    await user.click(opt!);
    expect(screen.getByTestId("protocol-install-button")).not.toBeDisabled();
  });

  // ─── E-8: a FAILED probe ("") must show the loading/retry affordance, NOT the
  //          «Протокол не установлен» caption. Empty string ≠ not-installed —
  //          those are three distinct states ("" loading, "unknown" not
  //          installed, real semver). ───
  it("E-8: failed probe ('') shows loading, NOT the «не установлен» caption", async () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        currentVersion=""
        sidecarAvailable={false}
        latestVersion="1.0.34"
      />,
    );

    // The not-installed caption is reserved for the genuine not-installed signal
    // (currentVersion === "unknown") — never for an in-flight/failed probe ("").
    expect(
      screen.queryByText(i18n.t("server.service.protocol.not_installed_label")),
    ).not.toBeInTheDocument();
    // The loading/retry affordance is present: the «Текущая версия:» prefix is
    // shown (this is not State G), and the Refresh control lets the user retry.
    expect(
      screen.getByText(i18n.t("server.service.protocol.current_label_prefix")),
    ).toBeVisible();
    expect(screen.getByTestId("protocol-refresh-button")).toBeInTheDocument();
  });

  it("E-8 positive control: a genuinely not-installed server shows the caption", () => {
    render(
      <ProtocolUpdateSection
        sshParams={SSH_PARAMS}
        // "unknown" = sidecar binary missing on the server (State G).
        currentVersion="unknown"
        sidecarAvailable={false}
        latestVersion="1.0.34"
      />,
    );

    expect(
      screen.getByText(i18n.t("server.service.protocol.not_installed_label")),
    ).toBeVisible();
  });

  // ─── D-29 (09-VALIDATION.md asset-URL surface): drive the install path so the
  //          GitHub release asset/download URL flows through, then prove it
  //          never reaches the activity-log channel. ───
  it("D-29: the GitHub release asset URL never reaches the activity-log channel", async () => {
    const user = userEvent.setup();
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

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 }),
    );

    // Pick a newer release (its asset URL is in RELEASES) + kick off the install.
    const wrapper = await screen.findByTestId("protocol-version-select");
    await user.click(within(wrapper).getByRole("combobox"));
    const listbox = await screen.findByRole("listbox");
    const option = within(listbox)
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").trim().startsWith("1.0.34"));
    await user.click(option!);
    await user.click(screen.getByTestId("protocol-install-button"));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "update_sidecar",
        expect.objectContaining({ targetVersion: "1.0.34" }),
      );
    });

    // The asset/download URL must be ABSENT from every activity-log call.
    const assetUrl = RELEASES[0].assetDownloadUrl;
    expectNoSecretLogged(assetUrl);
    expectNoSecretLogged("github.com/TrustTunnel/TrustTunnel/releases/download");
    expectNoSecretLogged(".tar.gz");
    // And the SSH password never leaks into the log channel either.
    expectNoSecretLogged(SSH_PARAMS.password);
  });

  // ─── §K CTA-03: the version Install confirm uses an action-verb label
  //          («Установить» / downgrade «Установить старую версию»), not the
  //          generic «Подтвердить». This confirm lives in VersionSection (the
  //          SSH version surface) — asserted in VersionSection.test.tsx. Here we
  //          pin the i18n keys exist with the expected RU values so the locale
  //          contract for CTA-03 is covered in this file's surface too. ───
  it("§K CTA-03: the install-confirm action labels are defined (ru)", () => {
    expect(i18n.t("server.version.confirm_install")).toBe("Установить");
    expect(i18n.t("server.version.confirm_install_downgrade")).toBe(
      "Установить старую версию",
    );
  });
});
