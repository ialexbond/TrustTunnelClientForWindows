import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// ═══════════════════════════════════════════════════════
// UN-1 uninstall selection detection hook (Phase 18, plan 18-06 / 18-10).
//
// On open it probes the detection commands, computes which components the server
// ACTUALLY has (D-01), and seeds an all-checked «restore to exactly pre-install»
// selection (D-03).
//
// OWNERSHIP MODEL (which ROWS are offered — «наше vs чужое»):
// WR-8 (18-UAT owner principle — «всё, что не нами делалось, остаётся; удаляются только то,
// что мы создали»): a destructive row is offered ONLY when the component is DETECTED now AND
// carries OUR ownership MARKER. The pre-install snapshot is NO LONGER part of the ownership
// decision — first-touch absence does not prove the CURRENTLY-installed component is ours (an
// admin could have installed it after us). If a row were offered on snapshot-proof alone, the
// checkbox would silently do nothing (the backend folds nothing) and report a false success.
//   • MTProto — marker `/opt/trusttunnel/.tt-installed-mtproto` (`managedByUs`, 18-09). An
//     admin's own telemt carries no marker → never offered (D-05).
//   • BBR — marker `/opt/trusttunnel/.tt-bbr-prior` (`bbrPriorMarker`, 18-10, written by our
//     `enable_bbr`, content-validated backend-side per IN-3). An admin's own BBR → hidden (D-02b).
// ufw / fail2ban rows are always shown when detected; their PACKAGE purge is decided entirely in
// the backend (in-shell `$TT_INSTALLED_*` marker gate) — the UI surfaces no package-ownership
// caption (removed in 18-UAT), so the hook does not compute it.
//
// The `read_server_ownership_markers` probe (18-10) closes the LEGACY hole: a server installed
// before the snapshot feature whose MTProto/BBR WE installed/enabled is still removable via its
// marker. NOTE: pre-marker app-installed components have no marker until the next install/enable
// mints one — until then the app treats them as not-ours (safe: never over-deletes).
//
// The backend independently re-gates (never trusts this UI): build_uninstall_script folds each
// teardown only when `selection.<c> AND <c>_is_ours` (the marker).
// ═══════════════════════════════════════════════════════

export interface UninstallSshParams {
  host: string;
  port: number;
  user: string;
  password: string;
  keyPath?: string;
  [key: string]: unknown;
}

/**
 * Per-component selection payload. Tauri serde maps these camelCase keys to the Rust
 * `UninstallSelection { ufw, fail2ban, bbr, mtproto }`. NOTE: there is no `userConfigs` —
 * users are part of the protocol and are ALWAYS removed with it (18-UAT, owner decision).
 */
export interface UninstallSelection {
  ufw: boolean;
  fail2ban: boolean;
  bbr: boolean;
  mtproto: boolean;
}

/** Which component ROWS to render (D-01: detected only; bbr + mtproto are ownership-gated). */
export interface DetectedComponents {
  ufw: boolean;
  fail2ban: boolean;
  /** True ONLY when BBR is on AND ours — the .tt-bbr-prior marker is present (WR-8, D-02b). */
  bbr: boolean;
  /** True ONLY when telemt is detected AND ours — the .tt-installed-mtproto marker is present (WR-8, D-05). */
  mtproto: boolean;
}

// Detection-command result shapes (subset — we only read what we need).
interface SecurityStatusLite {
  firewall?: { installed?: boolean };
  fail2ban?: { installed?: boolean };
}
interface MtProtoStatusLite {
  installed?: boolean;
  /** 18-09: POSITIVE ownership marker (`/opt/trusttunnel/.tt-installed-mtproto`). Serde
   *  camelCase from Rust `MtProtoStatus.managed_by_us` (`#[serde(rename = "managedByUs")]`). */
  managedByUs?: boolean;
}
// 18-10: ownership markers (from read_server_ownership_markers). The UI reads only bbrPriorMarker
// (the sole BBR-row ownership proof after WR-8); the ufw/fail2ban install markers stay in the
// response shape but the package purge is decided backend-side, not surfaced here.
interface OwnershipMarkersLite {
  ufwInstalledMarker?: boolean;
  fail2banInstalledMarker?: boolean;
  bbrPriorMarker?: boolean;
}

const EMPTY_DETECTED: DetectedComponents = {
  ufw: false,
  fail2ban: false,
  bbr: false,
  mtproto: false,
};

// Restore-to-pre-install default: every detected component checked (users always go with
// the protocol, so there is no userConfigs field to seed — 18-UAT).
function seedSelection(detected: DetectedComponents): UninstallSelection {
  return {
    ufw: detected.ufw,
    fail2ban: detected.fail2ban,
    bbr: detected.bbr,
    mtproto: detected.mtproto,
  };
}

export function useUninstallSelection(sshParams: UninstallSshParams, open: boolean) {
  const [loading, setLoading] = useState(false);
  const [detected, setDetected] = useState<DetectedComponents>(EMPTY_DETECTED);
  const [selection, setSelection] = useState<UninstallSelection>(() => seedSelection(EMPTY_DETECTED));

  const { host, port, user, password, keyPath } = sshParams;

  const detect = useCallback(async () => {
    setLoading(true);
    const params = { host, port, user, password, keyPath };

    // Best-effort probes — a failed probe means "cannot confirm", which for a DESTRUCTIVE dialog
    // is treated conservatively as "not detected" (never offer a checkbox for something we could
    // not verify). WR-8: the snapshot is no longer probed here — ownership is marker-only, and a
    // failed marker probe → null → all markers false → the marker-gated rows stay closed.
    const [security, mtproto, bbrOn, markers] = await Promise.all([
      invoke<SecurityStatusLite>("security_get_status", params).catch(() => null),
      invoke<MtProtoStatusLite>("mtproto_get_status", params).catch(() => null),
      invoke<boolean>("detect_bbr_status", params).catch(() => false),
      invoke<OwnershipMarkersLite | null>("read_server_ownership_markers", params).catch(() => null),
    ]);

    const ufwDetected = security?.firewall?.installed === true;
    const fail2banDetected = security?.fail2ban?.installed === true;
    const mtprotoDetected = mtproto?.installed === true;
    const bbrDetected = bbrOn === true;

    // WR-8 (18-UAT owner principle): a destructive row is offered ONLY when OUR ownership MARKER
    // is present — matching the backend, which now folds telemt/BBR only on the marker (never on
    // snapshot-absence). Offering a row on snapshot-proof alone would make the checkbox a silent
    // no-op that reports false success. mtproto = managedByUs (.tt-installed-mtproto);
    // bbr = bbrPriorMarker (.tt-bbr-prior, content-validated backend-side per IN-3).
    const mtprotoIsOurs = mtprotoDetected && mtproto?.managedByUs === true;
    const bbrIsOurs = bbrDetected && markers?.bbrPriorMarker === true;

    const nextDetected: DetectedComponents = {
      ufw: ufwDetected,
      fail2ban: fail2banDetected,
      bbr: bbrIsOurs, // ownership-gated — D-02b
      mtproto: mtprotoIsOurs, // ownership-gated — D-05
    };

    setDetected(nextDetected);
    setSelection(seedSelection(nextDetected));
    setLoading(false);
  }, [host, port, user, password, keyPath]);

  // Probe when the dialog opens. Depends on `open` so a re-open re-detects fresh state.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot detection fetch when the dialog opens (mirrors useSecurityState/useBbrState load-on-mount); the initial setLoading(true) is the whole point, not a render loop
    if (open) void detect();
  }, [open, detect]);

  return { loading, detected, selection, setSelection };
}
