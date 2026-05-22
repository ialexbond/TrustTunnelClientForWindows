import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Phase 19 Plan 19-03 — frontend mirror of backend `SidecarReleaseInfo`
 * (camelCase, matching `#[serde(rename_all = "camelCase")]` on Rust struct
 * `gui-pro/src-tauri/src/commands/updater.rs:413`).
 *
 * Fields are intentionally identical to backend wire shape so the result
 * of `invoke<SidecarReleaseInfo[]>(...)` deserializes without further mapping.
 */
export interface SidecarReleaseInfo {
  /** Semver-only string with leading `v` stripped, e.g. `"1.0.33"`. */
  version: string;
  /** Original GitHub `tag_name` with `v` prefix preserved, e.g. `"v1.0.33"`. */
  tag: string;
  /** Validated GitHub download URL for the `x86_64` non-dbgsym tarball asset. */
  assetDownloadUrl: string;
  /** Size in bytes of the selected asset (informational). */
  assetSizeBytes: number;
  /** ISO timestamp from `release.published_at`; empty string if missing. */
  publishedAt: string;
}

/**
 * SSH connection parameters consumed by Plan 19-03 ProtocolUpdateSection.
 *
 * NOTE: `useSidecarVersions` does NOT call any SSH backend command — it
 * only invokes the pure GitHub-API command `list_sidecar_versions`. The
 * `sshParams` argument is kept for two reasons:
 *
 *   1. **API symmetry** with `useUpdateChecker(sshParams)` / `useBbrState`
 *      so the consumer (`ProtocolUpdateSection`) can pass through the same
 *      object shape it gets from `useServerState`.
 *   2. **Future caching key** — when `tt_last_update_check_<host>` per-host
 *      caching is added (deferred from Plan 19-03), the host field will key
 *      the localStorage entry. Wiring the param now avoids a breaking change.
 *
 * The hook treats `sshParams === null` as a "not yet connected" signal and
 * short-circuits — no invoke fires, no state update, default empty result.
 *
 * Shape matches `gui-pro/src/components/server/useServerState.ts` SshParams
 * (NO `keyData` field — that field exists only in the `update` module
 * variant). Hook accepts only what it actually uses.
 */
export interface SshParams {
  host: string;
  port: number;
  user: string;
  password: string;
  keyPath?: string;
}

export interface UseSidecarVersionsResult {
  /** Last successful fetch result; empty array on initial mount or error. */
  versions: SidecarReleaseInfo[];
  /** True while a fetch is in flight (initial or refresh). */
  loading: boolean;
  /**
   * Opaque error code from backend (e.g. `"UPDATE_CHECK_FAILED"`) or `null`.
   * Frontend treats this as a silent-failure flag — no toast, no SnackBar
   * (per Plan 19 D-4.4). Consumer renders fallback UI based on state.
   */
  error: string | null;
  /** Triggers a fresh fetch, replacing existing state on success. */
  refresh: () => Promise<void>;
}

