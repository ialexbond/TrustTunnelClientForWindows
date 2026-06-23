import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Package, RefreshCw, Loader2 } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Badge } from "../../shared/ui/Badge";
import { Skeleton } from "../../shared/ui/Skeleton";
import { Select } from "../../shared/ui/Select";
import { UpdateProgressModal } from "../update/UpdateProgressModal";
import {
  useSidecarVersions,
  type SidecarReleaseInfo,
  type SshParams,
} from "./useSidecarVersions";
import { compareSemver } from "../../shared/utils/compareSemver";

/**
 * Phase 19 Plan 19-03 — `ProtocolUpdateSection`.
 *
 * Card-style section rendered as the 4th block inside `ServiceTabSection`
 * (between Benchmark and Logs per UI-SPEC §Mount Location). Provides:
 *
 *   - **Header row** — Package icon (accent-interactive) + title + Badge
 *     («Доступно новое обновление», visible only when `sidecarAvailable`)
 *     + Refresh icon button (RefreshCw → Loader2 spinner during fetch)
 *   - **Caption row** — «Текущая версия: {version}» with mono version inline
 *   - **Action row** — `Select` dropdown from design system (max 4 options:
 *     current + last 3) and «Установить» button (disabled when selected === current)
 *   - **State A (Loading)** — Skeleton placeholders for dropdown + button
 *   - **State F (Error)** — «Версии недоступны» caption fallback
 *   - **State G (Not installed)** — «Протокол не установлен» caption
 *
 * ## T-03 invariant (Phase 14 finding #10)
 *
 * `UpdateProgressModal` is mounted unconditionally as a JSX child — the
 * primitive owns its mount/unmount lifecycle via `mounted` + `animating`
 * state. Never early-return `null` before reaching the Modal in the tree.
 * See Modal.tsx JSDoc for the canonical pattern.
 *
 * ## D-29 invariant (REQ-19-D29-EXTENDED)
 *
 * The component never renders sshParams.password to the DOM, never logs
 * GitHub asset URLs to console.warn, and never reaches `activityLog`. Asset
 * URLs from `useSidecarVersions` are kept opaque — only `version` and `tag`
 * are shown in dropdown options (no URL/path leakage into UI). Modal lifecycle
 * delegates to Phase 18 `UpdateProgressModal` which has its own D-29 spy.
 *
 * ## Pitfall 6 — separate hook
 *
 * Consumes `useSidecarVersions` (Plan 19-03 Task 1) instead of extending
 * `useUpdateChecker`. The parent component (`ControlPanelPage`) still uses
 * `useUpdateChecker(sshParams)` for `sidecarAvailable` and `sidecarCurrentVersion`
 * — those flow in as props.
 */

export interface ProtocolUpdateSectionProps {
  sshParams: SshParams;
  /** From `useUpdateChecker.sidecarCurrentVersion`; pass "unknown" for State G. */
  currentVersion: string;
  /** Controls Badge visibility (D-2.1) + default selectedVersion behavior. */
  sidecarAvailable: boolean;
  /** From `useUpdateChecker.sidecarLatestVersion`; may equal currentVersion. */
  latestVersion: string;
  /**
   * Phase 19 cascade fix — called after `update_sidecar` succeeds. Parent
   * (`ControlPanelPage` via prop-drill) re-invokes `checkSidecarForServer`
   * so `useUpdateChecker.sidecarCurrentVersion` reflects the live post-update
   * value via SSH probe. Without this, Overview Card #8 / bottom-tab dots /
   * ServerTabs dot / Badge all keep showing the stale pre-update comparison
   * because the frontend has no other trigger to re-probe the server's
   * `trusttunnel_endpoint --version`.
   */
  onSidecarUpdateApplied?: () => void;
}

/**
 * Format a dropdown option label per the updated UX (label semantics):
 *
 *   - opt is the currently INSTALLED version → `"1.0.31 (установлена)"`
 *   - opt is newer than installed (per semver) → `"1.0.33 (новая)"`
 *   - everything else (older / downgrade target) → bare `"1.0.29"`
 *
 * NOTE: «установлена» != «актуальная». «Актуальная» semantically means
 * «latest on GitHub», not «what's running on the server». Earlier this label
 * was on the installed version, which is misleading (e.g. when installed
 * 1.0.31 was tagged «актуальная» while GitHub already had 1.0.33).
 */
