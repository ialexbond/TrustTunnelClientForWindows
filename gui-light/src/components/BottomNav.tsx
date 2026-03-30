import { Shield, GitBranch, Settings, Info } from "lucide-react";
import type { AppTab } from "../App";
import { colors } from "../shared/ui/colors";

interface BottomNavProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  updateAvailable?: boolean;
  hasConfig?: boolean;
}

const tabs: { id: AppTab; icon: typeof Shield }[] = [
  { id: "vpn", icon: Shield },
  { id: "routing", icon: GitBranch },
  { id: "settings", icon: Settings },
  { id: "about", icon: Info },
];

export function BottomNav({ activeTab, onTabChange, updateAvailable, hasConfig }: BottomNavProps) {
  return (
    <nav
      className="flex shrink-0 items-center justify-around px-2"
      style={{
        borderTop: "1px solid var(--color-border)",
        backgroundColor: "var(--color-bg-primary)",
        height: 52,
      }}
    >
      {tabs.map(({ id, icon: Icon }) => {
        const disabled = id === "routing" && !hasConfig;
        const active = activeTab === id;
        return (
          <button
            key={id}
            onClick={() => !disabled && onTabChange(id)}
            className="relative flex items-center justify-center rounded-lg transition-all"
            style={{
              width: 40,
              height: 36,
              color: disabled
                ? "var(--color-text-muted)"
                : active
                ? "var(--color-accent-500)"
                : "var(--color-text-secondary)",
              backgroundColor: active ? colors.accentBg : "transparent",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.4 : 1,
            }}
            onMouseEnter={(e) => {
              if (!active && !disabled) {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = "var(--color-bg-hover)";
              }
            }}
            onMouseLeave={(e) => {
              if (!active) {
                (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
              }
            }}
          >
            <Icon className="w-5 h-5" />
            {/* Update indicator */}
            {id === "about" && updateAvailable && (
              <span
                className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full"
                style={{ backgroundColor: "var(--color-success-400)" }}
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}
