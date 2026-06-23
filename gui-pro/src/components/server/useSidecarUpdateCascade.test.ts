/**
 * useSidecarUpdateCascade — characterization tests (Phase 04 Plan 09 Task 1).
 *
 * Pins the CURRENT observable cascade behavior of the single-owner hook so the
 * Task-2 wiring (orchestrator calls it exactly once, children read via props)
 * cannot drift the cascade. The hook consolidates the sidecar-version probe +
 * the update-progress listener into ONE owner (D-05, Pattern 3 — consolidate,
 * never re-probe).
 *
 * Behavior pinned:
 *   1. single update-progress listener — the hook registers EXACTLY ONE
 *      `update-protocol-step` listener (it is the single owner; the dead
 *      `void useUpdateProgress()` in ProtocolUpdateSection is removed).
 *   2. availability derivation — `localSidecarAvailable` is false at latest /
 *      with no serverInfoVersion, true on a downgrade (serverInfo < latest).
 *   3. net visibility — `sidecarUpdateVisible` mirrors availability and is
 *      forwarded to `onSidecarUpdateChange`.
 *   4. dismiss — `handleSidecarUpdateSeen` dismisses the GitHub-derived latest
 *      version when an update is visible.
 *   5. server-bound refresh — `checkSidecarForServer` is invoked when creds
 *      become available (Stage 2 detection).
 *
 * Mocks mirror useControlPanelOrchestrator.test.ts so the consolidated hook
 * produces the SAME observable cascade as the inline logic it replaces.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { listen } from "@tauri-apps/api/event";
import { useSidecarUpdateCascade } from "./useSidecarUpdateCascade";
import { type SshCredentials } from "./SshConnectForm";

// Pin the GitHub releases list so the cascade derives latest = "1.0.33".
//
// E-17 (Plan 09-13): the list is deliberately OUT OF PUBLISH ORDER — [0] is the
// OLDER "1.0.30" while the real semver-max "1.0.33" sits mid-list. This proves
// the cascade picks latest via `latestSemver` (semver-max), NOT `versions[0]`
// (GitHub publish order). With the old `githubReleasesCP?.[0]?.version` logic
// latestFromGitHubCP would be "1.0.30" and the downgrade assertions below would
// flip — so this list is a fails-before-fix guard for E-17.
vi.mock("./useSidecarVersions", () => ({
  useSidecarVersions: () => ({
    versions: [
      {
        version: "1.0.30",
        tag: "v1.0.30",
        assetDownloadUrl: "",
        assetSizeBytes: 0,
        publishedAt: "",
      },
      {
        version: "1.0.33",
        tag: "v1.0.33",
        assetDownloadUrl: "",
        assetSizeBytes: 0,
        publishedAt: "",
      },
      {
        version: "1.0.31",
        tag: "v1.0.31",
        assetDownloadUrl: "",
        assetSizeBytes: 0,
        publishedAt: "",
      },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

// Stub useUpdateChecker to prevent real GitHub/SSH calls.
const mockCheckSidecarForServer = vi.fn();
const mockDismissSidecarUpdate = vi.fn();
vi.mock("../../shared/hooks/useUpdateChecker", () => ({
  useUpdateChecker: () => ({
    checkSidecarForServer: mockCheckSidecarForServer,
    dismissSidecarUpdate: mockDismissSidecarUpdate,
  }),
}));

const CREDS: SshCredentials = {
  host: "10.0.0.1",
  port: "22",
  user: "root",
  password: "secret",
};

describe("useSidecarUpdateCascade", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(listen).mockResolvedValue(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("single_update_progress_listener — registers exactly one update-protocol-step listener (single owner)", async () => {
    renderHook(() => useSidecarUpdateCascade({ creds: null }));

    await waitFor(() => {
      expect(listen).toHaveBeenCalledWith(
        "update-protocol-step",
        expect.any(Function),
      );
    });
    const stepListeners = vi
      .mocked(listen)
      .mock.calls.filter((c) => c[0] === "update-protocol-step");
    expect(stepListeners).toHaveLength(1);
  });

  it("derives localSidecarAvailable as the single source: false at latest, true on downgrade", () => {
    const { result } = renderHook(() => useSidecarUpdateCascade({ creds: CREDS }));

    // No serverInfoVersion yet → not available.
    expect(result.current.localSidecarAvailable).toBe(false);
    expect(result.current.sidecarUpdateVisible).toBe(false);

    // Latest installed (1.0.33 === latest) → still no update.
    act(() => result.current.setServerInfoVersion("1.0.33"));
    expect(result.current.localSidecarAvailable).toBe(false);

    // Downgrade (1.0.31 < latest 1.0.33) → update available.
    act(() => result.current.setServerInfoVersion("1.0.31"));
    expect(result.current.localSidecarAvailable).toBe(true);
    expect(result.current.sidecarUpdateVisible).toBe(true);
  });

  it("forwards the net visibility flag to onSidecarUpdateChange (false initially, true on downgrade)", async () => {
    const onSidecarUpdateChange = vi.fn();
    const { result } = renderHook(() =>
      useSidecarUpdateCascade({ creds: CREDS, onSidecarUpdateChange }),
    );

    expect(onSidecarUpdateChange).toHaveBeenCalledWith(false);

    act(() => result.current.setServerInfoVersion("1.0.31"));
    await waitFor(() => expect(onSidecarUpdateChange).toHaveBeenCalledWith(true));
  });

  it("handleSidecarUpdateSeen dismisses the GitHub-derived latest version when an update is visible", () => {
    const { result } = renderHook(() => useSidecarUpdateCascade({ creds: CREDS }));
    act(() => result.current.setServerInfoVersion("1.0.31"));

    act(() => result.current.handleSidecarUpdateSeen());
    expect(mockDismissSidecarUpdate).toHaveBeenCalledWith("1.0.33");
  });

  it("UAT-2: localDismissed reads sessionStorage — a session flag hides the dot, a stale localStorage flag does not", () => {
    // Stale flag from the old permanent (localStorage) scope must NOT suppress
    // the dot — per-launch nudge means only sessionStorage gates visibility.
    localStorage.setItem("tt_dismissed_update_1.0.33", "true");
    const stale = renderHook(() => useSidecarUpdateCascade({ creds: CREDS }));
    act(() => stale.result.current.setServerInfoVersion("1.0.31"));
    expect(stale.result.current.sidecarUpdateVisible).toBe(true);
    stale.unmount();

    // A session-scoped flag for the visible version hides the dot within the
    // session (visit-dismiss timing unchanged).
    sessionStorage.setItem("tt_dismissed_update_1.0.33", "true");
    const dismissed = renderHook(() => useSidecarUpdateCascade({ creds: CREDS }));
    act(() => dismissed.result.current.setServerInfoVersion("1.0.31"));
    expect(dismissed.result.current.localSidecarAvailable).toBe(true);
    expect(dismissed.result.current.sidecarUpdateVisible).toBe(false);
  });

  it("E-17: derives latest by semver-max (latestFromGitHubCP), not GitHub publish order [0]", () => {
    const { result } = renderHook(() => useSidecarUpdateCascade({ creds: CREDS }));

    // The mocked list is ["1.0.30","1.0.33","1.0.31"] — [0] is the OLDER 1.0.30.
    // latestFromGitHubCP must be the semver-max 1.0.33, NOT versions[0].
    expect(result.current.latestFromGitHubCP).toBe("1.0.33");

    // A server on 1.0.32 (newer than [0]=1.0.30 but older than max 1.0.33) must
    // still show an update — this only holds when latest is the semver-max.
    act(() => result.current.setServerInfoVersion("1.0.32"));
    expect(result.current.localSidecarAvailable).toBe(true);
  });

  it("E-10: resets serverInfoVersion and clears availability when creds become null (disconnect / host-switch)", () => {
    const { result, rerender } = renderHook(
      ({ creds }: { creds: SshCredentials | null }) =>
        useSidecarUpdateCascade({ creds }),
      { initialProps: { creds: CREDS as SshCredentials | null } },
    );

    // Connected with an older server version → an update is available.
    act(() => result.current.setServerInfoVersion("1.0.31"));
    expect(result.current.localSidecarAvailable).toBe(true);

    // Disconnect (creds → null): the cascade must reset serverInfoVersion so the
    // dot does not stay lit for a server the user has left.
    rerender({ creds: null });
    expect(result.current.serverInfoVersion).toBe("");
    expect(result.current.localSidecarAvailable).toBe(false);
  });

  it("checkSidecarForServer fires Stage-2 refresh when creds become available", async () => {
    const { rerender } = renderHook(
      ({ creds }: { creds: SshCredentials | null }) =>
        useSidecarUpdateCascade({ creds }),
      { initialProps: { creds: null as SshCredentials | null } },
    );

    expect(mockCheckSidecarForServer).not.toHaveBeenCalled();

    rerender({ creds: CREDS });

    await waitFor(() => {
      expect(mockCheckSidecarForServer).toHaveBeenCalledWith({
        host: "10.0.0.1",
        port: 22,
        user: "root",
        password: "secret",
        keyPath: undefined,
      });
    });
  });
});
