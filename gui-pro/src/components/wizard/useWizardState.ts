import { useState, useEffect, useRef, useCallback, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { WizardStep, DeployStep, DeployLog, ServerInfo } from "./types";
import { reducer, INITIAL_STATE, type Step } from "./machine";
import { resolveResume, type ServerProbe } from "./resolveResume";
import { loadSnapshot, saveSnapshot, migrateLegacySshPassword } from "./persist";
import { formatError } from "../../shared/utils/formatError";
import { sanitizeLogMessage } from "../../shared/utils/sanitizeLogMessage";
import { generateUsername, generatePassword } from "../../shared/utils/credentialGenerator";
import { buildConfigFileName } from "../../shared/utils/configFileName";
import { readCachedCountryCode } from "../server/useServerGeoIp";
import { DEFAULT_DEEPLINK, type DeeplinkFields } from "../server/useUserFormState";

// Raw shape of the check_server_installation JSON payload (server_install.rs).
// The frontend adds localExportComplete (a REAL file check) and configDiverges to
// form the full ServerProbe resolveResume consumes.
interface RawServerProbe {
  installed: boolean;
  binaryInstalled?: boolean;
  credentialsExist?: boolean;
  rulesExist?: boolean;
  vpnConfigExists?: boolean;
  hostsConfigExists?: boolean;
  certPresent?: boolean;
  unitExists?: boolean;
  unitEnabled?: boolean;
  serviceActive?: boolean;
  partial?: boolean;
  configDiverges?: boolean;
}

// round-3 MEDIUM B: prove the local export by reading the REAL file via
// read_client_config (which rejects when the file is gone), NOT by trusting the
// tt_config_path localStorage marker — a moved/deleted export must resolve to
// export-pending, the WIZARD-02 verify-don't-remember principle on the local side.
// The localStorage marker only gates whether the invoke runs (skip it when absent).
async function computeLocalExportComplete(): Promise<boolean> {
  const ttConfigPath = localStorage.getItem("tt_config_path");
  if (!ttConfigPath) return false;
  try {
    await invoke("read_client_config", { configPath: ttConfigPath });
    return true; // the real file exists and is readable
  } catch {
    return false; // stale/moved/deleted file → export pending
  }
}

// Build the finalized ServerProbe from the raw check_server_installation payload
// plus the real local-export check + configDiverges (Codex #9 — one contract).
function buildServerProbe(raw: RawServerProbe, localExportComplete: boolean): ServerProbe {
  return {
    installed: raw.installed,
    binaryInstalled: raw.binaryInstalled ?? false,
    credentialsExist: raw.credentialsExist ?? false,
    rulesExist: raw.rulesExist ?? false,
    vpnConfigExists: raw.vpnConfigExists ?? false,
    hostsConfigExists: raw.hostsConfigExists ?? false,
    certPresent: raw.certPresent ?? false,
    unitExists: raw.unitExists ?? false,
    unitEnabled: raw.unitEnabled ?? false,
    serviceActive: raw.serviceActive ?? false,
    partial: raw.partial ?? false,
    configDiverges: raw.configDiverges ?? false,
    localExportComplete,
  };
}

// ── Bounded silent whole-deploy retry on an SSH drop (WIZARD-03, D-03; Codex #6) ──
// deploy_server is a SINGLE RPC that owns all install stages internally — the
// frontend CANNOT retry one stage (the backend exposes no per-stage retry API). So
// the retry unit is the WHOLE idempotent deploy_server call: it relies on the
// deploy's existing idempotence (stop-before-start, install.sh re-run) + slice-2's
// no-clobber (credentials.toml is never double-written) + the iptables tag-on-install
// `-C` guard (a re-run never duplicates the firewall rule). A small bound prevents an
// infinite loop; on exhaustion we stop and surface the recovery fork (never loop).
const MAX_DEPLOY_RETRIES = 3;

// fix_17 (06-uat): the post-install reachability probe RETRIES before warning. The
// single immediate no-retry probe used to fire on `done` BEFORE the just-(re)started
// trusttunnel service was accepting TLS on 443 (worst right after a cancel+reinstall),
// producing a FALSE warning that definitively blamed the provider firewall. A bounded
// retry (PROBE_ATTEMPTS attempts spaced PROBE_DELAY_MS apart) gives the service time to
// come up; the warning is set ONLY after every attempt fails. Still fire-and-forget (it
// never blocks the already-rendered Done screen) and never throws/routes to error (D-16).
const PROBE_ATTEMPTS = 4;
const PROBE_DELAY_MS = 3000;

// Detect a TRANSIENT SSH/network drop worth a silent whole-deploy retry — a dropped
// connection / timeout / reset, NOT a deterministic failure (auth rejected, port in
// use, cert error) that a retry could not fix. Conservative: only the transport-drop
// family triggers the retry; everything else falls through to the error screen.
//
// C-13 (06-15): ssh_connection_refused is NO LONGER treated as transient. A refused
// connection is DETERMINISTIC (the SSH port is closed / no daemon listening / a
// firewall actively rejects) — re-running the WHOLE deploy up to 4 times cannot fix
// it, it only makes the user wait through four silent retries before reaching the
// SAME friendly ErrorStep message. Dropping the refused clause narrows the
// silent-retry set so a refusal fails FAST to that friendly message immediately. Note
// this only matches the explicit `ssh_connection_refused` token, NOT the prose
// "connection refused" — so an error string carrying another transient token (e.g.
// "connection reset") is unaffected.
export function isTransientSshError(errStr: string): boolean {
  const s = errStr.toLowerCase();
  return (
    s.includes("ssh_timeout") ||
    s.includes("ssh_connect_failed") ||
    s.includes("ssh_network_unreachable") ||
    // C-13: `ssh_connection_refused` deliberately removed (deterministic — fail fast).
    s.includes("connection reset") ||
    s.includes("connection closed") ||
    s.includes("broken pipe") ||
    s.includes("timed out") ||
    // WR-07: parenthesise the `&&` sub-expression so the grouping is explicit and a
    // future inserted term cannot silently change it (behavior is unchanged today).
    (s.includes("channel") && s.includes("eof")) ||
    s.includes("disconnected")
  );
}

// ── Resolved endpoint address derivation (C-10, 06-15) ──────────────────────
// Mirror the backend's export_address logic (deploy.rs:917-924) CLIENT-SIDE so the
// Done screen can show EXACTLY which address was baked into the client config:
//   - a Let's-Encrypt / provided-domain install bakes in `domain:port`
//   - a self-signed / no-domain install bakes in `host:port` (the SSH host/IP)
// The port is the last `:`-segment of listenAddress (default "443"). Returns "" when
// there is nothing to show (both domain and host empty). This is a PURE helper so it
// is unit-testable without a full hook mount.
export function deriveResolvedEndpointAddress(args: {
  domain: string;
  host: string;
  listenAddress: string;
}): string {
  const port = (() => {
    const segs = (args.listenAddress || "").split(":");
    const last = segs[segs.length - 1]?.trim();
    return last && last.length > 0 ? last : "443";
  })();
  const domain = args.domain.trim();
  const host = args.host.trim();
  if (domain) return `${domain}:${port}`;
  if (host) return `${host}:${port}`;
  return "";
}

// selfSignedNoDomain (C-10): true ONLY for a self-signed cert with no domain — the
// case where the baked-in address is the bare SSH host/IP and the self-signed cert
// identifies itself as `trusttunnel.local`, so the user needs the resolved address +
// the CN note to understand what was written. Pure helper for unit-testability.
export function deriveSelfSignedNoDomain(args: {
  certType: "selfsigned" | "letsencrypt" | "provided";
  domain: string;
}): boolean {
  return args.certType === "selfsigned" && !args.domain.trim();
}

// isIpv4Literal (06-15): the reachability probe must NOT run when the SNI it would
// send is an IPv4 literal — the backend `fetch_endpoint_cert` rejects an IP SNI
// (cert_probe.rs:208-213), so probing would always "fail" and produce a FALSE scare.
// Mirror that exact rule (all chars digits or dots AND exactly four dot-segments).
export function isIpv4Literal(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  return /^[0-9.]+$/.test(v) && v.split(".").length === 4;
}

// ── Resume secret: read the COARSE last-saved bundle, VALIDATE it (Codex #10 + F) ──
// load_ssh_credentials takes NO args and returns the LAST saved bundle
// {host, port, user, password (from the keyring), keyPath} — it is NOT keyed per
// host:port:user (Codex #10). On a machine that touched MULTIPLE servers the
// last-saved bundle may belong to a DIFFERENT server than the one being resumed.
// So before trusting the bundle's password we VALIDATE its host/port/user against
// the current resume target (round-2 finding F); on mismatch the wizard asks the
// user (D-08) instead of silently repopulating the wrong server's secret (which
// would then mislead the D-07 steering).
interface SshCredBundle {
  host?: string;
  port?: string; // the bundle returns port as a STRING (ssh_commands.rs:634)
  user?: string;
  password?: string;
  keyPath?: string;
}

// Validate the coarse bundle against the current resume target. Port is normalized
// to a string on both sides because the bundle stores it as a string while the
// wizard's `port` state is also a string — but we normalize defensively so a number
// never silently mismatches a string.
export function credentialsMatchTarget(
  bundle: SshCredBundle | null | undefined,
  target: { host: string; port: string; user: string },
): boolean {
  if (!bundle) return false;
  const samePort = String(bundle.port ?? "") === String(target.port ?? "");
  return (
    (bundle.host ?? "") === target.host &&
    samePort &&
    (bundle.user ?? "") === target.user
  );
}

// A missing/unavailable SSH secret surfaces a re-enter prompt rather than an
// opaque auth crash (D-08 affordance pulled forward, must-fix #1 second half).
// Detect the auth-failure family from the error string.
function isMissingSecretError(errStr: string): boolean {
  const s = errStr.toLowerCase();
  return (
    s.includes("ssh_key_load_failed") ||
    s.includes("ssh_key_reenter_required") || // D-08 (Task 1): missing/undecodable key
    s.includes("ssh_auth_failed") ||
    s.includes("ssh_password_rejected") ||
    s.includes("ssh_key_rejected") ||
    s.includes("no authentication") ||
    s.includes("authentication failed")
  );
}

// ─── localStorage helpers ──────────────────────────
// NOTE (05-01): wizard navigation now lives in the machine (machine.ts) and the
// non-secret snapshot is owned by persist.ts. The per-field saveField soup that
// used to live here is replaced by ONE saveSnapshot effect below; secrets
// (sshPassword/vpnPassword/sshKeyData) are no longer persisted at all (D-05).
const STORAGE_KEY = "trusttunnel_wizard";

// loadSaved still reads the NON-SECRET form fields the snapshot persists, so the
// existing restore behavior for host/port/etc. is unchanged. It is NEVER used to
// read a secret (those fields start empty — session-only, D-05).
function loadSaved<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const obj = JSON.parse(raw);
    return obj[key] !== undefined ? obj[key] : fallback;
  } catch {
    return fallback;
  }
}

// Raw single-key writer for the NON-SECRET auxiliary keys that are not part of
// the navigation Snapshot: the server-feature toggles and the render-only deploy
// progress (deploySteps/deployLogs/configPath/errorMessage, D-11). It is NEVER
// called with a secret — those fields are session-only (D-05). saveSnapshot owns
// the navigation snapshot; this stays for the disjoint auxiliary keys.
function saveField(key: string, value: unknown) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    obj[key] = value;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  } catch { /* ignore */ }
}

