import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ─── Frozen contract types (Plan 18-05 backend → Plan 18-06 frontend) ────
export type UpdateUiStep = "download" | "backup" | "apply" | "verify";

/**
 * 4 UI step keys — UI-SPEC D-DECISION-UI-4.2 frozen contract.
 * Linear progress bar shows current step label + percent;
 * step transitions driven by BACKEND_TO_UI_STEP mapping below.
 */
export const UI_STEPS: readonly UpdateUiStep[] = [
  "download",
  "backup",
  "apply",
  "verify",
] as const;

export const UI_STEP_INDEX: Record<UpdateUiStep, number> = {
  download: 0,
  backup: 1,
  apply: 2,
  verify: 3,
};

/**
 * 7 backend step keys (Plan 18-05 server_update.rs frozen contract) →
 * 4 UI step keys (UI-SPEC). `_finalizer` для backend `complete` — terminal
 * step без UI representation (отдельно переключаем phase: success | error).
 *
 * Phase 17.1 Option B pattern mirror — adding a step requires updating
 * BOTH backend и frontend.
 */
export const BACKEND_TO_UI_STEP: Record<string, UpdateUiStep | "_finalizer"> = {
  download_tarball: "download",
  extract: "download",
  backup: "backup",
  swap: "apply",
  restart: "apply",
  verify: "verify",
  complete: "_finalizer",
};

export interface SshParams {
  host: string;
  port: number;
  user: string;
  password: string;
  keyPath?: string;
  keyData?: string;
}

interface UpdateStepPayload {
  step: string;
  status: string;
  percent: number;
  message: string;
}

export interface UpdateProgressState {
  phase: "idle" | "active" | "success" | "error";
  currentStep: number; // UI step index 0..3
  percent: number; // 0..100 — backend-emitted overall percent
  errorMessage: string | null;
  errorCode: string | null;
  cancelling: boolean; // local UX flag (set on cancel button click)
}

const INITIAL_STATE: UpdateProgressState = {
  phase: "idle",
  currentStep: 0,
  percent: 0,
  errorMessage: null,
  errorCode: null,
  cancelling: false,
};

// WR-02 (10.1 review): max gap between progress events before an active update is
// treated as wedged and flipped to a closeable error. Generous (2 min) so a slow
// but still-progressing update never false-times-out.
const WATCHDOG_MS = 120_000;

export interface UseUpdateProgressResult {
  state: UpdateProgressState;
  startUpdate: (sshParams: SshParams, targetVersion: string) => Promise<void>;
  cancelUpdate: () => Promise<void>;
  reset: () => void;
}

/**
 * Phase 18 Plan 06 — state machine + Tauri event listener для update flow.
 *
 * Phase transitions:
 *   idle    → active   (on startUpdate())
 *   active  → success  (on backend complete event status=completed)
 *   active  → error    (on backend complete event status=failed либо invoke reject)
 *   error   → idle     (on reset())
 *   success → idle     (on reset())
 *
 * D-29 invariant: messages from backend могут содержать i18n keys либо metadata.
 * Backend per Plan 18-05 static-grep test never logs paths/secrets, frontend
 * treats `message` strings as opaque (без parsing, без leaking в logs).
 *
 * Cancel infrastructure (cancelUpdate / cancelling flag) exists для future use —
 * backend Plan 18-05 ships `cancel_update_sidecar` Tauri command. UI consumer
 * (UpdateProgressModal) **does NOT expose cancel button** per UI-SPEC
 * D-DECISION-UI-4.1 (operation ≤30s, cancel adds complexity без real benefit).
 * Hook surface preserves the capability so it can be wired в Phase 19 polish
 * либо downstream consumer без backend changes.
 */
