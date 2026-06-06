import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useActivityLog } from "../shared/hooks/useActivityLog";
import {
  LayoutDashboard,
  Users,
  SlidersHorizontal,
  Shield,
  Wrench,
  LogOut,
} from "lucide-react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "../shared/lib/cn";
import { Divider } from "../shared/ui/Divider";
import { Tooltip } from "../shared/ui/Tooltip";
import { Skeleton } from "../shared/ui/Skeleton";
import { useConfirm } from "../shared/ui/useConfirm";
import type { ServerState } from "./server/useServerState";
import { OverviewSection } from "./server/OverviewSection";
import { UsersSection } from "./server/UsersSection";
import {
  ConfigurationTab,
  configTabDirtyRef,
} from "./server/ConfigurationTab";
// ServerSettingsSection removed (was Phase 11 baseline) — replaced by
// ConfigurationTab (Phase 15.1 schema-driven editor).
import { SecurityTabSection } from "./server/SecurityTabSection";
import { ServiceTabSection } from "./server/ServiceTabSection";
import type { ServerTabId } from "../shared/types";

type TabId = ServerTabId;

/**
 * localStorage key для persist активного таба (CLAUDE.md — `tt_active_tab`).
 *
 * Регрессия: ServerPanel имеет early returns (loading / error / not-installed),
 * и когда state.loading становится true (например, после `loadServerInfo()`),
 * ServerTabs unmount'ится. После resolve state.loading=false тейк re-mount
 * терял `activeTab` в пользу default "overview".
 *
 * M-04 refresh при активации таба Users ускорил это — клик по Users
 * отправлял loadServerInfo и юзера «выкидывало» обратно на Overview.
 *
 * Persist решает сразу и регрессию, и общий UX: при reload app юзер
 * возвращается на тот же таб. Значение validируется против whitelist
 * чтобы malformed storage не сломал tabs.
 */