/**
 * **`useSidecarVersions(sshParams)` — Plan 19-03 standalone hook.**
 *
 * Returns up to 3 most recent `TrustTunnel/TrustTunnel` GitHub releases (as
 * a `SidecarReleaseInfo[]`) for consumption by `ProtocolUpdateSection`
 * dropdown (Plan 19-03 Task 2). Wraps the backend Tauri command
 * `list_sidecar_versions` from Plan 19-01 (`maxCount: 3`).
 *
 * ## Why a separate hook (Pitfall 6 mitigation)
 *
 * `useUpdateChecker` (Phase 18) already returns a singular `sidecarLatestVersion`
 * + `sidecarCurrentVersion` per server connect. Extending it to also return an
 * array would couple the two responsibilities and risk regression on the 22
 * existing AboutPanel / TabNavigation tests that depend on its frozen
 * single-version contract.
 *
 * Instead: this hook lives next to its sole consumer (`ProtocolUpdateSection`),
 * exposes a minimal `{ versions, loading, error, refresh }` surface, and runs
 * independently of `useUpdateChecker` polling. See `19-RESEARCH.md` §Pitfall 6
 * for the full rationale.
 *
 * ## D-29 invariant (REQ-19-D29-EXTENDED)
 *
 * Asset URLs, tag values, and SSH passwords NEVER reach:
 *
 *   - `activity.log` (this hook does not import `useActivityLog`)
 *   - Any Tauri event channel (no `emit_log_*` paths)
 *   - `console.warn` payloads beyond the opaque error code
 *
 * The error path only forwards the backend's opaque `"UPDATE_CHECK_FAILED"`
 * string into `console.warn`. Test `d29_no_url_in_warn` enforces this.
 *
 * ## Cleanup on unmount
 *
 * `cancelledRef` short-circuits the post-await `setState` if the consumer
 * unmounted mid-fetch. Without it React would log "Can't perform a state
 * update on an unmounted component" — same pattern as Phase 14.1 WR-03 fix.
 *
 * @example
 * ```tsx
 * const { versions, loading, error, refresh } = useSidecarVersions(sshParams);
 * ```
 */
export function useSidecarVersions(
  sshParams: SshParams | null,
): UseSidecarVersionsResult {
  const [versions, setVersions] = useState<SidecarReleaseInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Phase 14.1 WR-03 carry-forward: short-circuit setState after unmount.
  // Guarded inside the async refresh() body via `if (cancelledRef.current) return`.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // Capture the connected status of sshParams once per render — the actual
  // `host`/`port` values are NOT a dependency (refresh fetches global GitHub
  // releases regardless of which server is connected). Only "is the consumer
  // attached to a server at all" matters for the initial fetch.
  const connected = sshParams !== null;

  const refresh = useCallback(async () => {
    if (cancelledRef.current) return;

    setLoading(true);
    setError(null);

    try {
      // Phase 19 frozen contract — `maxCount: 3` (Plan 19-01 backend cap = 10).
      // Plan 19-03 dropdown shows current + last 3 = max 4 items after frontend
      // dedup; backend-capped at 10 to defend against frontend tampering.
      const result = await invoke<SidecarReleaseInfo[]>("list_sidecar_versions", {
        maxCount: 3,
      });
      if (cancelledRef.current) return;
      // Defensive: mocked/unknown backends may return null/undefined; coerce to [].
      // Without this, downstream `versions[0]` would throw "Cannot read property
      // '0' of null" — happens e.g. in ControlPanelPage tests whose default invoke
      // mock returns null for unrecognised commands.
      setVersions(Array.isArray(result) ? result : []);
    } catch (e) {
      if (cancelledRef.current) return;
      // D-29 invariant: only the opaque error code is logged. The backend
      // (`gui-pro/src-tauri/src/commands/updater.rs::list_sidecar_versions`)
      // returns `"UPDATE_CHECK_FAILED"` for every failure path — no URL leak.
      // We still convert to String() defensively in case the SDK ever bubbles
      // up a richer error shape; the test `d29_no_url_in_warn` enforces that
      // GitHub URL fragments never surface here.
      const code = typeof e === "string" ? e : "UPDATE_CHECK_FAILED";
      // D-4.4 silent fail; DevTools-only visibility (no toast, no SnackBar).
      console.warn("[useSidecarVersions] list failed:", code);
      setError(code);
    } finally {
      if (!cancelledRef.current) {
        setLoading(false);
      }
    }
  }, []);

  // Initial fetch on mount (when connected). Re-runs only if connected status
  // flips — actual sshParams field changes do NOT re-fire because the GitHub
  // API call is server-independent. Per-host caching (deferred) would change this.
  useEffect(() => {
    if (!connected) return;
    void refresh();
  }, [connected, refresh]);

  return { versions, loading, error, refresh };
}
