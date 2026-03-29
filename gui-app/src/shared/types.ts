export type VpnStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "recovering"
  | "error";

export interface UpdateInfo {
  available: boolean;
  latestVersion: string;
  currentVersion: string;
  downloadUrl: string;
  sha256?: string;
  releaseNotes: string;
  checking: boolean;
}

export interface VpnConfig {
  configPath: string;
  logLevel: string;
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
}

/** @deprecated Use SidebarPage instead — kept for backward compat with Header.tsx */
export type AppTab = "setup" | "settings" | "routing" | "about";

export type ThemeMode = "system" | "dark" | "light";
