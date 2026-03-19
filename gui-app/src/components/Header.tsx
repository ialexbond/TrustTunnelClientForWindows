import { Shield, Wand2, Settings, GitBranch, Info, Download } from "lucide-react";
import type { AppTab, UpdateInfo, VpnStatus } from "../App";

interface HeaderProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
  updateInfo?: UpdateInfo;
  onCheckUpdates?: () => void;
  onOpenDownload?: () => void;
  hasConfig?: boolean;
  vpnStatus?: VpnStatus;
}

const TABS: { id: AppTab; label: string; icon: React.ReactNode }[] = [
  { id: "setup", label: "Установка VPN", icon: <Wand2 className="w-3.5 h-3.5" /> },
  { id: "settings", label: "Настройки", icon: <Settings className="w-3.5 h-3.5" /> },
  { id: "routing", label: "Маршрутизация", icon: <GitBranch className="w-3.5 h-3.5" /> },
  { id: "about", label: "О программе", icon: <Info className="w-3.5 h-3.5" /> },
];

const STATUS_DOT: Record<string, string> = {
  connected: "bg-emerald-400 shadow-emerald-400/50",
  connecting: "bg-amber-400 animate-pulse shadow-amber-400/50",
  recovering: "bg-amber-400 animate-pulse shadow-amber-400/50",
  disconnecting: "bg-amber-400 animate-pulse shadow-amber-400/50",
  error: "bg-red-400 shadow-red-400/50",
  disconnected: "bg-gray-600",
};

function Header({ activeTab, onTabChange, updateInfo, onOpenDownload, hasConfig, vpnStatus }: HeaderProps) {
  return (
    <header
      className="border-b border-white/10 bg-surface-900/50 backdrop-blur-sm"
      data-tauri-drag-region
    >
    <div className="flex items-center gap-3 px-5 py-3 max-w-[980px] mx-auto">
      <div className="relative p-2 rounded-lg bg-indigo-500/20">
        <Shield className="w-5 h-5 text-indigo-400" />
        {vpnStatus && vpnStatus !== "disconnected" && (
          <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full shadow-lg ${STATUS_DOT[vpnStatus] || STATUS_DOT.disconnected}`} />
        )}
      </div>
      <div className="mr-4">
        <h1 className="text-sm font-bold tracking-wide">
          TrustTunnel
          {import.meta.env.DEV && (
            <span className="ml-1.5 text-[9px] font-semibold text-amber-400 bg-amber-400/15 px-1.5 py-0.5 rounded align-middle">DEV</span>
          )}
        </h1>
        <p className="text-[10px] text-gray-500 uppercase tracking-widest">
          VPN Client
        </p>
      </div>

      <nav className="flex gap-1 ml-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              if ((tab.id === "settings" || tab.id === "routing") && !hasConfig) return;
              onTabChange(tab.id);
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200
              ${
                (tab.id === "settings" || tab.id === "routing") && !hasConfig
                  ? "text-gray-700 cursor-not-allowed"
                  : activeTab === tab.id
                  ? "bg-white/10 text-white"
                  : "text-gray-500 hover:text-gray-300 hover:bg-white/5"
              }`}
            title={(tab.id === "settings" || tab.id === "routing") && !hasConfig ? "Сначала настройте VPN" : undefined}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </nav>

      {(updateInfo?.available || import.meta.env.DEV) && (
        <button
          onClick={onOpenDownload}
          className="flex items-center gap-1.5 px-2.5 py-1 ml-2 rounded-lg text-[11px] font-medium bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors animate-pulse"
          title={`Доступна версия ${updateInfo?.latestVersion || "?.?.?"}`}
        >
          <Download className="w-3.5 h-3.5" />
          v{updateInfo?.latestVersion || "?.?.?"}
        </button>
      )}
    </div>
    </header>
  );
}

export default Header;
