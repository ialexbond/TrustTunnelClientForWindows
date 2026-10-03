// ═══════════════════════════════════════════════════════
// wizard.integration.test.ts — WIZARD-05 capstone (happy-path + interrupt-resume)
// ═══════════════════════════════════════════════════════
//
// This is the integration test that proves slices 05-01..05-04 work TOGETHER: the
// machine + persist + resolveResume + the deploy retry, exercised end-to-end against
// mocked invoke()/listen() (no real SSH server — the harness mocks
// @tauri-apps/api/core invoke + @tauri-apps/api/event listen per the existing
// useWizardState.test.ts:1-26 setup). It covers:
//
//   (1) HAPPY PATH — welcome→server→endpoint→deploying→done, consuming the real
//       `deploy-step` events in STEPS_ORDER, ending on `done` with a config path.
//   (2) INTERRUPT-THEN-RESUME (the WIZARD-05 hard case), two sub-scenarios:
//       (a) SSH drop mid-deploy → the WHOLE-deploy bounded retry (05-03 Task 2)
//           re-invokes up to the bound then lands on `recovery` (NOT an infinite
//           loop — the deploy_server call count is asserted bounded).
//       (b) App restart mid-install → a persisted `"deploying"` snapshot + a FRESH
//           mount + a PARTIAL-server probe resolves to `recovery` (via resolveResume),
//           NOT the persisted `"deploying"` step — server-VERIFIED resume, not
//           counter-based.
//
// END-OF-PHASE UAT (human_verify_mode: end-of-phase) — recorded here, NOT a blocking
// checkpoint. Against a reachable test VPS:
//   (1) run a full install to `done`;
//   (2) interrupt mid-install (drop SSH / kill the app) and reopen → the wizard
//       resumes from the SERVER-VERIFIED step, not a counter;
//   (3) on a half-installed server, choose Start over → the server is a clean slate
//       (no /opt/trusttunnel, no trusttunnel.service, no Let's Encrypt state, no
//       leftover trusttunnel-* ufw rules, and no leftover trusttunnel-managed-tagged
//       iptables ACCEPT rules on 80/443 — `iptables -S INPUT | grep -E 'dport (80|443)'`
//       shows nothing carrying the trusttunnel-managed comment);
//   (4) OWNERSHIP CHECK (round-3 HIGH A) — BEFORE installing, manually add a plain
//       admin rule `iptables -I INPUT -p tcp --dport 80 -j ACCEPT` (no comment) and a
//       `ufw allow 80/tcp` with no trusttunnel comment; install, then Start over →
//       the manually-added admin rule on 80 SURVIVES (Start over removed only the
//       TrustTunnel-tagged/commented rules, not the admin's).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useWizardState } from "./useWizardState";
import { STEPS_ORDER, type DeployStep } from "./types";

const STORAGE_KEY = "trusttunnel_wizard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockInvoke = invoke as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockListen = listen as any;

// Capture the listener callbacks the hook registers so the test can EMIT real
// deploy-step events through the same seam the production code consumes.
type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Listener[]>();

function emit(eventName: string, payload: unknown) {
  for (const cb of listeners.get(eventName) ?? []) {
    cb({ payload });
  }
}

function renderWizard(onClose?: () => void) {
  return renderHook(() => useWizardState({ onSetupComplete: vi.fn(), onClose }));
}

