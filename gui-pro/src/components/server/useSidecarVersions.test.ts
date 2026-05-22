/**
 * useSidecarVersions hook tests (Phase 19 Plan 19-03 Task 1, TDD RED).
 *
 * Pattern reference: gui-pro/src/shared/hooks/useUpdateChecker.test.ts (Phase 18).
 * Coverage targets:
 *   - Test 1: initial_fetch_on_mount — invoke called with command + maxCount=3
 *   - Test 2: refresh_invokes_again — manual refresh adds 1 invoke call
 *   - Test 3: silent_fail_on_error — console.warn called, no throw, error state set
 *   - Test 4: cleanup_on_unmount — no React warnings after unmount
 *   - Test 5: d29_no_url_in_warn — console.warn never receives raw asset URL string
 *
 * D-29 invariant: hook MUST NOT log asset URLs / paths / GitHub-internal strings
 * to console.warn. Only opaque error code "UPDATE_CHECK_FAILED" passes through.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { useSidecarVersions, type SidecarReleaseInfo } from "./useSidecarVersions";
import type { SshParams } from "./useSidecarVersions";

const SSH_PARAMS: SshParams = {
  host: "203.0.113.10",
  port: 22,
  user: "root",
  password: "test-pass",
};

const RELEASES_OK: SidecarReleaseInfo[] = [
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

describe("useSidecarVersions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── Test 1: initial fetch on mount ───
  it("initial_fetch_on_mount — invokes list_sidecar_versions с maxCount=3", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(RELEASES_OK);

    const { result } = renderHook(() => useSidecarVersions(SSH_PARAMS));

    // Loading starts as true
    expect(result.current.loading).toBe(true);
    expect(result.current.versions).toEqual([]);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Verify Tauri command invoked с правильными args
    expect(invoke).toHaveBeenCalledWith("list_sidecar_versions", { maxCount: 3 });
    expect(invoke).toHaveBeenCalledTimes(1);

    // Versions state populated
    expect(result.current.versions).toEqual(RELEASES_OK);
    expect(result.current.versions).toHaveLength(3);
    expect(result.current.error).toBeNull();
  });

  // ─── Test 2: refresh re-invokes ───
  it("refresh_invokes_again — manual refresh fires a second invoke", async () => {
    vi.mocked(invoke).mockResolvedValue(RELEASES_OK);

    const { result } = renderHook(() => useSidecarVersions(SSH_PARAMS));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(invoke).toHaveBeenCalledTimes(1);

    // Manual refresh
    await act(async () => {
      await result.current.refresh();
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.current.versions).toEqual(RELEASES_OK);
    expect(result.current.error).toBeNull();
  });

  // ─── Test 3: silent fail on error ───
  it("silent_fail_on_error — console.warn called, no throw, error state set", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValueOnce("UPDATE_CHECK_FAILED");

    const { result } = renderHook(() => useSidecarVersions(SSH_PARAMS));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Error state populated с opaque code
    expect(result.current.error).toBe("UPDATE_CHECK_FAILED");
    // Versions remain empty (no partial state)
    expect(result.current.versions).toEqual([]);
    // console.warn called for DevTools visibility
    expect(warnSpy).toHaveBeenCalled();
    // D-4.4 — no Snackbar / toast call (we only have console.warn spy here)

    warnSpy.mockRestore();
  });

  // ─── Test 4: cleanup on unmount ───
  it("cleanup_on_unmount — no React warnings after unmount mid-fetch", async () => {
    // Pending Promise that never resolves before unmount
    let resolveFn: ((value: SidecarReleaseInfo[]) => void) | null = null;
    const pending = new Promise<SidecarReleaseInfo[]>((res) => {
      resolveFn = res;
    });
    vi.mocked(invoke).mockReturnValueOnce(pending as unknown as Promise<unknown>);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result, unmount } = renderHook(() => useSidecarVersions(SSH_PARAMS));

    // Component is mid-fetch
    expect(result.current.loading).toBe(true);

    // Unmount before invoke resolves
    unmount();

    // Resolve invoke after unmount — must NOT trigger setState
    await act(async () => {
      resolveFn?.(RELEASES_OK);
      // Give event loop a tick
      await Promise.resolve();
    });

    // Verify no React state-after-unmount warning logged
    const stateWarnings = errorSpy.mock.calls.filter((args) =>
      String(args[0] ?? "").includes("unmounted"),
    );
    expect(stateWarnings).toHaveLength(0);

    errorSpy.mockRestore();
  });

  // ─── Test 5: D-29 — console.warn never receives raw asset URL ───
  it("d29_no_url_in_warn — error path keeps console.warn payload opaque", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Backend returned error code only (per backend contract — "UPDATE_CHECK_FAILED")
    vi.mocked(invoke).mockRejectedValueOnce("UPDATE_CHECK_FAILED");

    const { result } = renderHook(() => useSidecarVersions(SSH_PARAMS));

    await waitFor(() => expect(result.current.loading).toBe(false));

    // Inspect ALL warn calls — must NOT contain GitHub release asset URL fragments
    const allArgs = warnSpy.mock.calls.flat().map((a) => String(a ?? ""));
    const joined = allArgs.join(" | ");
    expect(joined).not.toContain("github.com/TrustTunnel/TrustTunnel/releases/download");
    expect(joined).not.toContain("trusttunnel-v");
    expect(joined).not.toContain(".tar.gz");
    // Password (D-29 strict) also must not surface
    expect(joined).not.toContain(SSH_PARAMS.password);

    warnSpy.mockRestore();
  });

  // ─── Test 6: null sshParams short-circuits (defensive) ───
  it("null_ssh_params_does_not_invoke — hook gracefully no-ops when params unavailable", async () => {
    const { result } = renderHook(() => useSidecarVersions(null));

    // Wait long enough for any effect to fire
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(result.current.versions).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});
