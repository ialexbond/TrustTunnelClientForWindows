import { Wifi, GitBranch, Info, ArrowUpCircle } from "lucide-react";
import type { AppTab, UpdateInfo } from "../App";

interface HeaderProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  updateInfo?: UpdateInfo;
  onCheckUpdates?: () => void;
  onOpenDownload?: () => void;
  hasConfig?: boolean;
}

const TABS: { id: AppTab; label: string; icon: React.ReactNode }[] = [
  { id: "vpn", label: "VPN", icon: <Wifi className="w-4 h-4" /> },
  { id: "routing", label: "Маршруты", icon: <GitBranch className="w-4 h-4" /> },
  { id: "about", label: "О программе", icon: <Info className="w-4 h-4" /> },
];

function Header({ activeTab, onTabChange, updateInfo, hasConfig }: HeaderProps) {
  return (
    <header className="border-b border-white/10 bg-surface-900/50" data-tauri-drag-region>
      <div className="flex items-center justify-center px-4 py-2.5 gap-2">
        <h1 className="text-xs font-bold tracking-wide text-gray-300">
          TrustTunnel
          <span className="ml-1.5 text-[8px] font-semibold text-cyan-400 bg-cyan-400/15 px-1 py-0.5 rounded align-middle">LIGHT</span>
        </h1>
        {updateInfo?.available && (
          <button
            onClick={() => onTabChange("about")}
            className="flex items-center gap-1 text-[9px] font-medium text-emerald-400 bg-emerald-500/15 hover:bg-emerald-500/25 px-1.5 py-0.5 rounded transition-colors"
            title={`Доступна версия ${updateInfo.latestVersion}`}
          >
            <ArrowUpCircle className="w-3 h-3" />
            {updateInfo.latestVersion}
          </button>
        )}
      </div>
      <nav className="flex border-t border-white/5">
        {TABS.map((tab) => {
          const disabled = tab.id === "routing" && !hasConfig;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => { if (!disabled) onTabChange(tab.id); }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-medium transition-all
                ${disabled
                  ? "text-gray-700 cursor-not-allowed"
                  : active
                  ? "text-white bg-white/5 border-b-2 border-indigo-400"
                  : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]"
                }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          );
        })}
      </nav>
    </header>
  );
}

export default Header;
