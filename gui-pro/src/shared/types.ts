export type VpnStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "recovering"
  | "error";

export interface UpdateInfo {
  // EXISTING — DO NOT REMOVE (backwards-compat для AboutPanel + App.tsx)
  available: boolean;            // alias of appAvailable (legacy contract)
  latestVersion: string;
  currentVersion: string;
  downloadUrl: string;
  sha256?: string;
  releaseNotes: string;
  checking: boolean;

  // NEW (Phase 18 — dual update detection, REQ-18-UPDATE-DETECTION-04)
  // Optional, чтобы AboutPanel.test.tsx defaultProps без sidecar полей не падал.
  // Production hook всегда возвращает все поля (initial state в useUpdateChecker).
  appAvailable?: boolean;
  sidecarAvailable?: boolean;
  sidecarCurrentVersion?: string;
  sidecarLatestVersion?: string;
  sidecarLatestTag?: string;
  sidecarDownloadUrl?: string;
  sidecarDismissed?: boolean;
  sidecarChecking?: boolean;
  lastChecked?: string | null;
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

export type AppTab = "control" | "connection" | "routing" | "settings" | "about";

export type ThemeMode = "system" | "dark" | "light";