// Seed the machine's initial step from the persisted snapshot. The snapshot is a
// PRE-PAINT HINT only — it paints SOMETHING plausible before the mount probe runs,
// so the user does not see a flash of "welcome" on every reopen. It is NOT the
// source of truth: the server-verified resume mount effect (CR-01 fix) fires
// resolveResumeOnOpen() once when a saved host exists and OVERRIDES this seed at
// runtime with whatever the server reality resolves to (resolveResume). When no
// saved host exists there is nothing to probe and this seed is the final answer.
function seedStepFromSnapshot(): Step {
  // 06-uat install-only wizard: the welcome menu AND the in-wizard SSH-login (`server`)
  // + server-probe (`checking`) screens are deleted. `endpoint` (the install Settings
  // screen) is now the neutral default/fallback everywhere the seed used to return
  // `welcome`/`server`/`checking`. SSH auth happened in the Control Panel before the
  // wizard opened, so the wizard always enters at Settings.
  const snap = loadSnapshot();
  let saved = (snap.step ?? "endpoint") as Step;
  // Map every legacy/unreachable navigation step onto the install entry. These steps
  // still exist in the machine Step union (the Phase-5 invariance suites depend on
  // them) but the router can no longer render them.
  if (saved === "welcome" || saved === "server" || saved === "checking" || saved === "fetching") {
    saved = "endpoint";
  }
  const hasConfig = !!localStorage.getItem("tt_config_path");

  // No-false-flash on reopen/«Установить»: when a saved host exists, the mount probe
  // (resolveResumeOnOpen, gated on `host`) WILL fire and OVERRIDE this seed with
  // server-verified reality. In that window the seed is a transient placeholder, so
  // it must NOT show a misleading TERMINAL screen. A stale step="done"/"found" left
  // by a prior install otherwise flashes a false «Всё готово»/«Найдено» for ~0.5s
  // before the probe corrects it (the bug reported on clicking «Установить»). Seed the
  // neutral install entry (`endpoint`) instead — the probe lands on the REAL
  // "done"/"found"/"recovery" only after it confirms the server.
  const willProbe = !!snap.host;
  if (willProbe && (saved === "done" || saved === "found")) return "endpoint";

  // C-25 (06-15) — close-mid-install reopen anti-trap. The overlay close only HIDES the
  // wizard and the deploy state (deploySteps/deployLogs/errorMessage) PERSISTS across that
  // close. So reopening with a stale persisted IN-FLIGHT (`deploying`) or recovery/error
  // step would otherwise STRAND the user on a frozen progress / recovery / error screen
  // with no running operation behind it. At MOUNT there is by definition no live operation
  // (operationRef starts null), so a persisted non-terminal step with NO completed install
  // (no tt_config_path) cannot be a genuine in-flight resume — it is leftover from a closed
  // attempt. Resolve it to the clean install entry (`endpoint`; the mount probe still
  // OVERRIDES to the real screen when a saved host exists).
  if (!hasConfig && (saved === "deploying" || saved === "recovery" || saved === "error")) {
    return "endpoint";
  }

  // Transient/terminal steps with no completed install fall back to the install entry.
  if ((saved === "done" || saved === "deploying") && !hasConfig) return "endpoint";
  // Restorable steps: found (server already installed → manage/reinstall), endpoint
  // (install Settings), done (terminal success). The deleted `server` is never restored.
  const restorable: Step[] = ["found", "endpoint", "done"];
  if (restorable.includes(saved)) return saved;
  // In-flight deploy with a config restores to the endpoint screen.
  if (saved === "deploying") return "endpoint";
  // uninstalling is momentary — restore to the install entry.
  if (saved === "uninstalling") return "endpoint";
  // WR-03: "error" is NOT restorable — a persisted error carries stale context; the mount
  // probe re-derives true server state. Fall back to the neutral install entry.
  if (saved === "error") return "endpoint";
  return "endpoint";
}

// ─── Hook ──────────────────────────────────────────
interface UseWizardStateParams {
  // See SetupWizardProps.onSetupComplete — `register` gates the «Подключение» card add.
  onSetupComplete: (configPath: string, register?: boolean) => void;
  // onClose closes the wizard overlay (App's setWizardActive(false)). Consumed by
  // the first-screen "Назад" and the Done/Found post-install nav (D-01 / Pitfall 3).
  onClose?: () => void;
}

