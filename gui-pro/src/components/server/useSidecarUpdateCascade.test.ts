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

// Pin latestFromGitHubCP = "1.0.33" deterministically (mirrors the orchestrator test).
vi.mock("./useSidecarVersions", () => ({
  useSidecarVersions: () => ({
    versions: [
      {
        version: "1.0.33",
        tag: "v1.0.33",
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