const ACTIVE_TAB_STORAGE_KEY = "tt_active_tab";
const VALID_TAB_IDS: readonly TabId[] = [
  "overview",
  "users",
  "configuration",
  "security",
  "service",
];
function loadActiveTab(): TabId {
  try {
    const raw = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    // Phase 19 migration: legacy "utilities" persisted value → "service".
    // H-08: write the canonical value back IMMEDIATELY rather than relying on a
    // future tab switch. Previously a user who landed on the migrated service tab
    // and never switched left "utilities" rotting in storage indefinitely.
    if (raw === "utilities") {
      saveActiveTab("service");
      return "service";
    }
    if (raw && (VALID_TAB_IDS as readonly string[]).includes(raw)) {
      return raw as TabId;
    }
  } catch {
    /* privacy / quota — fall back to default */
  }
  return "overview";
}
function saveActiveTab(id: TabId): void {
  try {
    localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

interface Tab {
  id: TabId;
  labelKey: string;
  fallback: string;
  icon: React.ReactNode;
}

const tabs: Tab[] = [
  { id: "overview",       labelKey: "tabs.overview",       fallback: "Обзор",         icon: <LayoutDashboard className="w-4 h-4" /> },
  { id: "users",          labelKey: "tabs.users",          fallback: "Пользователи",  icon: <Users className="w-4 h-4" /> },
  { id: "configuration",  labelKey: "tabs.configuration",  fallback: "Конфигурация",  icon: <SlidersHorizontal className="w-4 h-4" /> },
  { id: "security",       labelKey: "tabs.security",       fallback: "Безопасность",  icon: <Shield className="w-4 h-4" /> },
  { id: "service",        labelKey: "tabs.service",        fallback: "Сервис",        icon: <Wrench className="w-4 h-4" /> },
];

interface ServerTabsProps {
  state: ServerState;
  /**
   * Phase 19 Plan 19-04 cascade props (UI-SPEC §Block 1+2+3).
   *
   * `hasSidecarUpdate` drives:
   *   - a static 8×8 accent dot on the «Сервис» pill (top-right) when truthy
   *     AND `activeTab !== "service"` (dot hides when user is already на табе).
   *   - the «Версия протокола» Overview Card #8 ArrowUp icon — passed through
   *     to `OverviewSection` via prop.
   *
   * The remaining three (`currentVersion` / `sidecarAvailable` / `latestVersion`)
   * forward to `ServiceTabSection` for the `ProtocolUpdateSection` Card-4 mount.
   * Pattern mirrors Phase 18 dot-indicator wiring (App.tsx → TabNavigation).
   */
  hasSidecarUpdate?: boolean;
  currentVersion?: string;
  sidecarAvailable?: boolean;
  latestVersion?: string;
  /**
   * Phase 19 cascade fix — passed down to `ServiceTabSection` →
   * `ProtocolUpdateSection`. Fires after a successful `update_sidecar` run so
   * the parent can re-probe `sidecarCurrentVersion` via SSH.
   */
  onSidecarUpdateApplied?: () => void;
  /**
   * One-shot: fires on Service tab first mount with sidecar update available.
   * Parent flips `tt_dismissed_update_<version>` so the bottom-tab pill dot
   * stops nagging after the user has already seen the indication.
   */
  onSidecarUpdateSeen?: () => void;
}

export function ServerTabs({
  state,
  hasSidecarUpdate = false,
  currentVersion,
  sidecarAvailable,
  latestVersion,
  onSidecarUpdateApplied,
  onSidecarUpdateSeen,
}: ServerTabsProps) {
  const { t } = useTranslation();
  const { log: activityLog } = useActivityLog();
  const confirm = useConfirm();
  const [activeTab, setActiveTabState] = useState<TabId>(() => loadActiveTab());
  const setActiveTab = async (id: TabId): Promise<void> => {
    // D-14.1: navigate-away guard — only intercepts when leaving Configuration
    // tab w/ dirty changes. ConfirmDialog API supports only boolean — single
    // dialog с danger variant: Confirm = Discard&Leave; Cancel = Stay.
    // Save&Leave triple-choice covered внутри ConfigurationTab (useNavigateAwayGuard
    // hook — Plan 15.1-07 may surface need для wider integration).
    if (activeTab === "configuration" && id !== "configuration" && configTabDirtyRef.current) {
      const ok = await confirm({
        title: t("server.config.unsaved_title"),
        message: t("server.config.unsaved_desc"),
        variant: "danger",
        confirmText: t("server.config.discard_and_leave"),
        cancelText: t("server.config.stay"),
      });
      if (!ok) {
        // User chose to stay
        activityLog("USER", "tab.switch.cancelled.unsaved", "ServerTabs");
        return;
      }
      // User chose to discard and leave — clear dirty ref (ConfigurationTab will
      // re-sync on next dirtyCount change via its useEffect).
      // eslint-disable-next-line react-hooks/immutability -- module-level shared ref pattern (Phase 15-07 carry-forward); ConfigurationTab subsequently calls discardAll which resets dirtyCount to 0 → useEffect there re-syncs ref to false.
      configTabDirtyRef.current = false;
    }
    setActiveTabState(id);
    saveActiveTab(id);
  };

  const handleDisconnect = async () => {
    activityLog("USER", "server.disconnect.initiated", "ServerTabs.LogOutIcon");

    // D-14.1: extra guard для disconnect когда configuration tab dirty
    if (activeTab === "configuration" && configTabDirtyRef.current) {
      const okUnsaved = await confirm({
        title: t("server.config.unsaved_title"),
        message: t("server.config.unsaved_desc"),
        variant: "danger",
        confirmText: t("server.config.discard_and_leave"),
        cancelText: t("server.config.stay"),
      });
      if (!okUnsaved) {
        activityLog(
          "USER",
          "server.disconnect.cancelled.unsaved",
          "ServerTabs",
        );
        return;
      }
      configTabDirtyRef.current = false;
    }

    const ok = await confirm({
      title: t("server.disconnect.confirm_title"),
      message: t("server.disconnect.confirm_message"),
      variant: "danger",
      confirmText: t("buttons.confirm"),
      cancelText: t("buttons.cancel"),
    });
    if (ok) {
      activityLog("USER", "server.disconnect.confirmed", "ConfirmDialog");
      state.onDisconnect();
    } else {
      activityLog("USER", "server.disconnect.cancelled", "ConfirmDialog");
    }
  };

  // WAI-ARIA Tabs manual activation (Phase 12.5, D-19):
  // Arrow / Home / End move FOCUS only — activation requires Enter/Space/click.
  // This prevents accidental activation of heavy SSH tabs while navigating.
  const handleTabKeyDown = (e: React.KeyboardEvent, currentIndex: number) => {
    const lastIndex = tabs.length - 1;
    let nextIndex: number | null = null;
    if (e.key === "ArrowRight") nextIndex = currentIndex < lastIndex ? currentIndex + 1 : 0;
    else if (e.key === "ArrowLeft") nextIndex = currentIndex > 0 ? currentIndex - 1 : lastIndex;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = lastIndex;
    if (nextIndex !== null) {
      e.preventDefault();
      // Manual activation: move focus only, do NOT call setActiveTab.
      document.getElementById(`tab-${tabs[nextIndex].id}`)?.focus();
    }
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Tab bar — separator (border-bottom) constrained to button extent (BUG-05) */}
      <div className="px-6 shrink-0">
      {/* H-07: the tablist and the disconnect action share one flex row, but the
          disconnect button sits OUTSIDE role="tablist" (WAI-ARIA 1.2 §3.24: a
          tablist must contain only role=tab children). The border-bottom + flex
          layout move to this wrapper so the visual row is unchanged. */}
      <div
        className="flex items-center gap-1"
        style={{ borderBottom: "1px solid var(--color-border)", paddingTop: "4px", paddingBottom: "4px" }}
      >
      <div
        role="tablist"
        aria-label={t("tabs.server_tabs", "Серверные вкладки")}
        className="flex flex-1 items-center gap-1"
      >
        {tabs.map((tab, idx) => {
          // Phase 19 — dot indicator on «Сервис» pill (UI-SPEC §Block 1 §A.2).
          // Visible when sidecar update detected AND user not currently on the
          // «Сервис» tab (D-DECISION-UI-2.1: 10% accent rule — dot disappears
          // once the user navigates here, since they already see the
          // ProtocolUpdateSection Badge inside).
          const showSidecarDot =
            hasSidecarUpdate && tab.id === "service" && activeTab !== "service";
          return (
            <button
              key={tab.id}
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`panel-${tab.id}`}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={async () => {
                await setActiveTab(tab.id);
                activityLog("USER", `tab.switch target="${tab.id}"`, "ServerTabs");
              }}
              onKeyDown={(e) => handleTabKeyDown(e, idx)}
              className={cn(
                "relative flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors rounded-[var(--radius-md)]",
                "focus-visible:shadow-[var(--focus-ring)] outline-none",
                activeTab === tab.id
                  ? "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] shadow-[var(--shadow-xs)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
              )}
            >
              {tab.icon}
              <span>{t(tab.labelKey, tab.fallback)}</span>
              {showSidecarDot && (
                <span
                  className="absolute top-2 right-2 w-2 h-2 rounded-full"
                  style={{ backgroundColor: "var(--color-accent-interactive)" }}
                  role="status"
                  aria-label={t("server.service.tab_update_available_aria")}
                  data-testid="service-tab-update-dot"
                />
              )}
            </button>
          );
        })}
      </div>

        {/* Separator + Disconnect icon (semi-destructive action — hover красным).
            Sibling of the tablist (H-07) — reachable via Tab, not Arrow keys. */}
        <Divider orientation="vertical" className="shrink-0 mx-2 my-1.5" />
        <Tooltip text={t("control.disconnect")} position="bottom">
          <button
            type="button"
            onClick={handleDisconnect}
            aria-label={t("control.disconnect")}
            className={cn(
              "shrink-0 flex items-center justify-center",
              "h-8 w-8 rounded-[var(--radius-md)]",
              "text-[var(--color-text-muted)]",
              "hover:text-[var(--color-destructive)] hover:bg-[var(--color-danger-tint-08)]",
              "transition-colors",
              "focus-visible:shadow-[var(--focus-ring)] outline-none"
            )}
          >
            <LogOut className="w-4 h-4" />
          </button>
        </Tooltip>
      </div>
      </div>

      {/* Tab content — cross-fade with visibility+opacity: mount once, fade between tabs */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            role="tabpanel"
            id={`panel-${tab.id}`}
            aria-labelledby={`tab-${tab.id}`}
            className="h-full flex flex-col overflow-hidden scroll-overlay py-4 px-6 space-y-4"
            style={{
              position: activeTab === tab.id ? "relative" : "absolute",
              inset: activeTab === tab.id ? undefined : 0,
              opacity: activeTab === tab.id ? 1 : 0,
              visibility: activeTab === tab.id ? ("visible" as const) : ("hidden" as const),
              transition: "opacity var(--transition-fast)",
            }}
            aria-hidden={activeTab !== tab.id}
          >
            {state.loading ? (
              <div className="space-y-4">
                <Skeleton variant="card" height={100} />
                <Skeleton variant="line" width="60%" height={14} />
                <Skeleton variant="line" width="40%" height={14} />
                <Skeleton variant="card" height={80} />
              </div>
            ) : state.error ? (
              <div className="flex flex-col items-center justify-center py-12 gap-4" style={{ color: "var(--color-text-muted)" }}>
                <AlertTriangle className="w-8 h-8" style={{ color: "var(--color-danger-400)" }} />
                <p className="text-sm text-center max-w-sm">{state.error}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => state.loadServerInfo()}
                    className={cn(
                      "flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-md)]",
                      "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]",
                      "hover:bg-[var(--color-bg-hover)] transition-colors",
                      "focus-visible:shadow-[var(--focus-ring)] outline-none"
                    )}
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    {t("errors.retry")}
                  </button>
                </div>
              </div>
            ) : (
              <>
                {tab.id === "overview" && (
                  <OverviewSection
                    state={state}
                    activeServerTab={activeTab}
                    sidecarAvailable={sidecarAvailable}
                    onNavigate={(nextTab) => {
                      void setActiveTab(nextTab);
                      activityLog(
                        "USER",
                        `tab.switch target="${nextTab}" source="overview-drilldown"`,
                        "OverviewSection",
                      );
                    }}
                  />
                )}
                {tab.id === "users" && <UsersSection state={state} activeServerTab={activeTab} />}
                {tab.id === "configuration" && (
                  <ConfigurationTab
                    sshParams={state.sshParams}
                    onNavigateToTab={(targetTab) => void setActiveTab(targetTab)}
                  />
                )}
                {tab.id === "security" && <SecurityTabSection state={state} />}
                {tab.id === "service" && (
                  <ServiceTabSection
                    state={state}
                    currentVersion={currentVersion}
                    sidecarAvailable={sidecarAvailable}
                    latestVersion={latestVersion}
                    onSidecarUpdateApplied={onSidecarUpdateApplied}
                    onSidecarUpdateSeen={onSidecarUpdateSeen}
                  />
                )}
              </>
            )}
          </div>
        ))}
      </div>

    </div>
  );
}
