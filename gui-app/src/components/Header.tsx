import { Shield, Wand2, Settings, GitBranch } from "lucide-react";
import type { AppTab } from "../App";

interface HeaderProps {
  activeTab: AppTab;
  onTabChange: (tab: AppTab) => void;
}

const TABS: { id: AppTab; label: string; icon: React.ReactNode }[] = [
  { id: "setup", label: "Установка VPN", icon: <Wand2 className="w-3.5 h-3.5" /> },
  { id: "settings", label: "Настройки", icon: <Settings className="w-3.5 h-3.5" /> },
  { id: "routing", label: "Маршрутизация", icon: <GitBranch className="w-3.5 h-3.5" /> },
];

function Header({ activeTab, onTabChange }: HeaderProps) {
  return (
    <header
      className="flex items-center gap-3 px-5 py-3 border-b border-white/10 bg-surface-900/50 backdrop-blur-sm"
      data-tauri-drag-region
    >
      <div className="p-2 rounded-lg bg-indigo-500/20">
        <Shield className="w-5 h-5 text-indigo-400" />
      </div>
      <div className="mr-4">
        <h1 className="text-sm font-bold tracking-wide">TrustTunnel</h1>
        <p className="text-[10px] text-gray-500 uppercase tracking-widest">
          VPN Client
        </p>
      </div>

      <nav className="flex gap-1 ml-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200
              ${
                activeTab === tab.id
                  ? "bg-white/10 text-white"
                  : "text-gray-500 hover:text-gray-300 hover:bg-white/5"
              }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </nav>
    </header>
  );
}

export default Header;
