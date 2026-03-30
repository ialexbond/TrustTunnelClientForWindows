import { useState, useRef, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Server,
  Monitor,
  Settings,
  SlidersHorizontal,
  BarChart3,
  GitBranch,
  ScrollText,
  Info,
  Shield,
} from "lucide-react";
import { colors } from "../../shared/ui/colors";

export type SidebarPage =
  | "server"
  | "control"
  | "settings"
  | "dashboard"
  | "routing"
  | "logs"
  | "about"
  | "appSettings";

interface SidebarProps {
  activePage: SidebarPage;
  onPageChange: (page: SidebarPage) => void;
  hasConfig: boolean;
  hasUpdate?: boolean;
}

interface NavItem {
  id: SidebarPage;
  icon: ReactNode;
  labelKey: string;
  requiresConfig?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: "server", icon: <Server className="w-[18px] h-[18px]" />, labelKey: "tabs.installation" },
  { id: "control", icon: <Monitor className="w-[18px] h-[18px]" />, labelKey: "tabs.controlPanel" },
  { id: "settings", icon: <Settings className="w-[18px] h-[18px]" />, labelKey: "tabs.settings", requiresConfig: true },
  { id: "dashboard", icon: <BarChart3 className="w-[18px] h-[18px]" />, labelKey: "tabs.dashboard", requiresConfig: true },
  { id: "routing", icon: <GitBranch className="w-[18px] h-[18px]" />, labelKey: "tabs.routing", requiresConfig: true },
  { id: "logs", icon: <ScrollText className="w-[18px] h-[18px]" />, labelKey: "tabs.logs", requiresConfig: true },
  { id: "appSettings", icon: <SlidersHorizontal className="w-[18px] h-[18px]" />, labelKey: "tabs.appSettings" },
];

export function Sidebar({
  activePage,
  onPageChange,
  hasConfig,
  hasUpdate,
}: SidebarProps) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [hoveredItem, setHoveredItem] = useState<string | null>(null);
  const hoverTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Expanded = when mouse is hovering over sidebar
  const expanded = hovered;

  const handleMouseEnter = useCallback(() => {
    if (hoverTimeout.current) clearTimeout(hoverTimeout.current);
    setHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    // Small delay before collapsing to avoid flicker
    hoverTimeout.current = setTimeout(() => setHovered(false), 300);
  }, []);

  return (
    <aside
      className="h-full shrink-0 select-none relative"
      style={{
        width: "var(--sidebar-width-collapsed)",
        boxShadow: "1px 0 0 var(--color-border)",
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className="absolute top-0 left-0 bottom-0 h-full flex flex-col overflow-hidden"
        style={{
          width: expanded ? "var(--sidebar-width-expanded)" : "var(--sidebar-width-collapsed)",
          backgroundColor: "var(--color-bg-secondary)",
          borderRight: expanded ? "1px solid var(--color-border)" : "none",
          transition: "width 250ms ease",
          zIndex: 50,
        }}
      >
      {/* Logo */}
      <div
        className="flex items-center gap-2.5 px-3 border-b"
        style={{ borderColor: "var(--color-border)", height: 52 }}
        data-tauri-drag-region
      >
        <div className="p-1.5 rounded-lg shrink-0" style={{ backgroundColor: colors.accentLogoGlow }}>
          <Shield className="w-5 h-5" style={{ color: "var(--color-accent-400)" }} />
        </div>
        {expanded && (
          <div className="flex items-center gap-1.5">
            <span
              className="text-sm font-bold tracking-wide truncate whitespace-nowrap"
              style={{ color: "var(--color-text-primary)" }}
            >
              TrustTunnel
            </span>
            <span
              className="text-[9px] font-bold px-1.5 py-0.5 rounded"
              style={{ backgroundColor: colors.accentBg, color: "var(--color-accent-500)" }}
            >
              PRO
            </span>
          </div>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 flex flex-col gap-0.5 pt-1 pb-2 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const disabled = item.requiresConfig && !hasConfig;
          const active = activePage === item.id;

          return (
            <button
              key={item.id}
              onClick={() => !disabled && onPageChange(item.id)}
              disabled={disabled}
              title={!expanded ? t(item.labelKey) : undefined}
              className={`flex items-center mx-[10px] rounded-[var(--radius-md)] ${disabled ? "opacity-30 cursor-not-allowed" : "cursor-pointer"}`}
              onMouseEnter={() => !disabled && setHoveredItem(item.id)}
              onMouseLeave={() => setHoveredItem(null)}
              style={{
                height: 36,
                backgroundColor: active
                  ? "var(--color-bg-active)"
                  : hoveredItem === item.id
                  ? "var(--color-bg-hover)"
                  : "transparent",
                color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                transition: "background-color 150ms ease, color 150ms ease",
              }}
            >
              <span className="flex items-center justify-center shrink-0" style={{ width: 36, height: 36 }}>
                {item.icon}
              </span>
              {expanded && (
                <span className="text-[13px] font-medium truncate whitespace-nowrap ml-1 pr-2">{t(item.labelKey)}</span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom section */}
      <div
        className="flex flex-col gap-0.5 py-2 border-t"
        style={{ borderColor: "var(--color-border)" }}
      >
        {/* About */}
        <button
          onClick={() => onPageChange("about")}
          title={!expanded ? t("tabs.about") : undefined}
          className="flex items-center mx-[10px] rounded-[var(--radius-md)] cursor-pointer"
          onMouseEnter={() => setHoveredItem("about")}
          onMouseLeave={() => setHoveredItem(null)}
          style={{
            height: 36,
            backgroundColor: activePage === "about"
              ? "var(--color-bg-active)"
              : hoveredItem === "about"
              ? "var(--color-bg-hover)"
              : "transparent",
            color: activePage === "about" ? "var(--color-text-primary)" : "var(--color-text-secondary)",
            transition: "background-color 150ms ease, color 150ms ease",
          }}
        >
          <span className="relative flex items-center justify-center shrink-0" style={{ width: 36, height: 36 }}>
            <Info className="w-[18px] h-[18px]" />
            {hasUpdate && (
              <span
                className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full"
                style={{
                  backgroundColor: "var(--color-success-500)",
                  boxShadow: "0 0 8px rgba(16, 185, 129, 0.6)",
                }}
              />
            )}
          </span>
          {expanded && <span className="text-[13px] font-medium truncate whitespace-nowrap ml-2 pr-3">{t("tabs.about")}</span>}
        </button>
      </div>
      </div>
    </aside>
  );
}