export function useWizardState({ onSetupComplete, onClose }: UseWizardStateParams) {
  // ── Wizard navigation — reducer-driven (WIZARD-01, D-11) ──
  // The step is the machine's state, seeded from the persisted snapshot. There
  // is NO compatibility shim mapping checking/uninstalling/fetching onto other
  // steps (Codex #8): the machine Step union holds them directly. setWizardStep
  // keeps the same call surface SetupWizard.tsx + the existing tests depend on —
  // internally it dispatches a GOTO so the reducer owns the step.
  const [machineState, dispatch] = useReducer(reducer, INITIAL_STATE, () => ({
    step: seedStepFromSnapshot(),
  }));
  const step = machineState.step;
  // fix_A (06-uat): stepRef mirrors the live step and is the single monotonic truth the
  // deploy-step listener reads at event-fire time (the listener is mounted once with an
  // empty dep array, so a direct `step` read there would be a stale closure). It MUST be
  // updated SYNCHRONOUSLY the instant setWizardStep is called — not only via a post-render
  // effect — because a deploy event can arrive in the SAME synchronous tick as a step
  // change (e.g. setWizardStep("deploying") immediately followed by deploy_server
  // streaming its first stage). An effect alone would still hold the stale prior step at
  // that moment, defeating the guard. Seeded from the same snapshot seed as the reducer.
  const stepRef = useRef<Step>(machineState.step);
  const setWizardStep = useCallback((s: WizardStep) => {
    // WizardStep ⊆ Step (proven in machine.ts), so the cast is widening-only.
    stepRef.current = s as Step; // synchronous mirror — see the stepRef comment above
    dispatch({ type: "GOTO", step: s as Step });
  }, []);

  // ── SSH credentials (persisted) ──
  const [host, setHost] = useState(() => loadSaved("host", ""));
  const [port, setPort] = useState(() => loadSaved("port", "22"));
  const [sshUser, setSshUser] = useState(() => loadSaved("sshUser", "root"));
  // Secret: session-only, NEVER restored from or persisted to localStorage (D-05).
  const [sshPassword, setSshPassword] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState(() => loadSaved("sshKeyPath", ""));
  const [sshKeyData, setSshKeyData] = useState("");
  const [showSshPassword, setShowSshPassword] = useState(false);

  // ── Explicit single auth choice (D-06) ──
  // authMode is the EXPLICIT, single, field-clearing choice the wizard sends to the
  // backend's auth_method. It is seeded from the persisted keyPath (a saved key ⇒
  // "key") and persisted as a non-secret hint, but it is NOT cosmetic: setAuthMode
  // CLEARS the unused credential so exactly one method ever crosses the IPC boundary
  // (the D-06 root fix — sending both was the "key rejected even though the password
  // works" bleed). Switching clears the other field because secrets are session-only
  // (D-08) — the SECURE behavior; a brief inline hint warns the user (Phase 6 polish).
  const [authMode, setAuthModeRaw] = useState<"password" | "key">(() =>
    loadSaved("sshKeyPath", "") ? "key" : "password"
  );
  const setAuthMode = useCallback((mode: "password" | "key") => {
    setAuthModeRaw(mode);
    if (mode === "key") {
      // Switching to key: drop any typed password so only the key is sent.
      setSshPassword("");
    } else {
      // Switching to password: drop any selected/pasted key so only the password is sent.
      setSshKeyPath("");
      setSshKeyData("");
    }
  }, []);

  // ── Endpoint settings (persisted) ──
  const [listenAddress, setListenAddress] = useState(() => loadSaved("listenAddress", "0.0.0.0:443"));
  const [vpnUsername, setVpnUsername] = useState(() => loadSaved("vpnUsername", ""));
  // Secret: session-only, NEVER restored from or persisted to localStorage (D-05).
  const [vpnPassword, setVpnPassword] = useState("");
  const [showVpnPassword, setShowVpnPassword] = useState(false);

  // ── First-user advanced posture (D-11, C-04) — SESSION-ONLY ──
  // The very first VPN user (created during install on the EndpointStep) gets the
  // SAME per-user advanced composition every later Users-tab user has. These are
  // deeplink-TLV params applied at CONFIG-EXPORT time (DoneStep deeplink/QR), NOT at
  // install time — credentials.toml only carries username+password (deploy.rs:180-183).
  // Default = DEFAULT_DEEPLINK (anti-DPI ON, useUserFormState.ts) so the first user
  // inherits the Users-tab DEFAULTS with NO silent weaker posture (C-04).
  //
  // SESSION-ONLY (D-29 / T-06-32): firstUserAdvanced may hold a pinned-cert DER blob,
  // so it is NEVER persisted to localStorage (no loadSaved / no saveField) — it lives
  // only for the duration of the install flow, mirroring the vpnPassword secret-at-rest
  // posture. The revealed/exported values never enter a log payload.
  const [firstUserAdvanced, setFirstUserAdvanced] = useState<DeeplinkFields>(DEFAULT_DEEPLINK);
  const updateFirstUserAdvanced = useCallback(<K extends keyof DeeplinkFields>(
    key: K,
    value: DeeplinkFields[K],
  ) => {
    setFirstUserAdvanced((prev) => ({ ...prev, [key]: value }));
  }, []);
  const [certType, setCertType] = useState<"selfsigned" | "letsencrypt" | "provided">(() => loadSaved("certType", "letsencrypt"));
  const [domain, setDomain] = useState(() => loadSaved("domain", ""));
  const [email, setEmail] = useState(() => loadSaved("email", ""));
  const [certChainPath, setCertChainPath] = useState(() => loadSaved("certChainPath", ""));
  const [certKeyPath, setCertKeyPath] = useState(() => loadSaved("certKeyPath", ""));
  const [showAdvanced, setShowAdvanced] = useState(false);

  // ── Advanced server settings (D-10, 06-09) — persisted ──
  // The 407/405 chooser for the auth-failure response disguise. Default 407 (matches
  // the server's CONFIGURATION.md v1.0.33 default); the backend re-validates the value
  // to the 405|407 enum (validate_auth_status_code), so this is just the chosen number.
  //
  // NOTE (06-uat install-wizard slimming): the Metrics (Prometheus), SOCKS5 upstream and
  // Allow-private-network toggles were REMOVED from the wizard end-to-end (rarely useful
  // for a non-technical operator; metrics/socks5 add a config-error surface). The ICMP
  // and IPv6 toggles were HIDDEN — their state is gone here, but the backend still writes
  // the safe ON defaults (icmp_enable = true, ipv6_available = true) unconditionally in
  // deploy.rs's build_intended_vpn_toml, so the generated vpn.toml is unchanged.
  const [authFailureStatusCode, setAuthFailureStatusCode] = useState<number>(() => loadSaved("authFailureStatusCode", 407));

  // ── Install-time server-protection toggles (WIZARD-06, D-01) ──
  // Both default ON: a non-technical operator gets a secure baseline (firewall closing
  // stray ports + fail2ban blocking brute-force) without having to opt in. These are
  // session-only install choices — NOT persisted to localStorage like certType/407,
  // because they describe a one-time provisioning action, not a remembered preference.
  // camelCase here → serde snake_case enable_firewall/enable_fail2ban in deploy.rs (Plan 01).
  const [enableFirewall, setEnableFirewall] = useState(true);
  const [enableFail2ban, setEnableFail2ban] = useState(true);

  // ── Server check state ──
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [checkError, setCheckError] = useState("");
  // D-08 (pulled forward): when a (re)open probe fails because the SSH secret is
  // missing/unavailable, surface a re-enter prompt instead of an opaque crash.
  const [secretMissing, setSecretMissing] = useState(false);

  // ── Recovery fork state (WIZARD-03, slice 3) ──
  // The last ServerProbe that landed the wizard on `recovery` — RecoveryStep reads
  // its `configDiverges` to decide whether to offer the "apply my settings" action
  // (round-2 finding C).
  const [recoveryProbe, setRecoveryProbe] = useState<ServerProbe | null>(null);
  // The cause that routed into recovery. "SSH_HOST_KEY_CHANGED" (D-09, Gemini #11 +
  // finding B) switches RecoveryStep to the reinstalled-server "trust the new key"
  // affordance; otherwise it is the partial-install fork. Empty = partial-install.
  const [recoveryCause, setRecoveryCause] = useState("");
  // True while a recovery action (Continue / Start over / Apply / Trust) is running,
  // so RecoveryStep can disable its buttons and show a working state.
  const [recoveryBusy, setRecoveryBusy] = useState(false);

  // ── Add user form ──
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [addingUser, setAddingUser] = useState(false);
  const [deletingUser, setDeletingUser] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [cameFromFound, setCameFromFound] = useState(false);

  // One-shot «install from the Control Panel» entry. ServerPanel set installEntry=true in
  // the snapshot before opening the wizard; we read it ONCE on mount and strip it so a
  // later reopen resumes via the server probe normally. When set, the mount effect loads
  // the SSH secret WITHOUT re-probing and the wizard stays on the seeded Settings screen —
  // the server-connect + «проверка» steps already happened in the Control Panel. Drives
  // both the no-probe mount path and the trimmed StepBar (настройки → установка).
  const [installEntry] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const obj = JSON.parse(raw);
      if (!obj || obj.installEntry !== true) return false;
      delete obj.installEntry;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  });

  // ── Deploy state — persisted ──
  const [deploySteps, setDeploySteps] = useState<Record<string, DeployStep>>(() => {
    try { return JSON.parse(loadSaved("deploySteps", "{}") as string); } catch { return {}; }
  });
  const [deployLogs, setDeployLogs] = useState<DeployLog[]>(() => {
    try { return JSON.parse(loadSaved("deployLogs", "[]") as string) as DeployLog[]; } catch { return []; }
  });
  const [showLogs, setShowLogs] = useState(false);
  const [errorMessage, setErrorMessage] = useState(() => loadSaved("errorMessage", ""));
  const [configPath, setConfigPath] = useState(() => loadSaved("configPath", ""));
  const [copied, setCopied] = useState(false);
  // ── Post-install reachability warning (C-09 / D-16, 06-15) — SESSION-ONLY ──
  // A soft signal set by the best-effort post-install reachability probe
  // (runReachabilityProbe, now retried — fix_17). NEVER persisted (no saveField / no
  // saveSnapshot) — it is a transient post-install hint that must not survive a reopen as
  // a stale scare. It is SOFT: it never blocks the primary CTA and never routes to the
  // error screen (D-16). fix_18 (06-uat): the in-UI «Понятно» dismiss affordance was
  // removed (the user wants an info-only banner), so there is no dismiss handler — the
  // warning simply persists for the session until a fresh mount resets it.
  const [reachabilityWarning, setReachabilityWarning] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Tracks current operation so the event listener only reacts to relevant events.
  // 06-uat: the install wizard is deploy-only — the manual server-check and the
  // standalone fetch flow were removed, so "fetch" is no longer a possible value.
  const operationRef = useRef<"deploy" | "uninstall" | null>(null);
  const operationIdRef = useRef(0);

  // ── Migrate-before-strip: move a legacy plaintext SSH password into Windows
  //    Credential Manager ONCE on first mount, BEFORE the snapshot-strip path can
  //    drop it (must-fix #1, D-05). StrictMode-safe via a ref guard (the Phase-2/
  //    Phase-4 single-fire pattern). The fire-and-forget call carries a terminal
  //    .catch so an app-close-mid-IPC rejection cannot bubble an unhandled
  //    promise rejection (round-2 finding I — migrateLegacySshPassword already
  //    resolves-on-failure; this is belt-and-suspenders). The handler MUST NOT
  //    log the password value (D-29).
  const migrationFiredRef = useRef(false);
  useEffect(() => {
    if (migrationFiredRef.current) return;
    migrationFiredRef.current = true;
    migrateLegacySshPassword().catch(() => {
      // Non-secret: WR-06 already prevents data loss; nothing to log (D-29).
    });
  }, []);

  // ── First-user credential seed (D-11, C-01) — once on first mount ──
  // The first VPN user gets a strong auto-generated credential pair on first open,
  // exactly like every other add-user surface (AddUserForm). We seed ONLY when the
  // field is empty, so a resumed install (vpnUsername restored from the non-secret
  // snapshot) or a value the user already typed is NEVER overwritten. The password is
  // session-only (D-05/D-29) — it is generated here but never persisted, so a resume
  // legitimately re-seeds a fresh password (the old one was never stored). StrictMode-
  // safe via a ref guard (the Phase-2/Phase-4 single-fire pattern). The generators use
  // crypto.getRandomValues and the value never reaches a log payload (D-29).
  const credentialSeedFiredRef = useRef(false);
  useEffect(() => {
    if (credentialSeedFiredRef.current) return;
    credentialSeedFiredRef.current = true;
    if (!vpnUsername) setVpnUsername(generateUsername());
    if (!vpnPassword) setVpnPassword(generatePassword());
    // Seed-once on mount: intentionally NOT re-run when the fields change (the guard
    // ref already enforces single-fire; the empty-checks read the mount-time values).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Persist the non-secret snapshot on change (ONE writer, replaces the
  //    per-field saveField soup). Secrets are excluded by construction — they
  //    are not even passed to saveSnapshot (D-05). deploySteps/deployLogs remain
  //    on their own saveField calls below (render-only progress, D-11).
  useEffect(() => {
    saveSnapshot({
      step,
      host,
      port,
      sshUser,
      keyPath: sshKeyPath,
      listenAddress,
      vpnUsername,
      certType,
      domain,
      email,
      certChainPath,
      certKeyPath,
    });
  }, [step, host, port, sshUser, sshKeyPath, listenAddress, vpnUsername, certType, domain, email, certChainPath, certKeyPath]);

  // authMode is a NON-SECRET hint (which auth method the user last chose); persist
  // it so the toggle restores correctly on reopen. The credential itself stays
  // session-only (D-05) — only the choice is remembered.
  useEffect(() => { saveField("authMode", authMode); }, [authMode]);

  // D-10 (06-09): the 407/405 chooser persists via its own raw key (not part of the
  // navigation snapshot). The Metrics/SOCKS5/Allow-private persistence was removed with
  // those wizard settings; ICMP/IPv6 persistence was removed when those toggles were
  // hidden (their safe ON defaults are now hard-coded in deploy.rs, not user-driven).
  useEffect(() => { saveField("authFailureStatusCode", authFailureStatusCode); }, [authFailureStatusCode]);

  // ── Persist deploy state ──
  useEffect(() => { saveField("deploySteps", JSON.stringify(deploySteps)); }, [deploySteps]);
  useEffect(() => { saveField("deployLogs", JSON.stringify(deployLogs.slice(-200))); }, [deployLogs]);
  useEffect(() => { saveField("configPath", configPath); }, [configPath]);
  useEffect(() => { saveField("errorMessage", errorMessage); }, [errorMessage]);

  // ── Copy logs to clipboard ──
  const copyLogsToClipboard = () => {
    const text = deployLogs.map((l) => `[${l.level}] ${l.message}`).join("\n");
    const full = errorMessage ? `ERROR: ${errorMessage}\n\n${text}` : text;
    navigator.clipboard.writeText(full).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // ── Auto-scroll logs ──
  useEffect(() => {
    if (logsEndRef.current && showLogs) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [deployLogs, showLogs]);

  // ── Tauri event listeners ──
  // activeOpIdRef holds the opId that was set when the current deploy/fetch started.
  // When cancel increments operationIdRef, stale events are ignored.
  const activeOpIdRef = useRef(0);
  // fix_A (06-uat): stepRef itself is declared+seeded near the top (and written
  // SYNCHRONOUSLY by setWizardStep) so the listener's top guard sees the live step even
  // when a deploy event arrives in the same tick as a step change. This effect is a
  // BACKSTOP: the reducer can also change step WITHOUT setWizardStep (PROBE_RESULT,
  // DEPLOY_RETRY_EXHAUSTED dispatches), so re-sync stepRef from `step` after every render
  // to cover those paths. (For the synchronous setWizardStep path this is a harmless
  // no-op re-assignment of the same value.)
  useEffect(() => { stepRef.current = step; }, [step]);
  // fix_16 (06-uat): the "finalize" phase guard. After deploy_server resolves,
  // handleDeploy runs persistFirstUserAdvanced + a fetch_server_config RE-EXPORT, and
  // that re-export emits its OWN deploy-step cycle (connect/auth/check/export/save/done)
  // while operationRef is still "deploy". Without a guard the deploy-step listener would
  // overwrite the all-green step rows back to "progress" → the bar drops & re-climbs (the
  // "second round" the user reported). finalizingRef freezes the green rows for the
  // listener (read synchronously at event-fire time, set in handleDeploy after the
  // deploy resolves, cleared in its finally). `finalizing` is a state mirror so the
  // DeployingStep can render ONE calm "Завершаем настройку…" line during the phase.
  const finalizingRef = useRef(false);
  const [finalizing, setFinalizing] = useState(false);
  // 06-15: the deploy-step listener is mounted ONCE with an empty dep array, so it would
  // capture a STALE runReachabilityProbe closure. Hold the latest probe in a ref the
  // listener reads at fire time, so the probe sees the current host/domain/creds.
  const reachabilityProbeRef = useRef<() => Promise<void>>(async () => {});

  // UAT (06-uat fix 5): set by handleDeploy AFTER the post-deploy advanced re-export +
  // setConfigPath(finalPath) settle. The streamed `done` deploy-step event fires from
  // inside deploy_server — BEFORE handleDeploy re-exports the per-login config and calls
  // setConfigPath(finalPath). If the streamed event transitioned to "done" directly, the
  // Done screen rendered the PRE-re-export path first then updated to finalPath → a
  // visible flicker of the config name/path. So for the DEPLOY path we suppress the
  // streamed transition and let handleDeploy transition once configPath has settled. The
  // standalone FETCH path (handleFetchConfig) keeps the streamed transition (its
  // setConfigPath already ran before its own done event, so there is no re-export gap).
  const deferDoneToHandleDeployRef = useRef(false);

  useEffect(() => {
    const unlistenStep = listen<DeployStep>("deploy-step", (event) => {
      // Ignore events from a cancelled/previous operation
      if (activeOpIdRef.current !== operationIdRef.current) return;

      // #22 (06-uat KEYSTONE): the BULLETPROOF cross-run gate. The activeOpIdRef ===
      // operationIdRef check above can NOT distinguish a stale event from a just-cancelled
      // run from the CURRENT run's own event, because every start/cancel/retry path resets
      // activeOpIdRef = operationIdRef (they are equal again the moment a fresh run is on
      // screen). So a late/buffered deploy-step event from the previous (cancelled) run
      // used to pass every gate and mutate the NEW run's deploySteps map → the impossible
      // mixed state the user reported (two yellow steps at once, a stale green/skipped row)
      // after cancel→re-install. The backend now STAMPS every deploy event with the run's
      // opId (deploy_server / fetch_server_config store it; emit_step / emit_log echo it),
      // and handleDeploy passes its myOpId as that stamp. Here we drop any event whose
      // stamped opId does not match the run we are showing. opId 0 / undefined = unstamped
      // (legacy caller or a test fixture that omits it) → accept, so existing flows are
      // unchanged. This makes cross-run bleed structurally impossible, not timing-dependent.
      const evtOpId = event.payload.opId ?? 0;
      if (evtOpId !== 0 && evtOpId !== activeOpIdRef.current) return;

      const { step: s, status, message } = event.payload;

      // fix_A (06-uat KEYSTONE): once the wizard has LEFT the active "deploying" progress
      // screen via cancel / retry-to-endpoint / a terminal done/error, NO late deploy event
      // may change the screen — neither a stale streamed `error` nor a stale `done`, and it
      // may not even mutate the step list. This is a single monotonic truth placed ABOVE any
      // state write, so no ref-bump race can defeat it: the moment `step` is no longer
      // "deploying", every queued event becomes a no-op. It SUBSUMES the old
      // `if (stepRef.current === "error") return;` that used to live only in the done branch
      // (the error branch had no such guard, so a late streamed `error` after leaving the
      // progress screen could repaint the error screen). stepRef mirrors the live step
      // synchronously via the effect below (the listener is mounted once, so a direct `step`
      // read here would be a stale closure).
      //
      // 06-uat: the "fetching" acceptance (the standalone FoundStep export / export-pending
      // resume route via handleFetchConfig) was dropped with the wizard's fetch flow. The
      // only streamed deploy events now come from deploy_server (and its finalize
      // re-export), which run on the "deploying" step.
      if (stepRef.current !== "deploying") return;

      // fix_CANCEL-BLOCKING (06-uat): while a cancel is in flight the wizard DELIBERATELY
      // stays on "deploying" (showing the "Отмена установки…" state) until uninstall_server
      // resolves — so the top guard above does NOT yet fire. During that whole kill+rollback
      // window the dying backend can still stream a late stage `error` or a stale `done`;
      // both must be dropped so there is NO error flash and NO false «Всё готово». This is
      // the synchronous companion to the cancellingRef set at the top of handleCancelDeploy
      // (the listener is mounted once, so a direct `cancellingDeploy` state read here would
      // be a stale closure — the ref is the live truth).
      if (cancellingRef.current) return;

      // fix_16 (06-uat): during the post-deploy FINALIZE phase (handleDeploy is
      // re-exporting the per-login config via fetch_server_config, which re-emits its
      // OWN connect/auth/check/export/save/done cycle while operationRef is still
      // "deploy"), skip step-list writes so the re-emitted steps don't drag the
      // all-green rows back to progress ("second round"). The terminal-transition
      // logic below is unaffected — the deploy's own `done` is already suppressed via
      // deferDoneToHandleDeployRef, and handleDeploy owns the transition.
      if (finalizingRef.current && operationRef.current === "deploy") return;

      setDeploySteps((prev) => ({ ...prev, [s]: { step: s, status, message } }));

      // 06-uat: only the deploy path streams these events now (the fetch flow was removed).
      const op = operationRef.current;
      if (op !== "deploy") return;

      if (s === "done" && status === "ok") {
        // fix_A (06-uat): the late-`done`-after-`error` drop that used to live here as
        // `if (stepRef.current === "error") return;` is now SUBSUMED by the top-of-
        // listener `if (stepRef.current !== "deploying") return;` guard — once the
        // wizard is on the error screen (or any non-deploying screen) this handler has
        // already returned. No separate error check is needed here.
        // C-09 / D-16 (06-15): fire the best-effort post-install reachability probe
        // ONLY on a real deploy success (never on fetch). Fire-and-forget with a
        // terminal .catch — the probe is non-fatal and already swallows its own errors;
        // the .catch is belt-and-suspenders so a rejection can never bubble.
        if (op === "deploy") {
          reachabilityProbeRef.current().catch(() => { /* soft, non-fatal (D-16) */ });
        }
        // UAT (06-uat fix 5): on the DEPLOY path, do NOT transition here — handleDeploy
        // owns the transition AFTER it re-exports and sets the final config path, so the
        // Done screen shows the correct path immediately (no flicker). The deploy path
        // also emits a SECOND `done` from its re-export fetch_server_config; both are
        // suppressed by this flag. On the FETCH path the streamed transition stands.
        if (op === "deploy" && deferDoneToHandleDeployRef.current) {
          return;
        }
        setTimeout(() => setWizardStep("done"), 600);
      }
      if (status === "error") {
        // UAT (06-uat fix 10): make the error branch TERMINAL. Bump the operation
        // generation + null the operation so ANY later streamed event from this same
        // failed attempt (notably a `done` that the backend may still emit after a
        // partial-stage error) is dropped by the gate at the top of this listener
        // (activeOpIdRef !== operationIdRef). Without this, a `done` delivered AFTER the
        // error still passed and scheduled a false transition to «Всё готово» with the
        // stale OLD config path. The defer flag is also cleared so no suppression leaks.
        operationIdRef.current += 1;
        operationRef.current = null;
        deferDoneToHandleDeployRef.current = false;
        setErrorMessage(message);
        setWizardStep("error");
      }
    });

    const unlistenLog = listen<DeployLog>("deploy-log", (event) => {
      // Ignore logs from a cancelled/previous operation
      if (activeOpIdRef.current !== operationIdRef.current) return;
      // #22: same per-run opId gate as the deploy-step listener — a stale log line from a
      // cancelled run must not pollute the new run's log tail / percent parsing.
      const evtOpId = event.payload.opId ?? 0;
      if (evtOpId !== 0 && evtOpId !== activeOpIdRef.current) return;
      setDeployLogs((prev) => [...prev.slice(-300), event.payload]);
    });

    return () => {
      unlistenStep.then((f) => f());
      unlistenLog.then((f) => f());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Action handlers ──

  // D-06: build the SSH credential args sending ONLY the chosen method. The wizard's
  // explicit authMode is the single source: "key" sends keyPath/keyData and NO
  // password; "password" sends the password and NO key. authMethod rides along so the
  // backend (Task 1) attempts exactly that one method — never the silent both-then-
  // prefer-key sequence that caused "key rejected even though the password works".
  // `passwordOverride` lets a freshly-loaded resume secret (finding F) be used in the
  // SAME tick — setSshPassword is async, so the closure's sshPassword would still be
  // stale when runResumeProbe runs synchronously right after the load.
  const buildAuthArgs = useCallback((passwordOverride?: string) => {
    if (authMode === "key") {
      return {
        password: "",
        keyPath: sshKeyPath || undefined,
        keyData: sshKeyData || undefined,
        authMethod: "key" as const,
      };
    }
    return {
      password: passwordOverride ?? sshPassword,
      keyPath: undefined,
      keyData: undefined,
      authMethod: "password" as const,
    };
  }, [authMode, sshPassword, sshKeyPath, sshKeyData]);

  const handleUninstall = async () => {
    operationRef.current = "uninstall";
    setWizardStep("uninstalling");
    setDeploySteps({});
    setDeployLogs([]);
    setErrorMessage("");
    try {
      try { await invoke("vpn_disconnect"); } catch { /* already disconnected */ }
      // CR-02/D-06: send ONLY the chosen auth method via buildAuthArgs. In key mode
      // sshPassword is cleared to "" — a hand-rolled `password: sshPassword` without
      // authMethod would make the backend fall through to an empty-password attempt
      // under LegacySequence. buildAuthArgs() carries authMethod so exactly one
      // method crosses the boundary.
      await invoke("uninstall_server", {
        host,
        port: parseInt(port),
        user: sshUser,
        ...buildAuthArgs(),
      });
      operationRef.current = null;
      setServerInfo(null);
      // 06-uat: the in-wizard `server` screen was removed — a successful uninstall from the
      // FoundStep «Удалить TT» path now closes the overlay back to the Control Panel (the
      // single SSH entry point) instead of routing to a deleted SSH-login screen.
      onClose?.();
    } catch (e) {
      operationRef.current = null;
      setErrorMessage(formatError(e));
      setWizardStep("error");
    }
  };

  const [cancellingDeploy, setCancellingDeploy] = useState(false);
  // fix_CANCEL-BLOCKING (06-uat): a SYNCHRONOUS mirror of "a cancel is in progress",
  // read by the deploy-step listener (which is mounted once → a direct `cancellingDeploy`
  // read there would be a stale closure) and by handleDeploy's in-flight guard. It is set
  // the instant handleCancelDeploy starts and cleared only AFTER uninstall_server resolves,
  // so for the WHOLE blocking kill+rollback window every late deploy event is dropped and
  // no second install can start. Mirrors the stepRef synchronous-write pattern.
  const cancellingRef = useRef(false);

  // ── Cancel = a REAL, blocking «Отмена установки…» (kill + full rollback) ──
  //
  // BUG this fixes (confirmed by user): the prior fix made cancel return to the Endpoint
  // settings SYNCHRONOUSLY (setWizardStep("endpoint") at the TOP, before awaiting
  // uninstall_server) only to avoid an error flash. That returned the user to settings
  // while the real kill + rollback was STILL in flight on the server, so they could
  // immediately click «Установить» again → the NEW install OVERLAPPED the OLD one still
  // being torn down → first a deploying screen, then a red «Неизвестная ошибка», then a
  // FALSE «Всё готово» as the two racing runs collided.
  //
  // NEW behavior: cancel is an awaited operation the user CANNOT bypass. The wizard STAYS
  // on the deploying screen showing the "Отмена установки…" state (spinner + label, the
  // cancel button disabled) and BLOCKS until uninstall_server (the real PID-group kill of
  // the in-flight deploy + the full rollback/uninstall: stop service, remove what was
  // installed, dpkg self-heal, free 443) resolves. ONLY THEN do we clear the deploy state
  // and return to the Endpoint settings (form data preserved). By then the old install is
  // fully gone, so a subsequent «Установить» is clean — no overlap, no false done.
  const handleCancelDeploy = async () => {
    // Already cancelling? Ignore re-clicks (the button is disabled in this state, but
    // guard defensively so a double-fire can never start a second uninstall).
    if (cancellingRef.current) return;
    // SYNCHRONOUS first: mark cancelling so the listener drops every late deploy event for
    // the whole kill+rollback window (set BEFORE any await — the listener reads the ref).
    cancellingRef.current = true;
    setCancellingDeploy(true);
    // Increment operationId so stale deploy-step events are ignored by the activeOpIdRef
    // gate as well (belt-and-suspenders alongside the cancellingRef gate).
    operationIdRef.current += 1;
    // UAT (06-uat fix 4): ALSO bump activeOpIdRef. The in-flight handleDeploy captured
    // myOpId = the PREVIOUS activeOpIdRef value; killing the deploy makes deploy_server
    // reject with Err, which reaches handleDeploy's catch. Bumping it here makes the
    // catch-guard (`if (activeOpIdRef.current !== myOpId) return;`) fire so the killed
    // deploy returns early, never reaching the error screen.
    activeOpIdRef.current = operationIdRef.current;
    // Clear the deploy "done"-defer flag — the cancelled deploy will never reach its own
    // setConfigPath/transition, so leave no stale suppression behind.
    deferDoneToHandleDeployRef.current = false;
    // Invalidate the running deploy's streamed events + its deploy_server-rejection catch.
    operationRef.current = null;
    // CRITICAL: do NOT setWizardStep("endpoint") yet. Keep the wizard on the deploying
    // screen, which now renders the "Отмена установки…" / cancelling state. The user is
    // therefore on the cancelling screen — NOT on settings — for the whole await, so they
    // physically cannot re-click «Установить» until the rollback completes. The error-flash
    // that the old synchronous-endpoint fix was avoiding is instead prevented by the
    // cancellingRef listener gate (every deploy event is dropped while cancelling).
    try {
      // 06-uat cancel→reinstall race: abort the in-flight deploy_server FIRST. cancel_deploy
      // bumps the backend deploy generation so every cancellable server-side stage aborts
      // (~250ms) and the run unwinds, releasing the backend single-flight guard. Without
      // this the LOCAL deploy future kept running and its configure stage raced
      // uninstall_server's `rm -rf /opt/trusttunnel` («наслоение процессов»). uninstall_server
      // then waits (await_deploy_idle) for the abort before its destructive rollback.
      try { await invoke("cancel_deploy"); } catch { /* best-effort local signal */ }
      // CR-02/D-06: single chosen method via buildAuthArgs (see handleUninstall).
      // uninstall_server is the existing cocoon cleanup: build_stop_in_progress kills the
      // deploy PID group, then it stops the service, removes the install, dpkg self-heals
      // and frees 443. Best-effort — on failure we still proceed (never throw/trap).
      await invoke("uninstall_server", {
        host,
        port: parseInt(port),
        user: sshUser,
        ...buildAuthArgs(),
      });
    } catch (e) {
      // Uninstall failed (e.g. no internet) — proceed anyway. D-29: only the SANITIZED
      // error string is logged; uninstall_server's payload carries no password.
      console.warn(`cancel.uninstall_failed err=${sanitizeLogMessage(formatError(e))}`);
    }
    // ONLY AFTER the rollback resolves: clear the cancelling state, wipe the deploy state,
    // and THEN return to the Endpoint SETTINGS (form data preserved). Now the old install
    // is fully gone, so the next «Установить» is clean — no overlap possible.
    cancellingRef.current = false;
    setCancellingDeploy(false);
    setDeploySteps({});
    setDeployLogs([]);
    setErrorMessage("");
    setServerInfo(null);
    // UAT (06-uat fix 13): «Отмена» returns to the Endpoint SETTINGS (data preserved), not
    // a full close — cancelling is usually a "let me change a setting" moment. The overlay
    // × (App.tsx) remains the explicit full-close affordance.
    setWizardStep("endpoint");
  };

  // fix_B (06-uat): retry-to-endpoint from the ErrorStep «Попробовать снова» (deploy
  // mode). The old wiring did a BARE setWizardStep("endpoint") with NO generation bump —
  // so a still-streaming deploy / a pending deploy_server rejection from the SAME failed
  // attempt could re-show the error screen the moment the user left it. This invalidates
  // the operation generation FIRST (advancing activeOpIdRef PAST any captured myOpId, so
  // handleDeploy's in-flight catch returns early and the listener's gate drops every
  // queued event), clears the deploy state, THEN navigates. fix_A's top-of-listener
  // guard also covers this: once step leaves "deploying"/"error" no deploy event lands.
  // Fetch-mode retry + the port-80-busy branch are UNCHANGED (they keep their own wiring).
  const handleRetryToEndpoint = useCallback(() => {
    operationIdRef.current += 1;
    activeOpIdRef.current = operationIdRef.current; // advanced PAST any captured myOpId
    operationRef.current = null;
    deferDoneToHandleDeployRef.current = false;
    setErrorMessage("");
    setDeployLogs([]);
    setDeploySteps({});
    setWizardStep("endpoint");
  }, [setWizardStep]);

  // ── Post-install reachability probe (C-09 / D-16, 06-15) — best-effort, SOFT ──
  // After a successful install «Всё готово» only proves the port LISTENS locally; a
  // cloud Security Group / provider firewall blocking inbound 443 is invisible until
  // the client cannot connect. This runs a best-effort OUTBOUND TLS reachability probe
  // against the resolved endpoint and, on failure, sets ONLY a soft dismissable Done
  // warning (reachabilityWarning). It is deliberately non-fatal:
  //   - install success is independent of the probe (deploy_server returning the config
  //     path is the source of truth);
  //   - the probe NEVER throws to the caller, NEVER routes to "error";
  //   - when it CANNOT run (empty host, or the SNI it would send is an IP — the backend
  //     fetch_endpoint_cert rejects an IP SNI, cert_probe.rs:208-213) it does NOTHING and
  //     leaves the warning false: a probe that could not run must not produce a FALSE
  //     scare (D-16 — a false scare is worse than no warning).
  // It REUSES the already-registered server_fetch_endpoint_cert command (no new Tauri
  // command, no new probe path). D-29: the SSH creds passed are arguments to the
  // existing command ONLY (for connection-pool reuse) — never logged here.
  const runReachabilityProbe = useCallback(async () => {
    const addr = deriveResolvedEndpointAddress({ domain, host, listenAddress });
    if (!addr) return; // nothing resolved → cannot probe, no scare
    const lastColon = addr.lastIndexOf(":");
    const probeHost = lastColon > 0 ? addr.slice(0, lastColon) : addr;
    const portStr = lastColon > 0 ? addr.slice(lastColon + 1) : "443";
    const certPort = parseInt(portStr, 10) || 443;
    if (!probeHost) return; // no host → cannot probe
    // The SNI is the domain when set, else the probe host. If that SNI would be an IP
    // the backend rejects it (always-fails) → skip rather than false-scare.
    const sniHost = (domain.trim() || probeHost).trim();
    if (isIpv4Literal(sniHost)) return; // IP SNI → probe cannot run, no scare
    // fix_17 (06-uat): bounded retry. The freshly-(re)started service may not yet accept
    // TLS on 443 the instant `done` fires (especially after a cancel+reinstall), so a
    // single immediate probe produced FALSE scares. Retry up to PROBE_ATTEMPTS times,
    // spaced PROBE_DELAY_MS apart; return on the FIRST success (no warning). Only after
    // ALL attempts fail do we set the soft warning. Mirror CertificateFingerprintCard's
    // arg shape; the creds ride buildAuthArgs so exactly the chosen single method crosses
    // IPC (D-06). Swallow ALL errors per attempt (D-16) — never rethrow, never route to
    // "error". This stays fire-and-forget; the Done screen has already rendered.
    for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, PROBE_DELAY_MS));
      try {
        await invoke("server_fetch_endpoint_cert", {
          host,
          port: parseInt(port),
          user: sshUser,
          ...buildAuthArgs(),
          hostname: probeHost,
          certPort,
          sniHost,
        });
        return; // reachable → no warning
      } catch {
        // keep retrying — a not-yet-ready service comes up within a few seconds
      }
    }
    // Every attempt failed → soft, persistent (fix_18: info-only) warning. NEVER
    // rethrow, NEVER setWizardStep("error"). D-29: nothing logged.
    setReachabilityWarning(true);
  }, [domain, host, listenAddress, port, sshUser, buildAuthArgs]);

  // Keep the listener-read ref pointed at the latest probe closure (see the ref decl).
  useEffect(() => {
    reachabilityProbeRef.current = runReachabilityProbe;
  }, [runReachabilityProbe]);

  // 06-uat Option X: persist the first user's TRIMMED advanced posture to the real
  // server-side user AFTER a successful deploy_server, via the SAME two existing-user
  // side-store commands the Users-tab "Edit" path uses (UserModal.handleSave):
  //   - server_update_user_config → rules.toml  (anti-DPI prefix; writes when antiDpi)
  //   - server_set_user_advanced  → users-advanced.toml (display name, customSni=LE
  //     domain, dns upstreams; the trimmed first-user set never sets pin-cert /
  //     skip-verification / custom upstream-protocol, so those stay at safe defaults)
  //
  // Why NOT server_add_user_advanced: its Step 1 (add_server_user_internal) ERRORS
  // SSH_USER_ALREADY_EXISTS for this just-created user and its rollback would DELETE
  // the user from credentials.toml — corrupting the fresh install. These two commands
  // never touch credentials.toml, so the D-02 no-clobber invariant is preserved.
  //
  // BEST-EFFORT: any failure here is swallowed + warned (sanitized, D-29) — the install
  // already succeeded. customSni = the LE domain (only for letsencrypt): the LE domain
  // IS the deployed hostname, so it passes the server's allowed_sni validation.
  const persistFirstUserAdvanced = useCallback(async (): Promise<void> => {
    try {
      const username = vpnUsername.trim();
      const adv = firstUserAdvanced;
      const leDomain = certType === "letsencrypt" ? domain.trim() : "";

      // 1) rules.toml — anti-DPI prefix. regeneratePrefix=true so a fresh first user
      //    gets a freshly-generated prefix (there is no prior prefix to preserve).
      await invoke("server_update_user_config", {
        host,
        port: parseInt(port),
        user: sshUser,
        ...buildAuthArgs(),
        username,
        cidr: null,
        antiDpi: adv.antiDpi,
        regeneratePrefix: true,
      });

      // 2) users-advanced.toml — display name / SNI / DNS. Shape = UserAdvanced struct
      //    (snake_case keys), matching server_set_user_advanced's `params`. The trimmed
      //    first-user set has no pin-cert / skip-verify / custom upstream-protocol.
      await invoke("server_set_user_advanced", {
        host,
        port: parseInt(port),
        user: sshUser,
        ...buildAuthArgs(),
        params: {
          username,
          display_name: adv.displayName.trim().length > 0 ? adv.displayName.trim() : null,
          custom_sni: leDomain.length > 0 ? leDomain : null,
          upstream_protocol: null,
          skip_verification: false,
          pin_cert_der_b64: null,
          dns_upstreams: adv.dnsUpstreams,
          anti_dpi: adv.antiDpi,
        },
      });
    } catch (err) {
      // D-29: only the SANITIZED error string reaches the log channel; no password is
      // ever present in either command's payload. Never rethrow — install succeeded.
      console.warn(
        `first_user.advanced_persist_failed err=${sanitizeLogMessage(formatError(err))}`,
      );
    }
  }, [vpnUsername, firstUserAdvanced, certType, domain, host, port, sshUser, buildAuthArgs]);

  // overwriteConfig (round-3 LOW C): a normal fresh deploy never overwrites existing
  // server config — the 05-03 "apply my settings" recovery action (handleApplyConfig)
  // is the only caller that passes true. credentials.toml is preserved regardless
  // (D-02). The param defaults false so every existing call site (EndpointStep,
  // ErrorStep retry, FoundStep reinstall) keeps the fresh-deploy semantics unchanged.
  const handleDeploy = async (opts?: { overwriteConfig?: boolean; overrideCertType?: "selfsigned" | "letsencrypt" | "provided" }) => {
    // fix_CANCEL-BLOCKING (06-uat): NO-OVERLAP guard. A second install must never start
    // while one is already deploying OR while a cancel's kill+rollback is still in flight —
    // overlapping installs race on the server and produce the red «Неизвестная ошибка» →
    // false «Всё готово» the user reported. The cancelling screen already keeps the user
    // off the «Установить» button during cancel, but guard here too so no programmatic path
    // (App's «Установить» entry, a double-click, a retry) can ever launch an overlapping run.
    if (operationRef.current === "deploy" || cancellingRef.current) return;
    const overwriteConfig = opts?.overwriteConfig ?? false;
    // WR-01: setCertType is an async React setter, so a caller that does
    // setCertType("selfsigned") then handleDeploy() in the SAME tick (the
    // port-80-busy "switch to self-signed" button in ErrorStep) would have
    // handleDeploy read the STALE certType from this closure. An explicit
    // overrideCertType bypasses that race — deployArgs reads this effective value,
    // not the not-yet-committed state.
    const effectiveCertType = opts?.overrideCertType ?? certType;
    operationIdRef.current += 1;
    activeOpIdRef.current = operationIdRef.current;
    // Capture THIS operation's generation so a stale retry from a superseded
    // operation (cancel / a newer deploy) is dropped (Codex #6 generation guard).
    const myOpId = operationIdRef.current;
    operationRef.current = "deploy";
    // UAT (06-uat fix 5): own the "done" transition in handleDeploy (after the re-export
    // + setConfigPath), so the streamed `done` event does NOT transition early and flash
    // the pre-re-export config path. Reset on every error path below so a later FETCH
    // (which relies on the streamed transition) is never accidentally suppressed.
    deferDoneToHandleDeployRef.current = true;
    setWizardStep("deploying");
    setDeploySteps({});
    setDeployLogs([]);
    setErrorMessage("");
    // C-09 / 06-15: a retry starts clean — clear any prior soft reachability warning so
    // a successful re-deploy is not haunted by an earlier probe's stale scare.
    setReachabilityWarning(false);

    const deployArgs = {
      host,
      port: parseInt(port),
      user: sshUser,
      // CR-02/D-06: single chosen method via buildAuthArgs (see handleUninstall).
      ...buildAuthArgs(),
      overwriteConfig,
      // #22 (06-uat): stamp THIS run's generation so the backend echoes it on every
      // streamed deploy event and the listener drops a stale event from a cancelled run.
      opId: myOpId,
      settings: {
        listenAddress,
        vpnUsername,
        vpnPassword,
        // WR-01: use the effective (possibly overridden) cert type everywhere the
        // cert choice gates a field, so a same-tick override is applied atomically
        // rather than reading the stale closure state.
        certType: effectiveCertType,
        domain: effectiveCertType === "letsencrypt" ? domain : "",
        clientName: vpnUsername,
        email: effectiveCertType === "letsencrypt" ? email : "",
        // 06-uat install-wizard slimming: icmpEnable / ipv6Available are NO LONGER sent
        // — the backend hard-codes their safe ON defaults (icmp_enable = true,
        // ipv6_available = true) in build_intended_vpn_toml, so the written vpn.toml is
        // unchanged. The serde #[serde(default = "default_true")] on those fields also
        // keeps any legacy payload (which omits them) on the same ON default.
        certChainPath: effectiveCertType === "provided" ? certChainPath : "",
        certKeyPath: effectiveCertType === "provided" ? certKeyPath : "",
        // D-10 (06-09): the 407/405 chooser (camelCase → serde auth_failure_status_code).
        // The Metrics / SOCKS5 / Allow-private fields were removed with those wizard
        // settings; allow_private_network_connections is now a hard-coded `false` in
        // deploy.rs (safe default, opt-in exposure dropped from the install flow).
        authFailureStatusCode,
        // WIZARD-06 / D-01: install-time server-protection flags. Sent for EVERY cert
        // type (not gated like domain/email) — they describe firewall/fail2ban
        // provisioning, independent of the TLS choice. serde maps them to
        // enable_firewall / enable_fail2ban on the Rust side (Plan 01).
        enableFirewall,
        enableFail2ban,
        // IN-04 (filename branding): best-effort GeoIP country for this host so the
        // backend brands the on-disk config `[<CC>_]TrustTunnel_<login>.toml`, matching
        // the Save-As default. Read synchronously from the already-cached GeoIP (no
        // fetch, never blocks the deploy); `undefined` when unknown → backend writes the
        // un-prefixed branded name. The backend ignores any malformed value defensively.
        countryCode: readCachedCountryCode(host) || undefined,
      },
    };

    // Codex #6 honest retry: deploy_server is a single RPC owning all stages — the
    // frontend retries the WHOLE idempotent call (slice-2 no-clobber + iptables
    // tag-on-install `-C` guard make it safe), NOT a per-stage retry the backend
    // doesn't expose; bounded + generation-guarded; on exhaustion stop at the fork —
    // never loop.
    try {
      let attempt = 0;
      // The loop re-invokes the WHOLE deploy_server on a TRANSIENT SSH drop, up to
      // MAX_DEPLOY_RETRIES extra attempts (so MAX_DEPLOY_RETRIES+1 total invokes).
      for (;;) {
        // A newer operation superseded this one (cancel / restart) → drop silently.
        if (activeOpIdRef.current !== myOpId) return;
        try {
          const result = await invoke<string>("deploy_server", deployArgs);
          if (activeOpIdRef.current !== myOpId) return; // superseded mid-flight
          // fix_16 (06-uat): enter the FINALIZE phase. From here on the post-deploy
          // persistFirstUserAdvanced + the fetch_server_config RE-EXPORT re-emit a fresh
          // deploy-step cycle while operationRef is still "deploy". finalizingRef freezes
          // the all-green step rows for the listener (no "second round"); `finalizing`
          // mirrors it so DeployingStep can show ONE calm "Завершаем настройку…" line.
          // Cleared in the `finally` below (and the per-attempt early returns leave the
          // loop entirely, where the finally still runs).
          finalizingRef.current = true;
          setFinalizing(true);
          // 06-uat Option X: persist the FIRST user's advanced settings to the real
          // server-side user so they show up in the Users-tab editor + user config
          // (anti-DPI → rules.toml, displayName/customSni/dnsUpstreams → users-advanced.toml),
          // closing the gap where install wrote ONLY credentials.toml and those fields
          // stayed export-only (empty in the editor).
          //
          // CRITICAL credentials.toml no-clobber (verified against server_install.rs):
          // `add_server_user_internal` ERRORS with SSH_USER_ALREADY_EXISTS when the
          // username is already present (it was just written by deploy_server for this
          // same user), and `server_add_user_advanced`'s rollback would then REMOVE the
          // user — corrupting the install. So we do NOT call the full add-user command.
          // Instead we write ONLY the two side-stores the Users-tab "Edit" path uses for
          // an EXISTING user, neither of which touches credentials.toml:
          //   - server_update_user_config → rules.toml (anti-DPI prefix)
          //   - server_set_user_advanced  → users-advanced.toml (display name, SNI, DNS, …)
          //
          // BEST-EFFORT: a failure here must NOT fail the already-successful install —
          // the user is connected and credentials.toml is written. We swallow + warn
          // (D-29: only the SANITIZED error string is logged; no password is ever in
          // these payloads — neither command carries vpnPassword).
          await persistFirstUserAdvanced();

          // 06-uat (install advanced parity): the basic <login>.toml that deploy_server
          // just wrote (returned as `result`) carries ONLY the bare endpoint export —
          // no anti-DPI / Custom SNI / DNS / display name. persistFirstUserAdvanced()
          // above wrote those to the server-side rules.toml + users-advanced.toml, so
          // re-exporting NOW (the SAME command the Users-tab "save config" uses)
          // overlays them and overwrites the SAME per-login <login>.toml (server_config.rs
          // now targets client_config_filename(name), matching deploy). Result: the
          // install-time active config matches the Users-tab save exactly.
          //
          // ORDER is load-bearing: deploy → persistFirstUserAdvanced (writes the files)
          // → fetch_server_config (reads them). The awaits are sequential so timing holds.
          //
          // BEST-EFFORT: a re-export failure must NOT fail the already-successful install
          // — fall back to the basic deploy path. D-29: only the SANITIZED error is logged
          // and neither fetch_server_config nor its payload carries a password.
          let finalPath = result;
          try {
            const reexported = await invoke<string>("fetch_server_config", {
              host,
              port: parseInt(port),
              user: sshUser,
              // CR-02/D-06: single chosen method via buildAuthArgs (see handleUninstall).
              ...buildAuthArgs(),
              clientName: vpnUsername.trim(),
              // #22: the FINALIZE re-export belongs to the SAME run as the deploy, so it
              // carries the deploy's myOpId — its re-emitted step cycle is stamped with the
              // on-screen run (finalizingRef still freezes the green rows; this just keeps
              // the events from being mis-attributed to a different generation).
              opId: myOpId,
              // The FINALIZE re-export OVERWRITES the same on-disk config, so it must
              // brand identically to the deploy write — pass the cached country too.
              countryCode: readCachedCountryCode(host) || undefined,
            });
            if (activeOpIdRef.current !== myOpId) return; // superseded mid-flight
            finalPath = reexported;
          } catch (e) {
            if (activeOpIdRef.current !== myOpId) return; // superseded mid-flight
            console.warn(
              `first_user.advanced_reexport_failed err=${sanitizeLogMessage(formatError(e))}`,
            );
          }
          // UAT (06-uat fix 5): set the FINAL config path, THEN transition to "done".
          // Doing the transition here (not from the streamed `done` event) guarantees the
          // Done screen renders with the settled finalPath on first paint — no flicker.
          // The 600ms settle preserves the prior "finalizing" dwell the streamed path had.
          setConfigPath(finalPath);
          deferDoneToHandleDeployRef.current = false;
          setTimeout(() => {
            // Generation-guard: a cancel / newer deploy after this point must win.
            if (activeOpIdRef.current !== myOpId) return;
            setWizardStep("done");
          }, 600);
          return; // success
        } catch (e) {
          if (activeOpIdRef.current !== myOpId) return; // superseded mid-flight
          // UAT (06-uat fix 5): clear the defer flag on EVERY error exit so a later
          // standalone fetch (which relies on the streamed transition) is not suppressed.
          deferDoneToHandleDeployRef.current = false;
          const errStr = formatError(e);
          // Retry only on a transient SSH drop AND while under the bound.
          if (isTransientSshError(errStr) && attempt < MAX_DEPLOY_RETRIES) {
            attempt += 1;
            continue; // silent re-invoke of the WHOLE idempotent deploy
          }
          // Retry exhausted on a transient drop → surface the recovery fork (D-03):
          // the user gets Continue / Start over instead of an endless manual retry.
          if (isTransientSshError(errStr)) {
            setErrorMessage((prev) => prev || errStr);
            setRecoveryCause("");
            setRecoveryProbe(null);
            dispatch({ type: "DEPLOY_RETRY_EXHAUSTED" }); // deploying → recovery
            return;
          }
          // A deterministic (non-transient) failure → the normal error screen.
          // UAT (06-uat fix 10): make the error terminal. Bump the operation generation
          // BEFORE the transition so a `done` event still queued from THIS attempt (the
          // backend can stream `done` for the last completed stage even as a later stage
          // fails) is filtered by the listener's gate (activeOpIdRef !== operationIdRef)
          // and can never flip the error screen to a false «Всё готово» with the stale
          // OLD config path. (persistFirstUserAdvanced + fetch_server_config stay on the
          // success path only — they are never reached here.)
          operationIdRef.current += 1;
          setErrorMessage((prev) => prev || errStr);
          setWizardStep("error");
          return;
        }
      }
    } finally {
      operationRef.current = null;
      // fix_16 (06-uat): leave the FINALIZE phase on EVERY exit (success, error,
      // recovery, or a superseded early return — all unwind through this finally). The
      // freeze must never outlive the deploy: a later operation re-uses the listener and
      // must be able to write step rows again.
      finalizingRef.current = false;
      setFinalizing(false);
    }
  };

  const handleSkip = async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: "TrustTunnel Config", extensions: ["toml"] }],
    });
    if (selected) {
      // Import → go to VPN settings, not control panel. register=true: a manual import is an
      // EXPLICIT «add this config», so it must appear as a card (unlike a plain install finish).
      localStorage.setItem("tt_navigate_after_setup", "settings");
      try {
        const copied = await invoke<string>("copy_config_to_app_dir", { sourcePath: selected as string });
        onSetupComplete(copied, true);
      } catch {
        onSetupComplete(selected as string, true);
      }
    }
  };

  // ── Server-verified resume on (re)open (WIZARD-02, D-02; round-2 findings D, G;
  //    round-3 MEDIUM B) ──
  // resume override: plan 05-02 — resolveResume(probe) replaces the persisted-step
  // seed. On (re)open, probe the server, compute localExportComplete via a REAL
  // read_client_config file check, build the ServerProbe, dispatch PROBE_RESULT,
  // and set the step to resolveResume(probe). The persisted step is a HINT, not the
  // answer (the counter-vs-server invariant).
  // Shared probe-and-route core (WIZARD-02 + slice-3 finding E). Probes the server,
  // computes the REAL local-export, builds the ServerProbe, dispatches PROBE_RESULT,
  // and ROUTES via resolveResume — the SINGLE source of truth for the resume step.
  // Returns the resolved Step (or null if it errored). `resolveResumeOnOpen` and the
  // recovery `handleContinue` BOTH go through this so Continue never hard-codes its
  // destination (round-2 finding E) — it asks the server and re-runs resolveResume.
  const runResumeProbe = async (passwordOverride?: string): Promise<Step | null> => {
    const raw = await invoke<RawServerProbe>("check_server_installation", {
      host,
      port: parseInt(port),
      user: sshUser,
      // D-06: resume probes go through the SAME single-method connect args.
      // passwordOverride carries a just-loaded resume secret (finding F) past the
      // stale-closure window before setSshPassword commits.
      ...buildAuthArgs(passwordOverride),
    });
    const localExportComplete = await computeLocalExportComplete();
    const probe = buildServerProbe(raw, localExportComplete);
    dispatch({ type: "PROBE_RESULT", probe });
    const next = resolveResume(probe);
    // Keep the probe so the recovery screen can offer "apply my settings" only when
    // the server config diverges (finding C). Clear any host-key-changed cause — a
    // successful probe means the connection succeeded (the key is trusted).
    if (next === "recovery") {
      setRecoveryProbe(probe);
      setRecoveryCause("");
    }
    // 06-uat: the export-pending → auto-start-fetch branch was removed with the wizard's
    // fetch flow. An export-pending resume (a server installed but no local config) is no
    // longer something the wizard finishes itself — it routes into the recovery fork so the
    // user can Continue / Start over from the Control Panel, never into the deleted
    // FetchingStep. Exporting an existing user's config is done from the Control Panel
    // (per-user QR/Link) or «У меня уже есть конфиг» on Connection.
    if (next === "fetching") {
      setRecoveryProbe(probe);
      setRecoveryCause("");
      setWizardStep("recovery");
    } else {
      setWizardStep(next as WizardStep);
    }
    return next;
  };

  // Resume secret read (Codex #10 + round-2 finding F; re-keyed per host in 06-19 /
  // D-15 / C-23): on (re)open, if the SSH secret is not already in session state,
  // read it from the host-keyed `load_ssh_credentials_for(host,port,user)` command
  // — the per-host store now EXISTS (06-19), so the wizard asks for the EXACT
  // target's bundle instead of the last-saved-anything bundle the old no-arg
  // `load_ssh_credentials` returned (the coarse-load-then-validate workaround is
  // gone). We KEEP the subsequent credentialsMatchTarget gate as defence-in-depth:
  // a host-keyed read should already match by construction, but a corrupted/legacy
  // store must never let a non-matching secret slip through. On a MATCH we
  // repopulate the in-session secret; on a MISMATCH / absent / empty bundle we
  // route to the re-enter affordance (D-08) instead of silently using the wrong
  // server's secret. Returns true when a usable secret is now in session, false when
  // the caller should route to re-enter. Key-mode resume is not gated here (the key
  // path/data is non-secret-at-rest and rides through buildAuthArgs).
  // Returns:
  //   { ok: true,  password }            — a usable secret is available for the probe
  //   { ok: false }                      — route to re-enter (D-08)
  // For key auth `password` is undefined (buildAuthArgs ignores it in key mode).
  const ensureResumeSecret = async (): Promise<{ ok: boolean; password?: string }> => {
    // Key auth carries its own (non-password) material; nothing to load.
    if (authMode === "key") {
      return { ok: sshKeyPath.length > 0 || sshKeyData.length > 0 };
    }
    // Password already in session (the user just typed it) — nothing to load.
    if (sshPassword.length > 0) return { ok: true, password: sshPassword };
    let bundle: SshCredBundle | null;
    try {
      // 06-19 / D-15: host-keyed read for the EXACT target (host:port:sshUser),
      // not the coarse last-saved bundle.
      bundle = await invoke<SshCredBundle | null>("load_ssh_credentials_for", {
        host,
        port,
        user: sshUser,
      });
    } catch {
      return { ok: false }; // load failed → ask the user (D-08)
    }
    // finding F (defence-in-depth): even with a host-keyed read, only trust the
    // bundle when it matches the current resume target — a corrupted/legacy store
    // must never let a non-matching secret through.
    if (!credentialsMatchTarget(bundle, { host, port, user: sshUser })) return { ok: false };
    const pw = bundle?.password ?? "";
    if (!pw) return { ok: false }; // matched target but no password (e.g. a pasted-key bundle)
    // Commit to session state for subsequent operations AND return it so the probe
    // in this same tick uses it past the async-setState window.
    setSshPassword(pw);
    return { ok: true, password: pw };
  };

  const resolveResumeOnOpen = async () => {
    setSecretMissing(false);
    // finding F: read + validate the resume secret BEFORE probing. On a mismatch /
    // absent / empty secret, route to the recovery fork (06-uat) — the in-wizard SSH
    // re-enter screen was removed, so a resume that cannot authenticate hands the user
    // the Continue / Start-over choice instead of a deleted ServerStep. SSH auth lives
    // only in the Control Panel; the secret is re-entered there.
    const secret = await ensureResumeSecret();
    if (!secret.ok) {
      setSecretMissing(true);
      setRecoveryProbe(null);
      setRecoveryCause("");
      setWizardStep("recovery");
      return;
    }
    try {
      await runResumeProbe(secret.password);
    } catch (e) {
      const errStr = formatError(e);
      // D-08 minimal affordance: a missing/unavailable secret routes to the recovery fork
      // (06-uat — the in-wizard re-enter screen was removed); the user re-authenticates
      // from the Control Panel.
      if (isMissingSecretError(errStr)) {
        setSecretMissing(true);
        setRecoveryProbe(null);
        setRecoveryCause("");
        setWizardStep("recovery");
      } else if (errStr.includes("SSH_HOST_KEY_CHANGED")) {
        // D-09 + round-2 finding B: a changed host key (reinstalled server, or a
        // possible MITM) routes into the recovery fork's explicit "trust the new
        // key" path. We do NOT auto-forget here — trust is explicit-only via
        // handleTrustNewKey (the silent auto-forget is removed, Task 3).
        setRecoveryCause("SSH_HOST_KEY_CHANGED");
        setRecoveryProbe(null);
        setWizardStep("recovery");
      } else {
        setCheckError(errStr);
      }
    }
  };

  // ── Server-verified resume on mount (CR-01: WIZARD-02 was dead at runtime) ──
  // The phase's headline feature — verify-don't-remember — only ran in tests until
  // now: nothing in the mounted tree ever called resolveResumeOnOpen, so the
  // persisted-step seed (the remembered counter WIZARD-02 set out to replace) was the
  // sole runtime driver. Fire the server-verified probe ONCE on mount when there is a
  // saved server target to probe (host truthy). The probe DECIDES the destination via
  // resolveResume — partial → recovery fork (D-01 no silent auto-resume), export-pending
  // → auto-start fetch (finding D), done → done — it never silently auto-completes a
  // partial server. StrictMode-guarded exactly like migrationFiredRef above; the latest
  // host/secret are read through the live closure inside the fired call, so the empty
  // dep array fires once on the INITIAL mount (a reopen with a persisted host) without
  // re-probing on every keystroke as the user types a fresh host. resolveResumeOnOpen is
  // already terminal-safe (resolves on every branch); the .catch is belt-and-suspenders
  // for an app-close-mid-IPC rejection and MUST NOT log any secret (D-29).
  // Install-from-Control-Panel mount path (installEntry). The server was already
  // connected + verified in the Control Panel, so we do NOT re-probe (no «проверка»
  // screen, no server-step). We only LOAD the SSH secret into session (from Credential
  // Manager via ensureResumeSecret) so the deploy can authenticate, then STAY on the
  // seeded Settings (endpoint) screen. A keyring miss / different-server bundle falls
  // back to the re-enter affordance (D-08) exactly like the resume path.
  const prepareInstallEntry = async () => {
    const secret = await ensureResumeSecret();
    if (!secret.ok) {
      // 06-uat: a keyring miss / different-server bundle used to fall back to the in-wizard
      // ServerStep re-enter screen, which no longer exists. SSH auth lives only in the
      // Control Panel, so route to the recovery fork (Continue / Start over) — the user
      // re-authenticates from the Control Panel and reopens «Установить».
      setSecretMissing(true);
      setRecoveryProbe(null);
      setRecoveryCause("");
      setWizardStep("recovery");
    }
    // else: ensureResumeSecret committed the password to session; stay on endpoint.
  };

  const resumeFiredRef = useRef(false);
  useEffect(() => {
    if (resumeFiredRef.current) return;
    if (!host) return; // nothing to resume to — keep the seeded step
    resumeFiredRef.current = true;
    // installEntry → load secret only, no probe (stay on Settings). Otherwise the
    // server-verified resume probe re-derives the step from server reality.
    const run = installEntry ? prepareInstallEntry : resolveResumeOnOpen;
    run().catch(() => {
      // Non-secret: both paths already route every failure to a safe screen;
      // nothing to log here (D-29 — never log a secret).
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Recovery fork handlers (WIZARD-03, D-01/D-04/D-09; findings C, E) ──

  // Continue (safe default): re-run the probe + resolveResume (single source of
  // truth — finding E). The destination is whatever the server reality resolves to
  // (endpoint / fetching / done / recovery), NOT a hard-coded step.
  const handleContinue = async () => {
    setRecoveryBusy(true);
    setErrorMessage("");
    try {
      await runResumeProbe();
    } catch (e) {
      setErrorMessage(formatError(e));
    } finally {
      setRecoveryBusy(false);
    }
  };

  // Start over (destructive): run the EXTENDED full-clean uninstall (D-04 —
  // Let's Encrypt state + ownership-scoped ufw + ownership-scoped iptables removal,
  // round-3 HIGH A) and on success CLOSE the wizard back to the Control Panel (06-uat:
  // the in-wizard `server` clean-slate screen was removed; the Control Panel is the single
  // SSH entry point, so a clean slate means clearing the snapshot + re-entering from there).
  // On failure surface the error without stranding the user on the fork.
  const handleStartOver = async () => {
    setRecoveryBusy(true);
    setErrorMessage("");
    operationRef.current = "uninstall";
    try {
      try { await invoke("vpn_disconnect"); } catch { /* already disconnected */ }
      // CR-02/D-06: the DESTRUCTIVE full-clean uninstall must send only the chosen
      // method. A hand-rolled empty password in key mode (where setAuthMode("key")
      // cleared sshPassword) could trip a spurious auth failure that strands the user
      // on the recovery fork, or worse authenticate via a blank-password path they
      // never consented to. buildAuthArgs() sends authMethod + exactly one credential.
      await invoke("uninstall_server", {
        host,
        port: parseInt(port),
        user: sshUser,
        ...buildAuthArgs(),
      });
      operationRef.current = null;
      // Clear the persisted wizard snapshot so the fresh start is a true clean slate.
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      localStorage.removeItem("tt_config_path");
      setServerInfo(null);
      setRecoveryProbe(null);
      setRecoveryCause("");
      // 06-uat: close the overlay back to the Control Panel instead of resetting to the
      // deleted `server` screen. The cleared snapshot above guarantees a clean re-entry.
      onClose?.();
    } catch (e) {
      operationRef.current = null;
      setErrorMessage(formatError(e));
    } finally {
      setRecoveryBusy(false);
    }
  };

  // Apply my settings (shown only when configDiverges): re-configure via the REAL
  // deploy_server command with overwrite_config=true (round-3 LOW C — there is NO
  // deploy_configure IPC). 05-02 made overwrite_config rewrite vpn.toml/hosts.toml
  // ONLY — credentials.toml is always preserved (D-02, finding C). handleDeploy
  // drives the deploy screen; APPLY_CONFIG → deploying transitions the machine. The
  // resume after the deploy goes back through resolveResume on the next (re)open.
  const handleApplyConfig = async () => {
    // WR-04: do NOT hold recoveryBusy across the full handleDeploy await. handleDeploy
    // owns its own screen (it dispatches "deploying" immediately) and its own operation
    // generation, so the busy flag spanned the entire multi-minute deploy on a screen
    // that no longer reads it — and on an error-screen landing the finally would clear
    // it against a screen transition it was never designed for. There is no synchronous
    // pre-deploy work here, so we simply hand off to handleDeploy, which transitions the
    // machine and surfaces all progress/error state itself.
    await handleDeploy({ overwriteConfig: true });
  };

  // Trust the new key (D-09 explicit-trust, Gemini #11 + finding B): forget the old
  // host key (re-arming TOFU) then re-run the probe so the new key is accepted on
  // the next connect. This is the ONLY place a changed key is forgotten — never
  // automatically from handleCheckServer (the silent auto-forget is removed).
  const handleTrustNewKey = async () => {
    setRecoveryBusy(true);
    setErrorMessage("");
    try {
      await invoke("forget_ssh_host_key", { host, port: parseInt(port) || 22 });
      setRecoveryCause("");
      await runResumeProbe();
    } catch (e) {
      setErrorMessage(formatError(e));
    } finally {
      setRecoveryBusy(false);
    }
  };

  const handleAddUser = async () => {
    if (!newUsername.trim() || !newPassword.trim()) return;
    setAddingUser(true);
    setErrorMessage("");

    try {
      // CR-02/D-06: single chosen method via buildAuthArgs (see handleUninstall).
      await invoke<string>("add_server_user", {
        host,
        port: parseInt(port),
        user: sshUser,
        ...buildAuthArgs(),
        vpnUsername: newUsername.trim(),
        vpnPassword: newPassword.trim(),
      });
      try {
        const result = await invoke<ServerInfo>("check_server_installation", {
          host,
          port: parseInt(port),
          user: sshUser,
          ...buildAuthArgs(),
        });
        setServerInfo(result);
      } catch { /* keep current serverInfo */ }
      setNewUsername("");
      setNewPassword("");
    } catch (e) {
      setErrorMessage(formatError(e));
    } finally {
      setAddingUser(false);
    }
  };

  const handleDeleteUser = async (username: string) => {
    setDeletingUser(username);
    try {
      // CR-02/D-06: single chosen method via buildAuthArgs (see handleUninstall).
      await invoke("server_remove_user", {
        host,
        port: parseInt(port),
        user: sshUser,
        ...buildAuthArgs(),
        vpnUsername: username,
      });
      try {
        const result = await invoke<ServerInfo>("check_server_installation", {
          host,
          port: parseInt(port),
          user: sshUser,
          ...buildAuthArgs(),
        });
        setServerInfo(result);
      } catch { /* keep current */ }
    } catch (e) {
      setErrorMessage(formatError(e));
    } finally {
      setDeletingUser(null);
    }
  };

  const handleSaveAs = async () => {
    // UAT (06-uat fix 14): default to the branded, consistent save name
    // `[COUNTRY_]TrustTunnel_<username>.toml` (matching the Users-tab save), NOT the
    // raw AppData `<username>.toml` basename. The country prefix is BEST-EFFORT: read
    // synchronously from the already-cached GeoIP for this host (no fetch, never blocks
    // the save) — when it isn't readily available the prefix is omitted gracefully.
    // The internal AppData file (configPath) is unchanged — this is the dialog default
    // name only.
    const country = readCachedCountryCode(host);
    const fileName = buildConfigFileName(vpnUsername.trim(), country);
    const dest = await save({
      defaultPath: fileName,
      filters: [{ name: "TOML Config", extensions: ["toml"] }],
    });
    if (dest) {
      try {
        await invoke("copy_file", { source: configPath, destination: dest });
      } catch (e) {
        // WR-04: was a console-only swallow (invisible to the user). Capture the
        // error into errorMessage state — consistent with every other catch in this
        // hook — so it is no longer silently lost. (A dedicated save-as snackbar on
        // the Done screen is a separate UX enhancement, tracked for follow-up.)
        setErrorMessage(formatError(e));
      }
    }
  };

  // ── Derived state ──
  // C-10 (06-15): the resolved endpoint address + self-signed-no-domain flag, surfaced
  // on Done so a self-signed-no-domain user can verify exactly which address was baked
  // into their client config (the self-signed cert CN is trusttunnel.local).
  const resolvedEndpointAddress = deriveResolvedEndpointAddress({ domain, host, listenAddress });
  const selfSignedNoDomain = deriveSelfSignedNoDomain({ certType, domain });
  // WR-03: the SSH port is free-text. An empty / non-numeric / out-of-range value
  // makes parseInt(port) → NaN, which serialises to null over IPC and the Rust
  // `port: u16` command rejects it with an opaque deserialization error. Require a
  // valid 1..=65535 integer in the form gates so the install is blocked HERE with
  // the disabled CTA, never falling through to a mid-flight opaque failure.
  const isValidPort = Number.isInteger(+port) && +port >= 1 && +port <= 65535;
  const canGoToEndpoint = host.trim().length > 0 && isValidPort && (sshPassword.length > 0 || sshKeyPath.length > 0 || sshKeyData.length > 0);
  const isValidEmail = (e: string) => !e.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

  // C-08 (06-09): hoist the backend's pure Let's-Encrypt-domain validity check
  // (deploy.rs:716-721) to the form so an invalid LE target is rejected here, not
  // minutes into the install. Mirror it exactly: reject reserved/non-routable TLDs and
  // a no-dot value. The backend re-checks regardless (this is a UX guard, not the gate).
  const isInvalidLeDomain = (d: string) => {
    const t = d.trim().toLowerCase();
    if (!t) return false; // empty handled separately (canDeploy already needs non-empty)
    return (
      t.endsWith(".local") ||
      t.endsWith(".localhost") ||
      t.endsWith(".test") ||
      t.endsWith(".example") ||
      t.endsWith(".invalid") ||
      !t.includes(".")
    );
  };
  // Inline error surfaced under the LE domain Input (only when a domain is typed).
  const leDomainError = certType === "letsencrypt" && domain.trim().length > 0 && isInvalidLeDomain(domain);

  // C-02 (06-13, D-11): on the reinstall-from-Found path serverInfo.users is populated,
  // so a first-user name that collides with an existing user would be rejected late by
  // the backend (server_install.rs:452-456). Surface it at the form: inline error on the
  // username field + block the install button. On a CLEAN install (serverInfo null / no
  // users) this is a no-op — the typed name is always unique to a fresh server.
  const isDuplicateVpnUsername = !!serverInfo?.users?.includes(vpnUsername.trim());

  const canDeploy =
    vpnUsername.trim().length > 0 &&
    vpnPassword.length > 0 &&
    // WR-03: a valid numeric SSH port is required before install — a NaN port would
    // serialise to null over IPC and the backend would reject it opaquely.
    isValidPort &&
    // C-02: a reinstall-path duplicate first-user name blocks install (no-op on a
    // clean install where serverInfo.users is empty/absent).
    !isDuplicateVpnUsername &&
    (certType === "selfsigned" ||
     // UAT (06-uat fix 1): a non-empty email is now REQUIRED for Let's Encrypt as a
     // deliberate UX gate. isValidEmail("") returns true (empty is "valid"), so without
     // the explicit non-empty check the LE install proceeded with no email; the backend
     // tolerates this (--register-unsafely-without-email) but the UX requires one.
     (certType === "letsencrypt" && domain.trim().length > 0 && email.trim().length > 0 && isValidEmail(email) && !isInvalidLeDomain(domain)) ||
     (certType === "provided" && certChainPath.trim().length > 0 && certKeyPath.trim().length > 0));

  return {
    // Current step. Exposed as WizardStep for the consumer (SetupWizard switch +
    // the step components' StepBar prop). The machine Step union is a superset
    // (it adds `recovery`), but `recovery` is unreachable in this slice — its UI
    // wiring lands in 05-03, which will widen this surface deliberately. Casting
    // here keeps the public API byte-identical so no child component changes
    // (SAFETY-03, no visible behavior change).
    step: step as WizardStep,
    setWizardStep,

    // SSH
    host, setHost,
    port, setPort,
    sshUser, setSshUser,
    sshPassword, setSshPassword,
    sshKeyPath, setSshKeyPath,
    sshKeyData, setSshKeyData,
    showSshPassword, setShowSshPassword,
    // Explicit single auth choice (D-06).
    authMode, setAuthMode,
    // D-06: exposed so out-of-hook IPC callers (FoundStep's QR/deeplink export)
    // build SSH creds the SAME way every internal handler does — sending authMethod
    // + exactly one credential. Without this, FoundStep hand-rolled an sshParams
    // object that omitted authMethod and leaked both password AND keyPath, dropping
    // the export call into the backend's legacy both-then-prefer-key heuristic.
    buildAuthArgs,

    // Endpoint settings
    listenAddress, setListenAddress,
    vpnUsername, setVpnUsername,
    vpnPassword, setVpnPassword,
    showVpnPassword, setShowVpnPassword,
    // D-11 (06-13) first-user advanced posture (session-only)
    firstUserAdvanced, setFirstUserAdvanced, updateFirstUserAdvanced,
    // C-09 / C-10 (06-15) post-install reachability + resolved-address derivation
    // fix_18 (06-uat): dismissReachabilityWarning removed — the warning is now info-only.
    reachabilityWarning,
    resolvedEndpointAddress,
    selfSignedNoDomain,
    certType, setCertType,
    domain, setDomain,
    email, setEmail,
    certChainPath, setCertChainPath,
    certKeyPath, setCertKeyPath,
    showAdvanced, setShowAdvanced,
    // D-10 (06-09) advanced settings — 407/405 chooser. Metrics/SOCKS5/Allow-private
    // were removed from the wizard; ICMP/IPv6 toggles were hidden (safe ON defaults
    // hard-coded in deploy.rs), so none of those are exported anymore.
    authFailureStatusCode, setAuthFailureStatusCode,
    // WIZARD-06 / D-01: install-time firewall + fail2ban toggles (default ON),
    // consumed by EndpointStep's «Защита сервера» section.
    enableFirewall, setEnableFirewall,
    enableFail2ban, setEnableFail2ban,

    // Server check
    serverInfo,
    checkError,
    secretMissing, setSecretMissing,

    // Recovery fork (slice 3)
    recoveryProbe,
    recoveryCause,
    recoveryBusy,

    // Add user
    newUsername, setNewUsername,
    newPassword, setNewPassword,
    showNewPassword, setShowNewPassword,
    addingUser,
    deletingUser,
    selectedUser, setSelectedUser,
    cameFromFound, setCameFromFound,
    installEntry,

    // Deploy state
    deploySteps,
    deployLogs,
    // fix_16 (06-uat): true during the post-deploy re-export FINALIZE phase, so
    // DeployingStep can show ONE calm "Завершаем настройку…" line under the green rows.
    finalizing,
    showLogs, setShowLogs,
    errorMessage,
    configPath,
    copied,
    logsEndRef,

    // Derived
    canGoToEndpoint,
    isValidEmail,
    canDeploy,
    // C-02 (06-13) duplicate first-user name on the reinstall path
    isDuplicateVpnUsername,
    // D-10 / C-08 (06-09) inline form-gate errors
    leDomainError,

    // Actions
    resolveResumeOnOpen,
    handleContinue,
    handleStartOver,
    handleApplyConfig,
    handleTrustNewKey,
    handleUninstall,
    handleCancelDeploy,
    cancellingDeploy,
    // fix_B (06-uat): retry-to-endpoint with generation invalidation (ErrorStep deploy mode)
    handleRetryToEndpoint,
    handleDeploy,
    handleSkip,
    handleAddUser,
    handleDeleteUser,
    handleSaveAs,
    copyLogsToClipboard,
    saveField,
    onSetupComplete,
    // D-01: exposed so screens (ServerStep "Назад", Done/Found post-install nav)
    // can close the overlay instead of navigating to the deleted welcome menu.
    onClose,
  };
}

export type WizardState = ReturnType<typeof useWizardState>;
