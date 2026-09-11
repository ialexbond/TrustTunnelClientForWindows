// ═══════════════════════════════════════════════════════
// wizard/resolveResume.ts — server-verified resume (WIZARD-02, D-02)
// ═══════════════════════════════════════════════════════
//
// The wizard's resume position is a PURE FUNCTION of a server probe + a REAL
// local-export check — NOT a remembered counter (WIZARD-02 verify-don't-remember).
// This file owns the FINAL `ServerProbe` contract (replacing the 05-01 placeholder
// in machine.ts) and the `resolveResume` resolver.
//
// The `ServerProbe` keys mirror the `check_server_installation` payload EXACTLY
// (Codex #9 — one consistent contract; NO phantom `configValid`, round-3 LOW D),
// PLUS a frontend-supplied `localExportComplete` (proven by the wiring via a REAL
// read_client_config file check, round-3 MEDIUM B) and `configDiverges` (carried
// from the deploy-side detection so the 05-03 recovery fork can offer "apply my
// settings").

import type { Step } from "./machine";

// The finalized server probe contract. Keys match the Rust
// `check_server_installation` JSON payload (server_install.rs) one-for-one, plus
// the two frontend-computed fields (`localExportComplete`, `configDiverges`).
export interface ServerProbe {
  installed: boolean;
  binaryInstalled: boolean;
  credentialsExist: boolean;
  rulesExist: boolean;
  vpnConfigExists: boolean;
  hostsConfigExists: boolean;
  certPresent: boolean;
  // FINDING G: unitExists and unitEnabled are DISTINCT — a unit that exists but is
  // not enabled is NOT a complete install.
  unitExists: boolean;
  unitEnabled: boolean;
  serviceActive: boolean;
  // Derived server-side (derive_partial): binary present but the full chain is not.
  partial: boolean;
  // Carried from the deploy-side config_diverges detection (Codex #3, finding C);
  // consumed by the 05-03 recovery fork. Defaults false on a plain probe.
  configDiverges: boolean;
  // Frontend-computed via a REAL read_client_config file check (round-3 MEDIUM B):
  // the saved config file at tt_config_path actually EXISTS and is readable — NOT
  // the mere presence of the tt_config_path localStorage marker.
  localExportComplete: boolean;
}

// Resume position as a pure function of server reality + the local-export check.
//
// Codex #5 + finding G: "done" requires the FULL official chain — the unit must be
// present AND `enable`d AND active (the `systemctl enable --now trusttunnel`
// chain) AND the separate local client-export must exist on THIS machine. A
// present-but-not-enabled unit, an enabled-but-not-running unit, or a server
// without a real local export file is NOT done — it resumes via recovery / the
// export-pending fetch.
//
// round-3 MEDIUM B: `localExportComplete` is proven by the WIRING via a REAL
// read_client_config file check (it rejects when the file is gone), not by a
// localStorage marker — this resolver is a pure function of the boolean the wiring
// computed against disk.
export function resolveResume(p: ServerProbe): Step {
  // Nothing installed → start the configure flow.
  if (!p.installed) return "endpoint";

  // Half-installed (any artifact missing, unit-not-enabled, or not active per
  // derive_partial) → recovery fork (WIZARD-03, D-01).
  if (p.partial) return "recovery";

  // FINDING G — branch on the unit enable/active chain explicitly:
  // a present-but-not-enabled unit means `enable --now` is not done.
  if (p.unitExists && !p.unitEnabled) return "recovery";
  // enabled but not running → enabled but not started.
  if (p.unitEnabled && !p.serviceActive) return "recovery";

  // Server is installed + enabled + active. "done" requires real local-export
  // proof (Codex #5) — pure server truth never proves done.
  if (p.unitExists && p.unitEnabled && p.serviceActive) {
    if (p.localExportComplete) return "done";
    // FINDING D: export pending — return the "fetching" marker. The wiring turns
    // this into an ACTIONABLE handleFetchConfig() (starts the export), never a
    // passive FetchingStep that hangs.
    return "fetching";
  }

  // Fallback: installed but the unit chain is incomplete in some other shape →
  // recovery (defensive; derive_partial should have already caught these).
  return "recovery";
}