function formatOptionLabel(
  opt: SidecarReleaseInfo,
  currentVersion: string,
  suffixInstalled: string,
  suffixNew: string,
): string {
  if (opt.version === currentVersion) {
    return `${opt.version} ${suffixInstalled}`;
  }
  // Direction: shared compareSemver is ASCENDING (positive when a > b). The
  // former descending compareSemverDesc(opt, current) < 0 meant "opt is newer
  // than current"; the ascending equivalent is `> 0`.
  if (compareSemver(opt.version, currentVersion) > 0) {
    return `${opt.version} ${suffixNew}`;
  }
  return opt.version;
}

export function ProtocolUpdateSection({
  sshParams,
  currentVersion,
  sidecarAvailable,
  latestVersion: _latestVersion,
  onSidecarUpdateApplied,
}: ProtocolUpdateSectionProps) {
  const { t } = useTranslation();
  const { versions, loading, error, refresh } = useSidecarVersions(sshParams);

  // Service C-01 / D-05: the dead `void useUpdateProgress()` 2nd
  // `update-protocol-step` listener was removed here. The single cascade-level
  // listener now lives in `useSidecarUpdateCascade` (orchestrator-owned), and
  // the `UpdateProgressModal` rendered below still owns its OWN modal-scoped
  // `useUpdateProgress` instance for the live update flow — so the
  // `update-protocol-step` listener is registered exactly where it is needed,
  // never as a forever-mounted dead subscription on the Service tab.

  // Three distinct states for `currentVersion`:
  //   - `""` (empty string) — `useUpdateChecker` initial value, before SSH probe
  //     completes (or after a failed probe). Treat as "loading current" — show
  //     a Skeleton in the caption row instead of an empty "Текущая версия: ".
  //   - `"unknown"` — sidecar binary missing on the server (State G).
  //   - otherwise — real semver like `"1.0.31"`.
  const isUnknown = currentVersion === "unknown";
  const isCurrentLoading = !isUnknown && !currentVersion;

  // Dropdown selected version — defaults to currentVersion (or latest from
  // GitHub when current is still loading). Re-syncs on either prop change.
  const [selectedVersion, setSelectedVersion] = useState<string>(currentVersion);
  // Local modal control — open when Install clicked, closed on success (300ms delay) / Close.
  const [modalOpen, setModalOpen] = useState(false);
  // Track refresh re-entry (Pitfall 3 guard).
  const [refreshing, setRefreshing] = useState(false);

  // E-16 fix: re-sync the pick ONLY when `currentVersion` actually changes
  // (e.g. after a successful update + re-probe), NOT on every `versions`
  // identity change. The previous effect listed `versions` in its deps; a
  // Refresh re-fetches `list_sidecar_versions` and `useSidecarVersions` returns
  // a NEW array ref (equal content), which re-fired the effect and reset
  // `selectedVersion` back to the installed `currentVersion` — silently
  // discarding the user's chosen target version on Refresh.
  //
  // We track the last currentVersion we synced against in a ref. The effect
  // still runs on `versions` changes (needed to seed the default while
  // currentVersion is loading ""), but the `currentVersion`-driven re-sync
  // fires only on a genuine currentVersion transition.
  const lastSyncedCurrentRef = useRef<string | null>(null);
  useEffect(() => {
    // A real installed version ("1.0.31") snaps the pick to it; "" (loading) and
    // "unknown" (State G, not installed) instead seed the newest GitHub release
    // so the Select has a sensible default and E-7 never leaves "unknown" as the
    // selected/installable value.
    const isReal = !!currentVersion && currentVersion !== "unknown";
    if (isReal) {
      // Only snap to the installed version when currentVersion itself changed —
      // a Refresh that leaves currentVersion untouched must preserve the pick.
      if (lastSyncedCurrentRef.current !== currentVersion) {
        lastSyncedCurrentRef.current = currentVersion;
        setSelectedVersion(currentVersion);
      }
    } else if (versions.length > 0) {
      // currentVersion loading ("") or not-installed ("unknown"): seed the
      // newest GitHub release ONCE so the Select shows a sensible default
      // instead of an empty placeholder. Guard with the ref so a Refresh
      // doesn't keep re-seeding over the user's pick.
      if (lastSyncedCurrentRef.current === null) {
        lastSyncedCurrentRef.current = currentVersion; // "" or "unknown"
        setSelectedVersion(versions[0].version);
      }
    }
  }, [currentVersion, versions]);

  // Build dropdown options — current (when known) + last 3 from GitHub, dedup,
  // sorted descending by semver so the newest release sits at the top.
  // When `currentVersion` is `""` (still loading) we just rely on the GitHub
  // versions list — the installed slot will be added once it arrives via
  // prop refresh.
  const dropdownOptions = useMemo<SidecarReleaseInfo[]>(() => {
    const map = new Map<string, SidecarReleaseInfo>();
    if (currentVersion && currentVersion !== "unknown") {
      map.set(currentVersion, {
        version: currentVersion,
        tag: `v${currentVersion}`,
        assetDownloadUrl: "",
        assetSizeBytes: 0,
        publishedAt: "",
      });
    }
    versions.slice(0, 3).forEach((v) => {
      if (!map.has(v.version)) {
        map.set(v.version, v);
      }
    });
    // Descending sort (newest first). Shared compareSemver is ASCENDING, so
    // swap the arguments to keep the newest release at the top of the dropdown.
    return Array.from(map.values()).sort((a, b) =>
      compareSemver(b.version, a.version),
    );
  }, [versions, currentVersion]);

  // Install button enable rule:
  //   - State G (unknown current): enabled if a REAL version is selected
  //   - Loading current (""): enabled if a REAL version is selected — user can
  //     still kick off an install even if we haven't yet pinned what's running
  //   - Normal: enabled if selected !== current AND not currently updating
  //
  // E-7 fix: the selected version must be a REAL release present in the
  // dropdown options and never the literal "unknown" / empty string. Without
  // this gate a State-G default of "unknown" (or a stale empty pick) could
  // reach `update_sidecar` with `targetVersion: "unknown"` and install a
  // bogus version.
  const isRealSelection =
    !!selectedVersion &&
    selectedVersion !== "unknown" &&
    dropdownOptions.some((o) => o.version === selectedVersion);
  const isSelectedCurrent =
    !isUnknown && !isCurrentLoading && selectedVersion === currentVersion;
  const installEnabled = !isSelectedCurrent && isRealSelection && !modalOpen;

  // Refresh handler with Pitfall 3 re-entry guard.
  const handleRefresh = useCallback(async () => {
    if (refreshing || loading) return;
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, loading, refresh]);

  const handleInstall = useCallback(() => {
    if (!installEnabled) return;
    setModalOpen(true);
  }, [installEnabled]);

  const handleModalClose = useCallback(() => {
    setModalOpen(false);
  }, []);

  const handleModalSuccess = useCallback(() => {
    // Modal closes itself after 300ms (Phase 18 D-DECISION-UI-4.4).
    // Phase 19 cascade fix: trigger TWO re-fetches in parallel —
    //   1. `refresh()` re-fetches the GitHub releases list so the dropdown
    //      label «(актуальная)» moves to the newly-installed version.
    //   2. `onSidecarUpdateApplied?.()` lets `ControlPanelPage` re-invoke
    //      `checkSidecarForServer({...})` so `useUpdateChecker` re-probes the
    //      sidecar's live version via SSH. Without (2), Overview Card #8 /
    //      bottom-tab dots / ServerTabs dot / Badge all stay stale because
    //      `sidecarCurrentVersion` is cached from the initial connect.
    void refresh();
    onSidecarUpdateApplied?.();
  }, [refresh, onSidecarUpdateApplied]);

  // Skeletons cover two cases:
  //   - State A: initial fetch in flight, no versions yet, no error
  //   - During an in-flight `update_sidecar` (modal open) — instead of a
  //     `disabled` dropdown that looks half-dead, show a clean Skeleton
  //     placeholder so the user knows work is happening.
  const showLoadingSkeleton =
    (loading && versions.length === 0 && !error) || modalOpen;
  // Error fallback shows ONLY when we have nothing to display at all —
  // no GitHub list AND no installed version to populate the dropdown with.
  // If the user is on a known version (e.g. 1.0.33) but GitHub is unreachable
  // (rate-limit, offline), still render the dropdown with just the installed
  // option so the section doesn't read as broken — the Refresh button lets
  // them retry once the limit resets.
  const showErrorFallback =
    !!error && versions.length === 0 && (isUnknown || isCurrentLoading);

  return (
    <Card data-testid="protocol-update-card">
      {/* ─── Header row: icon + title + Refresh button ─── */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <Package
            className="w-5 h-5 shrink-0"
            style={{ color: "var(--color-accent-interactive)" }}
            aria-hidden="true"
          />
          <h3 className="text-subtitle">
            {t("server.service.protocol.title")}
          </h3>
        </div>
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={loading || refreshing}
          aria-label={t("server.service.protocol.check_update_aria")}
          className="shrink-0 w-8 h-8 flex items-center justify-center rounded-[var(--radius-md)] hover:bg-[var(--color-bg-hover)] focus-visible:shadow-[var(--focus-ring)] transition-colors disabled:opacity-[var(--opacity-disabled)] disabled:cursor-not-allowed"
          data-testid="protocol-refresh-button"
        >
          {loading || refreshing ? (
            <Loader2
              className="w-4 h-4 animate-spin"
              style={{ color: "var(--color-text-secondary)" }}
            />
          ) : (
            <RefreshCw
              className="w-4 h-4"
              style={{ color: "var(--color-text-secondary)" }}
            />
          )}
        </button>
      </div>

      {/*
       * Caption row: current version + Badge «Доступно новое обновление».
       *
       * Badge переехал сюда (был в header рядом с заголовком). UX-причина:
       * пользователь видит «Установлена 1.0.31 [Доступно новое обновление]» —
       * понятно что обновление относится к текущей версии, а не к карточке
       * целиком. Бейдж рендерится при `sidecarAvailable` независимо от
       * dismissed-флага точек: пользователь увидел индикаторы один раз →
       * точки погасли, но Badge продолжает сигналить «у тебя не latest».
       */}
      <div className="text-caption flex items-center flex-wrap gap-x-2 gap-y-1 mb-3">
        {isUnknown ? (
          <span style={{ color: "var(--color-text-muted)" }}>
            {t("server.service.protocol.not_installed_label")}
          </span>
        ) : (
          <>
            <span style={{ color: "var(--color-text-muted)" }}>
              {t("server.service.protocol.current_label_prefix")}
            </span>
            {isCurrentLoading ? (
              // SSH probe in flight — show a Skeleton instead of an empty gap.
              <Skeleton className="h-4 w-16" />
            ) : (
              <span
                className="text-mono-sm"
                style={{ color: "var(--color-text-primary)" }}
              >
                {currentVersion}
              </span>
            )}
            {sidecarAvailable && (
              <Badge
                variant="success"
                size="sm"
                // Override default uppercase + wide tracking — для inline-badge
                // рядом с caption-текстом этот стиль был слишком громоздкий,
                // буквы шире чем «Текущая версия:» слева. Normal case +
                // обычный трекинг делают бейдж пропорциональным окружению.
                className="normal-case tracking-normal"
                data-testid="protocol-update-badge"
              >
                {t("server.service.protocol.update_available_badge")}
              </Badge>
            )}
          </>
        )}
      </div>

      {/* ─── Action row: dropdown + install button (or Skeletons / fallback) ─── */}
      {showLoadingSkeleton ? (
        <div className="flex items-center gap-3">
          <Skeleton className="flex-1 h-8" />
          <Skeleton className="w-[120px] h-8" />
        </div>
      ) : showErrorFallback ? (
        <span
          className="text-caption"
          style={{ color: "var(--color-text-muted)" }}
        >
          {t("server.service.protocol.no_versions")}
        </span>
      ) : (
        <div className="flex items-center gap-3">
          {/*
           * Design-system `Select` (portal listbox + keyboard nav + tokens).
           * Wrapper carries `data-testid` + `role="group"` so existing tests
           * locate the dropdown unit; opening the listbox surfaces the options
           * (role="option") via portal. Phase 14 finding #10 T-03 doesn't
           * apply here — Select primitive owns its own open/close lifecycle.
           */}
          <div
            className="flex-1"
            role="group"
            aria-label={t("server.service.protocol.dropdown_label")}
            data-testid="protocol-version-select"
          >
            <Select
              value={selectedVersion}
              onChange={(e) => setSelectedVersion(e.target.value)}
              disabled={loading || modalOpen}
              options={dropdownOptions.map((opt) => ({
                value: opt.version,
                label: formatOptionLabel(
                  opt,
                  currentVersion,
                  t("server.service.protocol.current_label_suffix_active"),
                  t("server.service.protocol.current_label_suffix_new"),
                ),
              }))}
            />
          </div>

          <Button
            variant="primary"
            size="sm"
            onClick={handleInstall}
            disabled={!installEnabled}
            title={
              isSelectedCurrent
                ? t("server.service.protocol.install_disabled_current")
                : undefined
            }
            data-testid="protocol-install-button"
          >
            {t("server.service.protocol.install_button")}
          </Button>
        </div>
      )}

      {/* ─── T-03 invariant: UpdateProgressModal mounted unconditionally ───
       *
       * Modal primitive owns its mount + 200ms exit animation. Even when
       * `modalOpen=false`, the Modal stays in the JSX tree — never use
       * `if (!modalOpen) return null` before this point (see Modal.tsx JSDoc).
       */}
      <UpdateProgressModal
        isOpen={modalOpen}
        onClose={handleModalClose}
        sshParams={sshParams}
        fromVersion={isUnknown ? "" : currentVersion}
        toVersion={selectedVersion}
        onSuccess={handleModalSuccess}
      />
    </Card>
  );
}