describe("wizard.integration — WIZARD-05 happy-path + interrupt-then-resume", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.useRealTimers();
    listeners.clear();
    mockInvoke.mockResolvedValue(null);
    // Capture callbacks by event name; return a no-op unlisten.
    mockListen.mockImplementation((name: string, cb: Listener) => {
      const arr = listeners.get(name) ?? [];
      arr.push(cb);
      listeners.set(name, arr);
      return Promise.resolve(() => {});
    });
  });

  // ─── (1) HAPPY PATH ───────────────────────────────────

  it("happy path: welcome→server→endpoint→deploying→done consuming the deploy-step events", async () => {
    vi.useFakeTimers();
    // The REAL backend streams the per-stage `deploy-step` events DURING the
    // deploy_server RPC (operationRef === "deploy" the whole time), then resolves with
    // the config path. Mirror that ordering: emit the events from inside the mocked
    // invoke BEFORE it resolves, so the listener's op==="deploy" guard sees them and
    // the terminal "done" event schedules the transition to the done screen.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "deploy_server") {
        for (const step of STEPS_ORDER) {
          emit("deploy-step", { step, status: "ok", message: `${step} ok` } satisfies DeployStep);
        }
        return "/app/config/trusttunnel_client.toml";
      }
      // Post-deploy advanced re-export overwrites the SAME per-login <login>.toml
      // and returns its path — that is what configPath ends up pointing at.
      if (cmd === "fetch_server_config") return "/app/config/user1.toml";
      return null;
    });

    const { result } = renderWizard();

    // welcome → server: fill the SSH connect form.
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });

    // endpoint → deploying: start the deploy (streams the events, resolves deploy_server).
    await act(async () => {
      await result.current.handleDeploy();
    });

    // The deploy succeeded → the advanced re-export sets the per-login config path.
    expect(result.current.configPath).toBe("/app/config/user1.toml");
    expect(mockInvoke).toHaveBeenCalledWith(
      "deploy_server",
      expect.objectContaining({ host: "10.0.0.1" }),
    );

    // Every emitted stage is recorded in the progress map.
    for (const step of STEPS_ORDER) {
      expect(result.current.deploySteps[step]).toBeDefined();
    }

    // UAT (06-uat fix 5): the streamed `done` event from deploy_server must NOT have
    // transitioned the screen yet — handleDeploy owns the transition AFTER the re-export
    // settles configPath. So at this point (handleDeploy resolved, but before advancing
    // the settle timer) the screen is still "deploying" while configPath is ALREADY the
    // final re-exported path — proving the Done screen will show the correct path on its
    // first paint (no flicker from the pre-re-export basic path).
    expect(result.current.step).toBe("deploying");
    expect(result.current.configPath).toBe("/app/config/user1.toml");

    // The handleDeploy-owned transition to the done screen fires after the 600ms settle.
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current.step).toBe("done");
    // configPath is still the final path on the Done screen (never reverted to `result`).
    expect(result.current.configPath).toBe("/app/config/user1.toml");
    vi.useRealTimers();
  });

  // ─── (1b) FETCH HAPPY PATH — REMOVED (06-uat) ─────────
  // The standalone fetch flow (handleFetchConfig / FetchingStep) was removed from the
  // install wizard. Exporting an existing user's config is now done from the Control Panel
  // (per-user QR/Link), so there is no in-wizard fetch happy-path to integration-test.

  // ─── (2a) INTERRUPT: SSH drop mid-deploy → bounded retry → recovery ──

  it("interrupt (SSH drop mid-deploy): the WHOLE-deploy bounded retry exhausts and lands on recovery, no loop", async () => {
    let deployCalls = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "deploy_server") {
        deployCalls += 1;
        // A transient SSH transport drop on EVERY attempt.
        throw new Error("SSH_TIMEOUT|10.0.0.1:22");
      }
      return null;
    });

    const { result } = renderWizard();
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });

    await act(async () => {
      await result.current.handleDeploy();
    });

    // MAX_DEPLOY_RETRIES (3) extra attempts after the first = 4 total invokes, then
    // STOP — the count is BOUNDED (no infinite loop).
    expect(deployCalls).toBe(4);
    // On exhaustion the wizard surfaces the recovery fork (Continue / Start over),
    // NOT the bare error screen and NOT a loop.
    expect(result.current.step).toBe("recovery");
  });

  // ─── (2b) INTERRUPT: app restart mid-install → server-verified resume ──

  it("interrupt (app restart mid-install): a persisted 'deploying' snapshot + a PARTIAL probe resolves to 'recovery', not the persisted step (server-verified, not counter)", async () => {
    // Simulate an app restart MID-INSTALL: a snapshot was persisted at "deploying"
    // with a config marker, so a naive counter-based restore would land on the deploy
    // screen. A FRESH mount must instead PROBE the server and resolve from reality.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ step: "deploying", host: "10.0.0.1" }),
    );
    localStorage.setItem("tt_config_path", "C:/cfg/trusttunnel_client.toml");

    // The server is only PARTIALLY installed (the install was interrupted).
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "check_server_installation") {
        return {
          installed: true,
          binaryInstalled: true,
          credentialsExist: true,
          rulesExist: false,
          vpnConfigExists: false,
          hostsConfigExists: false,
          certPresent: false,
          unitExists: false,
          unitEnabled: false,
          serviceActive: false,
          partial: true, // derive_partial: binary present, chain incomplete
          configDiverges: false,
          version: "1.5.0",
          users: [],
        };
      }
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      return null;
    });

    // Fresh renderHook = the app re-mounting after the interrupt.
    const { result } = renderWizard();
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
    });

    await act(async () => {
      await result.current.resolveResumeOnOpen();
    });

    // Server truth (partial) WINS over the persisted "deploying" counter — resume is
    // server-VERIFIED via resolveResume, not a remembered step (WIZARD-02 + WIZARD-05).
    expect(result.current.step).toBe("recovery");
    expect(result.current.step).not.toBe("deploying");
    // The probe actually ran (the resume consulted server reality).
    expect(mockInvoke).toHaveBeenCalledWith(
      "check_server_installation",
      expect.objectContaining({ host: "10.0.0.1" }),
    );
  });

  // ─── (3) UAT 06-uat fix 13: cancel returns to settings (not close) ─────
  //
  // Cancelling an in-flight install must NOT show the error screen and must return to
  // the Endpoint SETTINGS (data preserved) — NOT close the overlay (fix 13 supersedes
  // the earlier fix-4 close behavior) and NOT land on the in-wizard «server» step. The
  // activeOpIdRef bump still makes handleDeploy's catch-guard fire so the killed Err
  // returns early instead of falling through to setWizardStep("error"); uninstall_server
  // still runs to free 443 / remove the partial install.

  it("cancel mid-deploy: returns to endpoint settings, does NOT close, does NOT reach the error screen, and uninstall_server runs", async () => {
    const onClose = vi.fn();

    // deploy_server stays PENDING until we reject it AFTER the cancel. uninstall_server
    // (the cancel cleanup) resolves normally.
    let rejectDeploy: ((e: unknown) => void) | undefined;
    const deployPromise = new Promise<string>((_resolve, reject) => {
      rejectDeploy = reject;
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "deploy_server") return deployPromise;
      if (cmd === "uninstall_server") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    const { result } = renderWizard(onClose);
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });

    // Start the deploy WITHOUT awaiting (deploy_server is pending).
    let deployDone: Promise<void>;
    act(() => {
      deployDone = result.current.handleDeploy();
    });
    expect(result.current.step).toBe("deploying");

    // User cancels — this bumps activeOpIdRef + runs uninstall_server + closes.
    await act(async () => {
      await result.current.handleCancelDeploy();
    });

    // Now the killed deploy_server rejects (the backend tore down the install).
    await act(async () => {
      rejectDeploy?.(new Error("deploy aborted: code 35"));
      await deployDone;
    });

    // The cancelled install's error NEVER reached the error screen…
    expect(result.current.step).not.toBe("error");
    // …it returned to the Endpoint SETTINGS (data preserved), NOT the «server» step…
    expect(result.current.step).toBe("endpoint");
    expect(result.current.step).not.toBe("server");
    // …and the overlay was NOT closed (fix 13: cancel ≠ close; the × is the close).
    expect(onClose).not.toHaveBeenCalled();
    // The cancel cleanup ran (frees port 443 / removes the partial install).
    expect(mockInvoke).toHaveBeenCalledWith(
      "uninstall_server",
      expect.objectContaining({ host: "10.0.0.1" }),
    );
  });

  // ─── (4) UAT 06-uat fix 10: a failed install must NOT flip to a false «done» ──
  //
  // Root cause: the deploy-step listener's `done` and `error` branches were independent
  // ifs; a streamed `done` event delivered AFTER an `error` event still passed the gate
  // and scheduled setWizardStep("done"), painting a stale OLD config from localStorage.
  // The fix makes the error branch terminal (bumps the op generation + drops later
  // events) and early-returns the `done` branch when the step is already "error".

  it("a streamed `error` followed by a LATE `done` event keeps the step on 'error' (never flips to 'done')", async () => {
    vi.useFakeTimers();
    // deploy_server stays pending; we drive the listener directly via emitted events,
    // mirroring the backend streaming an error stage then a late done for an earlier one.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "deploy_server") return new Promise<string>(() => {}); // never settles
      return Promise.resolve(null);
    });

    const { result } = renderWizard(vi.fn());
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });

    // Start the deploy WITHOUT awaiting (deploy_server is pending). operationRef==="deploy",
    // activeOpIdRef === operationIdRef, so emitted deploy-step events are accepted.
    act(() => {
      void result.current.handleDeploy();
    });
    expect(result.current.step).toBe("deploying");

    // The backend streams a stage ERROR → the wizard lands on the terminal error screen.
    act(() => {
      emit("deploy-step", { step: "configure", status: "error", message: "configure failed" });
    });
    expect(result.current.step).toBe("error");
    expect(result.current.errorMessage).toBe("configure failed");

    // A LATE `done` event from the SAME failed attempt arrives afterwards. It must be
    // DROPPED — the error is terminal. (The gate now filters it via the bumped op id, and
    // the done-branch also early-returns on the error step.)
    act(() => {
      emit("deploy-step", { step: "done", status: "ok", message: "done ok" });
    });
    // Advance well past the 600ms settle the (suppressed) transition would have used.
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // The screen STAYS on the error screen — no false flip to «Всё готово».
    expect(result.current.step).toBe("error");
    expect(result.current.step).not.toBe("done");
    vi.useRealTimers();
  });

  it("genuine deploy failure (no cancel) STILL reaches the error screen (real-failure path not regressed)", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "deploy_server") {
        // A deterministic (non-transient) failure — must land on the error screen.
        return Promise.reject(new Error("deploy failed: missing dependency"));
      }
      return Promise.resolve(null);
    });

    const { result } = renderWizard(vi.fn());
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });

    await act(async () => {
      await result.current.handleDeploy();
    });

    // A genuine failure (no cancel bumped activeOpIdRef) reaches the error screen.
    expect(result.current.step).toBe("error");
  });

  // ─── fix_A (06-uat KEYSTONE): leaving "deploying" is terminal for ALL events ──
  //
  // Root cause: the deploy-step listener's ERROR branch had no step guard (only the DONE
  // branch did), so a late streamed `error` arriving AFTER the user left "deploying" via
  // cancel could repaint the error screen. fix_A adds a single top-of-listener guard
  // (`if (stepRef.current !== "deploying") return;`) that drops every deploy event once
  // the wizard has left "deploying".

  it("fix_A: a late streamed `error` AFTER cancel stays on endpoint (no error flash)", async () => {
    // deploy_server stays pending; uninstall (cancel cleanup) resolves.
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "deploy_server") return new Promise<string>(() => {}); // never settles
      if (cmd === "uninstall_server") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    const { result } = renderWizard(vi.fn());
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });

    act(() => {
      void result.current.handleDeploy();
    });
    expect(result.current.step).toBe("deploying");

    // User cancels → fix_C sets step="endpoint" synchronously, then runs uninstall.
    await act(async () => {
      await result.current.handleCancelDeploy();
    });
    expect(result.current.step).toBe("endpoint");

    // The dying backend streams a LATE stage error. fix_A's guard must drop it — the
    // wizard must NOT flash the red error screen.
    act(() => {
      emit("deploy-step", { step: "configure", status: "error", message: "configure failed" });
    });
    expect(result.current.step).toBe("endpoint");
    expect(result.current.step).not.toBe("error");
  });

  // ─── fix_B: retry-to-endpoint invalidates pending deploy events ───────────────
  //
  // ErrorStep «Попробовать снова» now calls handleRetryToEndpoint, which bumps the
  // operation generation + clears deploy state before navigating. A late streamed error
  // from the SAME failed attempt must NOT re-show the error screen.

  it("fix_B: a late streamed `error` AFTER handleRetryToEndpoint stays on endpoint", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "deploy_server") return new Promise<string>(() => {}); // never settles
      return Promise.resolve(null);
    });

    const { result } = renderWizard(vi.fn());
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });

    act(() => {
      void result.current.handleDeploy();
    });
    expect(result.current.step).toBe("deploying");

    // A stage error lands the wizard on the error screen.
    act(() => {
      emit("deploy-step", { step: "configure", status: "error", message: "configure failed" });
    });
    expect(result.current.step).toBe("error");

    // The user clicks «Попробовать снова» → handleRetryToEndpoint invalidates the
    // generation + clears state + navigates to endpoint.
    act(() => {
      result.current.handleRetryToEndpoint();
    });
    expect(result.current.step).toBe("endpoint");
    // The deploy state was cleared.
    expect(result.current.errorMessage).toBe("");
    expect(Object.keys(result.current.deploySteps)).toHaveLength(0);

    // A LATE error from the still-streaming superseded attempt must be dropped — the
    // wizard stays on endpoint, never re-shows the error.
    act(() => {
      emit("deploy-step", { step: "service", status: "error", message: "service failed" });
    });
    expect(result.current.step).toBe("endpoint");
    expect(result.current.step).not.toBe("error");
  });

  // ─── fix_A: a late `done` after leaving "deploying" does not flip to done ──────

  it("fix_A: a late streamed `done` AFTER cancel does not flip to done", async () => {
    vi.useFakeTimers();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "deploy_server") return new Promise<string>(() => {}); // never settles
      if (cmd === "uninstall_server") return Promise.resolve(null);
      return Promise.resolve(null);
    });

    const { result } = renderWizard(vi.fn());
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });

    act(() => {
      void result.current.handleDeploy();
    });
    expect(result.current.step).toBe("deploying");

    await act(async () => {
      await result.current.handleCancelDeploy();
    });
    expect(result.current.step).toBe("endpoint");

    // A late `done` from the cancelled attempt arrives — must be dropped, not scheduled.
    act(() => {
      emit("deploy-step", { step: "done", status: "ok", message: "done ok" });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.step).toBe("endpoint");
    expect(result.current.step).not.toBe("done");
    vi.useRealTimers();
  });

  // ─── fix_16: re-export step events don't re-cycle the green rows ──────────────
  //
  // After deploy_server resolves, handleDeploy persists the first user's advanced
  // settings + RE-EXPORTS via fetch_server_config, which re-emits its OWN deploy-step
  // cycle. finalizingRef must freeze the all-green rows so they don't drop back to
  // progress (the "second round").

  it("fix_16: the post-deploy re-export's re-emitted steps do NOT overwrite the green rows", async () => {
    vi.useFakeTimers();
    // deploy_server emits all stages green, then resolves. The re-export
    // (fetch_server_config) re-emits the SAME stage IDs as `progress` — those must be
    // ignored while finalizing so the rows stay green.
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "deploy_server") {
        for (const step of STEPS_ORDER) {
          emit("deploy-step", { step, status: "ok", message: `${step} ok` } satisfies DeployStep);
        }
        return "/app/config/trusttunnel_client.toml";
      }
      if (cmd === "fetch_server_config") {
        // The re-export re-emits an early stage as `progress` — the "second round".
        emit("deploy-step", { step: "connect", status: "progress", message: "connecting again" } satisfies DeployStep);
        return "/app/config/user1.toml";
      }
      return null;
    });

    const { result } = renderWizard();
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });

    await act(async () => {
      await result.current.handleDeploy();
    });

    // The re-export's `connect: progress` event must have been DROPPED — the connect row
    // stays "ok" (green), never reverted to "progress" (no second round).
    expect(result.current.deploySteps.connect?.status).toBe("ok");
    expect(result.current.configPath).toBe("/app/config/user1.toml");

    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current.step).toBe("done");
    vi.useRealTimers();
  });

  // ─── fix_CANCEL-BLOCKING (06-uat): cancel is a REAL, blocking kill+rollback ────────
  //
  // BUG (confirmed by user): the prior fix made cancel return to the Endpoint settings
  // SYNCHRONOUSLY (before awaiting uninstall_server) to dodge an error flash. That dropped
  // the user back on settings while the real kill+rollback was STILL running on the server,
  // so clicking «Установить» again OVERLAPPED the old run → red «Неизвестная ошибка» then a
  // FALSE «Всё готово». The fix keeps the wizard on the deploying screen showing the
  // "Отмена установки…" state and BLOCKS until uninstall_server resolves, THEN returns to
  // settings — so a second install can never overlap a running/cancelling one.

  it("cancel does NOT return to endpoint until uninstall_server resolves (blocking + cancelling state)", async () => {
    // deploy_server stays pending; uninstall_server stays PENDING until we resolve it, so we
    // can observe the wizard mid-cancel.
    let resolveUninstall: (() => void) | undefined;
    const uninstallPromise = new Promise<null>((resolve) => {
      resolveUninstall = () => resolve(null);
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "deploy_server") return new Promise<string>(() => {}); // never settles
      if (cmd === "uninstall_server") return uninstallPromise;
      return Promise.resolve(null);
    });

    const { result } = renderWizard();
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });

    act(() => {
      void result.current.handleDeploy();
    });
    expect(result.current.step).toBe("deploying");

    // Fire cancel WITHOUT awaiting — uninstall_server is still pending.
    let cancelDone: Promise<void>;
    act(() => {
      cancelDone = result.current.handleCancelDeploy();
    });

    // MID-CANCEL: the wizard is STILL on the deploying screen (NOT endpoint) and the
    // cancelling state is on — the user is blocked on the "Отмена установки…" screen.
    expect(result.current.step).toBe("deploying");
    expect(result.current.step).not.toBe("endpoint");
    expect(result.current.cancellingDeploy).toBe(true);

    // The rollback finally completes → only NOW return to endpoint, cancelling cleared.
    await act(async () => {
      resolveUninstall?.();
      await cancelDone;
    });
    expect(result.current.step).toBe("endpoint");
    expect(result.current.cancellingDeploy).toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith(
      "uninstall_server",
      expect.objectContaining({ host: "10.0.0.1" }),
    );
  });

  it("a late streamed `error` DURING cancel (uninstall still pending) is ignored — no error flash", async () => {
    let resolveUninstall: (() => void) | undefined;
    const uninstallPromise = new Promise<null>((resolve) => {
      resolveUninstall = () => resolve(null);
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "deploy_server") return new Promise<string>(() => {});
      if (cmd === "uninstall_server") return uninstallPromise;
      return Promise.resolve(null);
    });

    const { result } = renderWizard();
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });
    act(() => {
      void result.current.handleDeploy();
    });

    let cancelDone: Promise<void>;
    act(() => {
      cancelDone = result.current.handleCancelDeploy();
    });
    // Still "deploying" (cancelling screen) while uninstall is pending.
    expect(result.current.step).toBe("deploying");

    // The dying backend streams a LATE stage error WHILE the cancel kill is still running.
    // The cancellingRef gate must drop it — no flash to the red error screen.
    act(() => {
      emit("deploy-step", { step: "configure", status: "error", message: "configure failed" });
    });
    expect(result.current.step).not.toBe("error");
    expect(result.current.step).toBe("deploying");

    await act(async () => {
      resolveUninstall?.();
      await cancelDone;
    });
    expect(result.current.step).toBe("endpoint");
    expect(result.current.step).not.toBe("error");
  });

  it("a late streamed `done` DURING cancel (uninstall still pending) is ignored — no false «Всё готово»", async () => {
    vi.useFakeTimers();
    let resolveUninstall: (() => void) | undefined;
    const uninstallPromise = new Promise<null>((resolve) => {
      resolveUninstall = () => resolve(null);
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "deploy_server") return new Promise<string>(() => {});
      if (cmd === "uninstall_server") return uninstallPromise;
      return Promise.resolve(null);
    });

    const { result } = renderWizard();
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });
    act(() => {
      void result.current.handleDeploy();
    });

    let cancelDone: Promise<void>;
    act(() => {
      cancelDone = result.current.handleCancelDeploy();
    });
    expect(result.current.step).toBe("deploying");

    // A late `done` from the cancelled attempt arrives mid-cancel — must be dropped.
    act(() => {
      emit("deploy-step", { step: "done", status: "ok", message: "done ok" });
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.step).not.toBe("done");
    expect(result.current.step).toBe("deploying");

    await act(async () => {
      resolveUninstall?.();
      await cancelDone;
    });
    expect(result.current.step).toBe("endpoint");
    expect(result.current.step).not.toBe("done");
    vi.useRealTimers();
  });

  it("a second handleDeploy WHILE deploying is a no-op (no overlap)", async () => {
    let deployCalls = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "deploy_server") {
        deployCalls += 1;
        return new Promise<string>(() => {}); // first deploy stays in flight
      }
      return Promise.resolve(null);
    });

    const { result } = renderWizard();
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });

    act(() => {
      void result.current.handleDeploy();
    });
    expect(result.current.step).toBe("deploying");
    expect(deployCalls).toBe(1);

    // A second install attempt while the first is still in flight must be ignored.
    act(() => {
      void result.current.handleDeploy();
    });
    expect(deployCalls).toBe(1); // NOT 2 — no overlapping deploy_server invoke
  });

  // ─── #22 (06-uat): cross-run event isolation via the per-run opId stamp ──────────
  //
  // Repro: fill data → «Установить» → cancel mid-deploy → re-«Установить». The deploy
  // events carry NO run id of their own, so a late/buffered event from the CANCELLED run
  // used to pass every gate (activeOpIdRef === operationIdRef is true again the moment the
  // fresh run is on screen) and bleed into the NEW run's deploySteps map — producing the
  // impossible mixed state the user reported (two yellow steps at once, a stale green row).
  // The backend now STAMPS every event with the run's opId and handleDeploy passes its
  // myOpId as `opId` to deploy_server; the listener drops any event whose opId does not
  // match the run on screen. These tests prove: (a) the re-deploy starts from a fresh,
  // clean step map, and (b) a stale-opId event from the prior run is ignored.

  it("#22: after cancel→re-deploy the new run starts with a CLEAN step map (no leftover rows)", async () => {
    let resolveUninstall: (() => void) | undefined;
    const uninstallPromise = new Promise<null>((resolve) => {
      resolveUninstall = () => resolve(null);
    });
    // The FIRST deploy stays pending (we cancel it). The SECOND deploy resolves cleanly.
    let deployCalls = 0;
    mockInvoke.mockImplementation((cmd: string, args: { opId?: number }) => {
      if (cmd === "deploy_server") {
        deployCalls += 1;
        if (deployCalls === 1) return new Promise<string>(() => {}); // first: never settles
        // Second run: stream a SINGLE early stage as progress, stamped with THIS run's opId.
        emit("deploy-step", { step: "connect", status: "progress", message: "connecting", opId: args.opId });
        return new Promise<string>(() => {}); // keep it on the deploying screen for assertion
      }
      if (cmd === "uninstall_server") return uninstallPromise;
      return Promise.resolve(null);
    });

    const { result } = renderWizard();
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });

    // First install — emit a couple of stale stages so the OLD map has rows.
    act(() => { void result.current.handleDeploy(); });
    act(() => {
      emit("deploy-step", { step: "connect", status: "ok", message: "connected" });
      emit("deploy-step", { step: "update", status: "progress", message: "updating" });
    });
    expect(Object.keys(result.current.deploySteps).length).toBeGreaterThan(0);

    // Cancel (blocking) — clears the deploy state once uninstall resolves.
    let cancelDone: Promise<void>;
    act(() => { cancelDone = result.current.handleCancelDeploy(); });
    await act(async () => { resolveUninstall?.(); await cancelDone; });
    expect(result.current.step).toBe("endpoint");

    // Re-«Установить» — the new run resets the map then streams ONLY its own first stage.
    await act(async () => { void result.current.handleDeploy(); });
    expect(result.current.step).toBe("deploying");

    // The new run's map contains ONLY its own freshly-streamed stage — no leftover rows
    // from the cancelled run (no stale `update`, only the new `connect: progress`).
    expect(result.current.deploySteps.update).toBeUndefined();
    expect(result.current.deploySteps.connect?.status).toBe("progress");
    // Exactly one in-flight step (the sequential-progress invariant the user demanded).
    const inFlight = Object.values(result.current.deploySteps).filter((s) => s.status === "progress");
    expect(inFlight).toHaveLength(1);
  });

  it("#22: a STALE-opId event from a previous run is DROPPED in the new run (no bleed)", async () => {
    // The new run is on screen; a late event carrying the PREVIOUS run's opId arrives.
    // It must be ignored — only events stamped with the current run's opId are applied.
    let capturedOpId: number | undefined;
    mockInvoke.mockImplementation((cmd: string, args: { opId?: number }) => {
      if (cmd === "deploy_server") {
        capturedOpId = args.opId; // the current run's generation the backend would echo
        emit("deploy-step", { step: "connect", status: "progress", message: "connecting", opId: args.opId });
        return new Promise<string>(() => {}); // stay on the deploying screen
      }
      return Promise.resolve(null);
    });

    const { result } = renderWizard();
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });

    await act(async () => { void result.current.handleDeploy(); });
    expect(result.current.step).toBe("deploying");
    expect(result.current.deploySteps.connect?.status).toBe("progress");
    expect(typeof capturedOpId).toBe("number");

    // A stale event from a DIFFERENT run (a distinct, nonzero generation that is not the
    // current run's) tries to paint a second in-flight step + flip connect green. Both must
    // be DROPPED by the opId gate. We use current+100 so the value is unambiguously nonzero
    // and != current (a "previous run" opId of 0 would be the accept-all sentinel, so we
    // pick a clearly-different nonzero generation to model the cross-run event).
    const staleOpId = (capturedOpId as number) + 100;
    act(() => {
      emit("deploy-step", { step: "service", status: "progress", message: "stale service", opId: staleOpId });
      emit("deploy-step", { step: "connect", status: "ok", message: "stale connect ok", opId: staleOpId });
    });

    // The stale `service` row never appeared, and the stale `connect: ok` did NOT overwrite
    // the current run's `connect: progress` — no double-yellow, no stale green.
    expect(result.current.deploySteps.service).toBeUndefined();
    expect(result.current.deploySteps.connect?.status).toBe("progress");
    const inFlight = Object.values(result.current.deploySteps).filter((s) => s.status === "progress");
    expect(inFlight).toHaveLength(1);
  });

  it("#22: an UNSTAMPED event (opId 0/undefined) is still accepted (legacy/test compatibility)", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "deploy_server") return new Promise<string>(() => {}); // stay on deploying
      return Promise.resolve(null);
    });

    const { result } = renderWizard();
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });

    act(() => { void result.current.handleDeploy(); });
    expect(result.current.step).toBe("deploying");

    // An event with no opId (undefined → treated as 0 = "accept") is applied normally, so
    // existing emitters and the rest of this suite that omit opId keep working unchanged.
    act(() => {
      emit("deploy-step", { step: "connect", status: "progress", message: "connecting" });
    });
    expect(result.current.deploySteps.connect?.status).toBe("progress");
  });

  it("a second handleDeploy WHILE cancelling is a no-op (no overlap with the rollback)", async () => {
    let deployCalls = 0;
    let resolveUninstall: (() => void) | undefined;
    const uninstallPromise = new Promise<null>((resolve) => {
      resolveUninstall = () => resolve(null);
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "deploy_server") {
        deployCalls += 1;
        return new Promise<string>(() => {});
      }
      if (cmd === "uninstall_server") return uninstallPromise;
      return Promise.resolve(null);
    });

    const { result } = renderWizard();
    act(() => {
      result.current.setHost("10.0.0.1");
      result.current.setSshPassword("pass");
      result.current.setVpnUsername("user1");
      result.current.setVpnPassword("vpnpass");
    });
    act(() => {
      void result.current.handleDeploy();
    });
    expect(deployCalls).toBe(1);

    // Begin cancel (uninstall pending → still cancelling).
    let cancelDone: Promise<void>;
    act(() => {
      cancelDone = result.current.handleCancelDeploy();
    });
    expect(result.current.cancellingDeploy).toBe(true);

    // Try to start a new install WHILE the rollback is in flight — must be blocked.
    act(() => {
      void result.current.handleDeploy();
    });
    expect(deployCalls).toBe(1); // still 1 — the cancellingRef guard blocked the overlap

    await act(async () => {
      resolveUninstall?.();
      await cancelDone;
    });
    expect(result.current.step).toBe("endpoint");
  });
});