export function useUpdateProgress(): UseUpdateProgressResult {
  const [state, setState] = useState<UpdateProgressState>(INITIAL_STATE);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const isMountedRef = useRef(true);

  // Track mount status — guard setState после unmount, чтобы не leak React warning.
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // ── WR-02 (10.1 review): no-progress watchdog ──────────────────────────────
  // The active update blocks EVERY close path (no X / backdrop / Esc per
  // UI-SPEC), and `invoke('update_sidecar')` can hang silently if the SSH
  // channel wedges (backend neither progresses nor fails). Without a client-side
  // timeout the user is trapped and must kill the app. If NO progress event
  // arrives for WATCHDOG_MS we flip to a closeable `error` (UPDATE_TIMEOUT). The
  // watchdog is re-armed on every real progress event and cleared the moment we
  // leave `active`, so it only fires on a genuine stall — never on a slow but
  // progressing update.
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current !== null) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  const armWatchdog = useCallback(() => {
    clearWatchdog();
    watchdogRef.current = setTimeout(() => {
      if (!isMountedRef.current) return;
      setState((prev) =>
        prev.phase === "active"
          ? {
              ...prev,
              phase: "error",
              errorCode: "UPDATE_TIMEOUT",
              errorMessage: "UPDATE_TIMEOUT",
              cancelling: false,
            }
          : prev
      );
    }, WATCHDOG_MS);
  }, [clearWatchdog]);

  // Keep a stable ref to the latest armWatchdog so the mount-time (deps: []) event
  // listener can re-arm on each progress event without re-subscribing.
  const armWatchdogRef = useRef(armWatchdog);
  useEffect(() => {
    armWatchdogRef.current = armWatchdog;
  }, [armWatchdog]);

  // Arm the watchdog while `active`; clear it on every non-active phase (success /
  // error / idle) and on unmount. Arming HERE (not in startUpdate) avoids a race:
  // the idle→active phase change runs this effect's cleanup (clearWatchdog) right
  // after a startUpdate-side arm would set it, cancelling it. Progress events re-arm
  // via the listener (phase stays active, so this effect does not re-run).
  useEffect(() => {
    if (state.phase === "active") armWatchdog();
    else clearWatchdog();
    return clearWatchdog;
  }, [state.phase, armWatchdog, clearWatchdog]);

  // Subscribe to backend event on mount; cleanup unlisten on unmount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const unlisten = await listen<UpdateStepPayload>(
          "update-protocol-step",
          (event) => {
            if (cancelled || !isMountedRef.current) return;
            const payload = event.payload;
            const uiStep = BACKEND_TO_UI_STEP[payload.step];

            // WR-02: a real step event means the backend is alive — re-arm the
            // no-progress watchdog. Finalizer events (success/failed) leave `active`,
            // so the phase-effect clears the watchdog for them instead.
            if (uiStep !== undefined && uiStep !== "_finalizer") {
              armWatchdogRef.current();
            }

            setState((prev) => {
              // Finalizer (backend `complete`) — переключаем phase.
              if (uiStep === "_finalizer") {
                if (payload.status === "completed") {
                  return {
                    ...prev,
                    phase: "success",
                    percent: 100,
                    cancelling: false,
                  };
                }
                if (payload.status === "failed") {
                  // WR-01 (10.1 review): set errorCode on the EVENT-driven failure too —
                  // previously only the invoke-reject path set it, so a backend-emitted
                  // failure left errorCode null. That broke the modal's onError callback
                  // (never fired) and the cancelled-vs-error copy (couldn't distinguish).
                  // The step payload carries no separate code field, so the message doubles
                  // as the code (mirrors the invoke-reject path's String(err)); this also
                  // lets a backend-emitted «UPDATE_CANCELLED» be recognised as a cancel.
                  return {
                    ...prev,
                    phase: "error",
                    percent: 100,
                    errorMessage: payload.message || null,
                    errorCode: payload.message || prev.errorCode || "UPDATE_FAILED",
                    cancelling: false,
                  };
                }
                return prev;
              }

              // Unknown step key (shouldn't happen — Plan 18-05 contract frozen).
              if (uiStep === undefined) {
                return prev;
              }

              // Regular step — update UI position + percent.
              return {
                ...prev,
                currentStep: UI_STEP_INDEX[uiStep],
                percent: payload.percent,
              };
            });
          }
        );
        if (cancelled) {
          unlisten();
        } else {
          unlistenRef.current = unlisten;
        }
      } catch (e) {
        // listen() can reject in non-Tauri environments (Storybook без mock).
        // D-29: НЕ логируем sshParams — listen() never sees them.
        console.warn("[useUpdateProgress] listen failed:", e);
      }
    })();

    return () => {
      cancelled = true;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, []);

  const startUpdate = useCallback(
    async (sshParams: SshParams, targetVersion: string) => {
      setState({
        ...INITIAL_STATE,
        phase: "active",
      });
      // WR-02: the watchdog is armed by the phase-effect when phase becomes "active"
      // (arming here would be cancelled by that effect's idle→active cleanup).
      try {
        await invoke<void>("update_sidecar", {
          host: sshParams.host,
          port: sshParams.port,
          user: sshParams.user,
          password: sshParams.password,
          keyPath: sshParams.keyPath ?? null,
          keyData: sshParams.keyData ?? null,
          targetVersion,
        });
        // Success event обычно получен через listener выше; idempotent finalize.
        if (isMountedRef.current) {
          setState((prev) =>
            prev.phase === "active"
              ? { ...prev, phase: "success", percent: 100, cancelling: false }
              : prev
          );
        }
      } catch (err) {
        const errorCode = String(err);
        // D-29: НЕ логируем sshParams.password — только error code string.
        console.warn("[useUpdateProgress] update_sidecar rejected:", errorCode);
        if (isMountedRef.current) {
          setState((prev) => ({
            ...prev,
            phase: "error",
            errorCode,
            errorMessage: errorCode,
            cancelling: false,
          }));
        }
      }
    },
    []
  );

  const cancelUpdate = useCallback(async () => {
    setState((prev) =>
      prev.phase === "active" ? { ...prev, cancelling: true } : prev
    );
    try {
      await invoke<void>("cancel_update_sidecar");
    } catch (err) {
      // D-29: не логируем sensitive payload (cancel command has no args).
      console.warn("[useUpdateProgress] cancel failed:", err);
    }
  }, []);

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return { state, startUpdate, cancelUpdate, reset };
}
