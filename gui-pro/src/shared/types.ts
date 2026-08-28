export type VpnStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "disconnecting"
  // 02-20 status-UX split: `recovering` now means ONLY «Восстановление» (local
  // network gone — waiting for the adapter, nothing to connect to). The
  // re-establish case (server-lost auto-retry OR manual save+reconnect) is the
  // NEW `reconnecting` = «Переподключение». The Rust `VpnStatus` enum serializes
  // these as two distinct wire strings ("recovering" / "reconnecting"), so the
  // frontend can render the red recovering banner vs the yellow reconnecting one.
  | "recovering"
  | "reconnecting"
  | "error";

/**
 * 02-20 status-UX split — per-attempt reconnect progress «Попытка N/3».
 *
 * The server-silent auto-retry supervisor (connectivity.rs) surfaces the attempt
 * index on the `vpn-status` event payload (optional `attempt`/`max` fields, present
 * ONLY while `status === "reconnecting"`). The frontend stores it so StatusPanel can
 * render «Попытка {attempt} из {max}». `null` whenever no per-attempt counter is live.
 */
export interface ReconnectProgress {
  attempt: number;
  max: number;
  /**
   * DISPLAY NAME of the server this failover step is reaching for. Present only on a walk, and only
   * when the config could be read — the label falls back to a sentence with no name rather than
   * inventing one (see `reconnectLabel.ts`). Never a host, login or secret (D-29).
   */
  server?: string | null;
  /**
   * What the two numbers above MEAN.
   *
   * Absent / false — retries of ONE server: «Попытка {attempt} из {max}».
   * True — position in the failover QUEUE: «Пробуем сервер {attempt} из {max}».
   *
   * On a walk every candidate gets exactly one attempt, so the retry counter read «Попытка 1 из 1»
   * on server after server — a number that never moved, describing a process the person could not
   * see (owner UAT 2026-08-26). The backend now sends the queue position there instead, and this
   * flag is how the UI knows which sentence is true.
   */
  failover?: boolean;
}

/**
 * Why an app-update check failed, as a DISCRIMINANT — never as a message.
 *
 * The two members mirror the two stable ASCII reason codes minted in
 * `src-tauri/src/commands/updater.rs` (`UPDATE_NO_INTERNET_REASON` /
 * `UPDATE_SERVER_UNREACHABLE_REASON`). They are two members and not one because
 * «нет интернета» and «сервер обновлений не ответил» ask the user for two
 * different things: one is actionable here and now, the other is only waiting.
 *
 * There is deliberately no third member and no free-form variant. A backend token
 * this union has never heard of is mapped to `server-unreachable` at the hook
 * boundary rather than carried through, so nothing the network or GitHub prints
 * can ever reach the screen as text.
 */
export type UpdateCheckFailure = "no-internet" | "server-unreachable";

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

  /**
   * (Phase 30 — ABOUT-01) Why the LAST app-update check failed, or null.
   *
   * Null means the last check succeeded, or none has run yet. Additive and
   * optional in exactly the shape the Phase-18 sidecar fields above use: every
   * existing fixture and every prop-drill through `AboutPanel` / `ServerPanel` /
   * `ServiceTabSection` keeps compiling untouched.
   *
   * It carries a CAUSE CATEGORY and never a message. Nothing assigned here comes
   * from an exception, a URL, a host or an HTTP status — see `UpdateCheckFailure`.
   *
   * This field is the whole reason the card can stop lying: before it existed, a
   * check that never succeeded still left `available: false`, and the card read
   * that as «У вас установлена актуальная версия».
   */
  checkError?: UpdateCheckFailure | null;
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

/**
 * Server-panel tab identifiers — used by `ServerTabs.tsx` and consumed by
 * `OverviewSection` / `UsersSection` for drill-down navigation.
 *
 * Phase 19 rename: `"utilities"` → `"service"` (D-04 + UI-SPEC §Block 3 §A —
 * server section becomes «Сервис» to fit Protocol Update Card semantics).
 */
export type ServerTabId =
  | "overview"
  | "users"
  | "configuration"
  | "security"
  | "service";

export type ThemeMode = "system" | "dark" | "light";
