import { useState, useRef, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Server,
  Settings,
  BarChart3,
  GitBranch,
  ScrollText,
  Info,
  Globe,
  Moon,
  Sun,
  Shield,
} from "lucide-react";

export type SidebarPage =
  | "server"
  | "settings"
  | "dashboard"
  | "routing"
  | "logs"
  | "about";

interface SidebarProps {
  activePage: SidebarPage;
  onPageChange: (page: SidebarPage) => void;
  hasConfig: boolean;
  theme: "dark" | "light";
  onThemeToggle: () => void;
  language: string;
  onLanguageToggle: () => void;
}

interface NavItem {
  id: SidebarPage;
  icon: ReactNode;
  labelKey: string;
  requiresConfig?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: "server", icon: <Server className="w-[18px] h-[18px]" />, labelKey: "tabs.server" },
  { id: "settings", icon: <Settings className="w-[18px] h-[18px]" />, labelKey: "tabs.settings", requiresConfig: true },
  { id: "dashboard", icon: <BarChart3 className="w-[18px] h-[18px]" />, labelKey: "tabs.dashboard", requiresConfig: true },
  { id: "routing", icon: <GitBranch className="w-[18px] h-[18px]" />, labelKey: "tabs.routing", requiresConfig: true },
  { id: "logs", icon: <ScrollText className="w-[18px] h-[18px]" />, labelKey: "tabs.logs", requiresConfig: true },
];

export function Sidebar({
  activePage,
  onPageChange,
  hasConfig,
  theme,
  onThemeToggle,
  language,
  onLanguageToggle,
}: SidebarProps) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
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
      className="h-full flex flex-col border-r shrink-0 select-none overflow-hidden"
      style={{
        width: expanded ? "var(--sidebar-width-expanded)" : "var(--sidebar-width-collapsed)",
        backgroundColor: "var(--color-bg-secondary)",
        borderColor: "var(--color-border)",
        transition: "width 250ms ease",
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Logo */}
      <div
        className="flex items-center gap-2.5 px-3 py-4 border-b"
        style={{ borderColor: "var(--color-border)" }}
        data-tauri-drag-region
      >
        <div className="p-1.5 rounded-lg shrink-0" style={{ backgroundColor: "rgba(99, 102, 241, 0.15)" }}>
          <Shield className="w-5 h-5" style={{ color: "var(--color-accent-400)" }} />
        </div>
        {expanded && (
          <span
            className="text-sm font-bold tracking-wide truncate whitespace-nowrap"
            style={{ color: "var(--color-text-primary)" }}
          >
            TrustTunnel
          </span>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 flex flex-col gap-0.5 px-2 py-2 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const disabled = item.requiresConfig && !hasConfig;
          const active = activePage === item.id;

          return (
            <button
              key={item.id}
              onClick={() => !disabled && onPageChange(item.id)}
              disabled={disabled}
              title={!expanded ? t(item.labelKey) : undefined}
              className={`
                flex items-center gap-2.5 rounded-[var(--radius-md)]
                ${expanded ? "px-3 py-2" : "px-0 py-2 justify-center"}
                ${disabled ? "opacity-30 cursor-not-allowed" : "cursor-pointer"}
              `}
              style={{
                backgroundColor: active ? "var(--color-bg-active)" : "transparent",
                color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                transition: "background-color 150ms ease, color 150ms ease",
              }}
            >
              <span className="shrink-0">{item.icon}</span>
              {expanded && (
                <span className="text-[13px] font-medium truncate whitespace-nowrap">{t(item.labelKey)}</span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom section */}
      <div
        className="flex flex-col gap-0.5 px-2 py-2 border-t"
        style={{ borderColor: "var(--color-border)" }}
      >
        {/* About */}
        <button
          onClick={() => onPageChange("about")}
          title={!expanded ? t("tabs.about") : undefined}
          className={`
            flex items-center gap-2.5 rounded-[var(--radius-md)]
            ${expanded ? "px-3 py-2" : "px-0 py-2 justify-center"}
          `}
          style={{
            backgroundColor: activePage === "about" ? "var(--color-bg-active)" : "transparent",
            color: activePage === "about" ? "var(--color-text-primary)" : "var(--color-text-secondary)",
            transition: "background-color 150ms ease, color 150ms ease",
          }}
        >
          <Info className="w-[18px] h-[18px] shrink-0" />
          {expanded && <span className="text-[13px] font-medium truncate whitespace-nowrap">{t("tabs.about")}</span>}
        </button>

        {/* Language toggle */}
        <button
          onClick={onLanguageToggle}
          title={!expanded ? (language === "ru" ? "English" : "Русский") : undefined}
          className={`
            flex items-center gap-2.5 rounded-[var(--radius-md)]
            ${expanded ? "px-3 py-2" : "px-0 py-2 justify-center"}
          `}
          style={{ color: "var(--color-text-secondary)", transition: "background-color 150ms ease" }}
        >
          <Globe className="w-[18px] h-[18px] shrink-0" />
          {expanded && (
            <span className="text-[13px] font-medium whitespace-nowrap">{language === "ru" ? "English" : "Русский"}</span>
          )}
        </button>

        {/* Theme toggle */}
        <button
          onClick={onThemeToggle}
          title={!expanded ? (theme === "dark" ? "Light theme" : "Dark theme") : undefined}
          className={`
            flex items-center gap-2.5 rounded-[var(--radius-md)]
            ${expanded ? "px-3 py-2" : "px-0 py-2 justify-center"}
          `}
          style={{ color: "var(--color-text-secondary)", transition: "background-color 150ms ease" }}
        >
          {theme === "dark" ? (
            <Sun className="w-[18px] h-[18px] shrink-0" />
          ) : (
            <Moon className="w-[18px] h-[18px] shrink-0" />
          )}
          {expanded && (
            <span className="text-[13px] font-medium whitespace-nowrap">
              {theme === "dark" ? "Light" : "Dark"}
            </span>
          )}
        </button>
      </div>
    </aside>
  );
}
