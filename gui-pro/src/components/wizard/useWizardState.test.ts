import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { useWizardState } from "./useWizardState";
import { useHostKeyVerification } from "../../shared/hooks/useHostKeyVerification";
import type { ServerInfo } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSave = save as any;

const STORAGE_KEY = "trusttunnel_wizard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockInvoke = invoke as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockListen = listen as any;

function renderWizard(overrides?: { onSetupComplete?: () => void; onClose?: () => void }) {
  const onSetupComplete = overrides?.onSetupComplete ?? vi.fn();
  const onClose = overrides?.onClose ?? vi.fn();
  return renderHook(() => useWizardState({ onSetupComplete, onClose }));
}

describe("useWizardState", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(null);
    mockListen.mockResolvedValue(() => {});
  });

  // ─── 1. Initialization ───────────────────────────────

  describe("initialization", () => {
    it('starts at step="endpoint" with all fields at defaults', () => {
      // 06-uat install-only wizard — the seed default is the install Settings screen
      // `endpoint`; the deleted welcome menu + SSH-login (`server`) screens are gone.
      const { result } = renderWizard();

      expect(result.current.step).toBe("endpoint");
      expect(result.current.host).toBe("");
      expect(result.current.port).toBe("22");
      expect(result.current.sshUser).toBe("root");
      expect(result.current.sshPassword).toBe("");
      expect(result.current.sshKeyPath).toBe("");
      expect(result.current.listenAddress).toBe("0.0.0.0:443");
      // D-11 (06-13, C-01): the first VPN user is seeded with a generated credential
      // pair on first mount (parity with every other add-user surface). After the
      // mount effect both fields are NON-EMPTY and charset-valid; the password stays
      // session-only (asserted separately in the secret-exclusion suite).
      expect(result.current.vpnUsername).toMatch(/^[a-zA-Z0-9._-]+$/);
      expect(result.current.vpnPassword.length).toBeGreaterThan(0);
      expect(result.current.certType).toBe("letsencrypt");
      expect(result.current.domain).toBe("");
      expect(result.current.email).toBe("");
      // WIZARD-06 / D-01: the two install-time server-protection toggles default ON —
      // a non-technical operator gets a secure baseline (firewall + fail2ban) without
      // having to opt in.
      expect(result.current.enableFirewall).toBe(true);
      expect(result.current.enableFail2ban).toBe(true);
      // 06-uat install-wizard slimming: icmpEnable / ipv6Available are no longer wizard
      // state (the toggles were hidden, the safe ON defaults moved into deploy.rs), so
      // the hook no longer exposes them. Their always-on behavior is covered by the
      // backend cargo tests (test_icmp_section_always_written / ipv6 constant true).
      expect(result.current.serverInfo).toBeNull();
      expect(result.current.errorMessage).toBe("");
      expect(result.current.configPath).toBe("");
    });
  });

  // ─── 1b. handleSaveAs default filename (06-uat fix 14) ───────────
  describe("handleSaveAs default filename (06-uat fix 14)", () => {
    it("defaults the save dialog to TrustTunnel_<username>.toml (no cached country)", async () => {
      mockSave.mockResolvedValueOnce(null); // user cancels — we only assert the default name
      const { result } = renderWizard();
      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setVpnUsername("keen-mole17");
      });
      await act(async () => {
        await result.current.handleSaveAs();
      });
      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({ defaultPath: "TrustTunnel_keen-mole17.toml" }),
      );
    });

    it("includes the country prefix when the host geoip is cached", async () => {
      localStorage.setItem(
        "tt_geoip_10.0.0.1",
        JSON.stringify({
          country: "Germany",
          country_code: "DE",
          flag_emoji: "🇩🇪",
          fetched_at: new Date().toISOString(),
        }),
      );
      mockSave.mockResolvedValueOnce(null);
      const { result } = renderWizard();
      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setVpnUsername("keen-mole17");
      });
      await act(async () => {
        await result.current.handleSaveAs();
      });
      expect(mockSave).toHaveBeenCalledWith(
        expect.objectContaining({ defaultPath: "DE_TrustTunnel_keen-mole17.toml" }),
      );
    });
  });

  // ─── 2. localStorage restore ─────────────────────────

  describe("localStorage restore", () => {
    it("restores persisted fields from localStorage on init", () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          host: "10.0.0.1",
          port: "2222",
          sshUser: "admin",
          sshKeyPath: "/home/.ssh/id_rsa",
          listenAddress: "0.0.0.0:8443",
          vpnUsername: "testuser",
          certType: "selfsigned",
          domain: "example.com",
          email: "a@b.com",
          // 06-uat: a legacy `wizardStep: "server"` blob maps to `step: "server"` then the
          // seed remaps the deleted `server` screen to the install entry `endpoint`.
          wizardStep: "server",
        }),
      );

      const { result } = renderWizard();

      expect(result.current.step).toBe("endpoint");
      expect(result.current.host).toBe("10.0.0.1");
      expect(result.current.port).toBe("2222");
      expect(result.current.sshUser).toBe("admin");
      expect(result.current.sshKeyPath).toBe("/home/.ssh/id_rsa");
      expect(result.current.listenAddress).toBe("0.0.0.0:8443");
      expect(result.current.vpnUsername).toBe("testuser");
      expect(result.current.certType).toBe("selfsigned");
      expect(result.current.domain).toBe("example.com");
      expect(result.current.email).toBe("a@b.com");
      // 06-uat install-wizard slimming: icmpEnable / ipv6Available are no longer
      // persisted wizard state (toggles hidden, defaults hard-coded in deploy.rs), so a
      // legacy blob carrying them is simply ignored — no hook field reads them back.
    });

    it('resets "done" step to "endpoint" when no config path exists', () => {
      // 06-uat: the neutral fallback is the install entry `endpoint` now.
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ wizardStep: "done" }),
      );

      const { result } = renderWizard();
      expect(result.current.step).toBe("endpoint");
    });

    it('keeps "done" step when config path exists', () => {
      localStorage.setItem("tt_config_path", "/some/path.toml");
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ wizardStep: "done" }),
      );

      const { result } = renderWizard();
      expect(result.current.step).toBe("done");
    });

    it('seeds "endpoint" (not a false "done" flash) when a host is saved — the mount probe overrides it', () => {
      // Regression: clicking «Установить» on a server with a stale step="done" +
      // config flashed «Всё готово» for ~0.5s before resolveResumeOnOpen corrected
      // it. With a saved host the probe WILL fire and override the seed, so the seed
      // must not show a terminal screen. 06-uat: the honest pre-probe placeholder is now
      // the neutral install entry `endpoint` (the deleted `checking` probe screen is gone).
      localStorage.setItem("tt_config_path", "/some/path.toml");
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ host: "10.0.0.1", port: "22", sshUser: "root", wizardStep: "done" }),
      );

      const { result } = renderWizard();
      expect(result.current.step).toBe("endpoint");
    });

    it('installEntry: opens straight on endpoint with NO server probe (Control Panel «Установить»)', async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          host: "10.0.0.1", port: "22", sshUser: "root",
          step: "endpoint", installEntry: true, wizardMode: "deploy",
        }),
      );
      // ensureResumeSecret loads the SSH secret from the keyring; the resume PROBE
      // (check_server_installation) must NOT run on the install entry.
      mockInvoke.mockImplementation((cmd: string) =>
        cmd === "load_ssh_credentials_for"
          ? Promise.resolve({ host: "10.0.0.1", port: "22", user: "root", password: "pw" })
          : Promise.resolve(null),
      );

      const { result } = renderWizard();
      await act(async () => { await Promise.resolve(); });

      expect(result.current.step).toBe("endpoint");
      expect(result.current.installEntry).toBe(true);
      expect(mockInvoke).not.toHaveBeenCalledWith("check_server_installation", expect.anything());
      // The one-shot marker is consumed so a later reopen resumes via the probe.
      expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).installEntry).toBeUndefined();
    });

    it('falls back "deploying" to "endpoint" when no config path', () => {
      // 06-uat: an in-flight deploy with no completed install falls back to the neutral
      // install entry `endpoint`.
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ wizardStep: "deploying" }),
      );

      const { result } = renderWizard();
      expect(result.current.step).toBe("endpoint");
    });

    it('falls back the legacy "checking" step to "endpoint"', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ wizardStep: "checking" }),
      );

      const { result } = renderWizard();
      expect(result.current.step).toBe("endpoint");
    });
  });

  // ─── 3. setHost / setPort / etc ──────────────────────

  describe("field setters persist to localStorage", () => {
    it("setHost updates state and persists", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setHost("192.168.1.1");
      });

      expect(result.current.host).toBe("192.168.1.1");
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.host).toBe("192.168.1.1");
    });

    it("setPort updates state and persists", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setPort("3333");
      });

      expect(result.current.port).toBe("3333");
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.port).toBe("3333");
    });

    it("setSshUser updates state and persists", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setSshUser("deploy");
      });

      expect(result.current.sshUser).toBe("deploy");
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.sshUser).toBe("deploy");
    });

    it("setVpnUsername updates state and persists", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setVpnUsername("myuser");
      });

      expect(result.current.vpnUsername).toBe("myuser");
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.vpnUsername).toBe("myuser");
    });

    it("setCertType updates state and persists", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setCertType("selfsigned");
      });

      expect(result.current.certType).toBe("selfsigned");
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.certType).toBe("selfsigned");
    });

    it("setAuthFailureStatusCode updates state and persists (advanced settings wiring)", () => {
      // 06-uat install-wizard slimming: the setIcmpEnable persistence test was replaced
      // by this one — the ICMP toggle was removed, but the 407/405 chooser is the kept
      // advanced setting and exercises the SAME saveField persistence path.
      const { result } = renderWizard();

      // Default 407; flip to 405 to prove the setter + persistence wiring.
      act(() => {
        result.current.setAuthFailureStatusCode(405);
      });

      expect(result.current.authFailureStatusCode).toBe(405);
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.authFailureStatusCode).toBe(405);
    });

    // WIZARD-06 / D-01: the firewall + fail2ban toggles flip independently. They are
    // session-only install choices (not persisted to localStorage — unlike the cert /
    // 407 settings — because they describe a one-time provisioning action, not a
    // remembered preference).
    it("setEnableFirewall flips only the firewall flag", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setEnableFirewall(false);
      });

      expect(result.current.enableFirewall).toBe(false);
      // fail2ban untouched
      expect(result.current.enableFail2ban).toBe(true);
    });

    it("setEnableFail2ban flips only the fail2ban flag", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setEnableFail2ban(false);
      });

      expect(result.current.enableFail2ban).toBe(false);
      // firewall untouched
      expect(result.current.enableFirewall).toBe(true);
    });
  });

  // ─── 4. Secret exclusion (D-05) ──────────────────────
  // NOTE: this block previously asserted the OLD insecure behavior (plaintext
  // sshPassword/vpnPassword persisted to localStorage). Plan 05-01 Task 3 removes
  // that persistence (D-05 — secrets are session-only; the SSH password lives in
  // Windows Credential Manager). These tests now pin the NEW secure behavior:
  // setting a secret must NOT write it to localStorage, and an old blob's
  // plaintext is migrated out, not restored into a persisted field.

  describe("secret exclusion (D-05)", () => {
    it("does NOT write sshPassword to localStorage", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setSshPassword("secret123");
      });

      // State still holds it for the session…
      expect(result.current.sshPassword).toBe("secret123");
      // …but it is never persisted.
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw ?? "").not.toContain("secret123");
      if (raw) {
        expect(JSON.parse(raw).sshPassword).toBeUndefined();
      }
    });

    it("does NOT write vpnPassword to localStorage", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setVpnPassword("vpnpass!");
      });

      expect(result.current.vpnPassword).toBe("vpnpass!");
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw ?? "").not.toContain("vpnpass!");
      if (raw) {
        expect(JSON.parse(raw).vpnPassword).toBeUndefined();
      }
    });

    it("migrates a legacy plaintext SSH password into Credential Manager on mount", async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          host: "10.0.0.1",
          port: "22",
          sshUser: "root",
          sshPassword: "legacySecret",
        }),
      );

      await act(async () => {
        renderWizard();
        // let the fire-and-forget mount migration settle
        await Promise.resolve();
      });

      // The legacy plaintext was handed to Credential Manager (migrate-before-strip).
      expect(mockInvoke).toHaveBeenCalledWith(
        "save_ssh_credentials",
        expect.objectContaining({ password: "legacySecret" }),
      );
    });

    it("does NOT restore a plaintext password into the persisted snapshot field", () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ sshPassword: "mySecret", vpnPassword: "mySecret", host: "1.2.3.4" }),
      );

      const { result } = renderWizard();
      // Non-secret fields restore as before…
      expect(result.current.host).toBe("1.2.3.4");
      // …secrets are NOT pulled from the blob (session-only, D-05). sshPassword stays
      // empty. vpnPassword is never restored either — D-11 (06-13) then seeds a FRESH
      // generated password on mount (the field was empty), so the assertion is that the
      // persisted plaintext "mySecret" never lands in the field, NOT that it stays empty.
      expect(result.current.sshPassword).toBe("");
      expect(result.current.vpnPassword).not.toBe("mySecret");
    });
  });

  // ─── 5-7. handleCheckServer — REMOVED (06-uat) ───────
  // The manual server-installation check (handleCheckServer) + the server-probe screen
  // were removed from the install wizard. SSH auth + the installed/not-installed check now
  // happen in the Control Panel before the wizard opens; the wizard reads its SSH secret
  // from the per-host keyring. The host-key-changed → recovery routing is still covered via
  // the resume path (resolveResumeOnOpen), and handleTrustNewKey is retained below.

  // ─── 7. Recovery: explicit trust of a changed host key (D-09) ──

  describe("handleTrustNewKey — explicit trust (D-09)", () => {
    it("forgets the old key THEN re-runs the probe (explicit trust)", async () => {
      const seen: string[] = [];
      mockInvoke.mockImplementation(async (cmd: string) => {
        seen.push(cmd);
        if (cmd === "forget_ssh_host_key") return null;
        if (cmd === "check_server_installation") {
          return {
            installed: false, binaryInstalled: false, credentialsExist: false,
            rulesExist: false, vpnConfigExists: false, hostsConfigExists: false,
            certPresent: false, unitExists: false, unitEnabled: false,
            serviceActive: false, partial: false, configDiverges: false,
            version: "", users: [],
          };
        }
        return null;
      });

      const { result } = renderWizard();
      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleTrustNewKey();
      });

      // The explicit trust action forgets the old key (re-arming TOFU) and re-probes.
      expect(mockInvoke).toHaveBeenCalledWith(
        "forget_ssh_host_key",
        expect.objectContaining({ host: "10.0.0.1" }),
      );
      // forget happens BEFORE the re-probe.
      expect(seen.indexOf("forget_ssh_host_key")).toBeLessThan(
        seen.indexOf("check_server_installation"),
      );
      // A clean (not-installed) re-probe resolves to the configure flow.
      expect(result.current.step).toBe("endpoint");
    });
  });

  // ─── 7a. WR-06 lifecycle: the post-forget re-probe is answered by the
  //        always-mounted TOFU listener (no 60s-timeout window) — verify-first ──
  //
  // RESEARCH (HIGH confidence) found WR-06 is already mitigated: useHostKeyVerification
  // (the `listen("ssh-host-key-verify")` TOFU listener) is mounted UNCONDITIONALLY at
  // App.tsx root, and handleTrustNewKey's `forget_ssh_host_key` + re-probe path returns
  // immediately with no 60s wait. This block PROVES the lifecycle instead of assuming it:
  // when handleTrustNewKey re-probes a now-unknown key, the re-probe emits
  // `ssh-host-key-verify`, a live listener exists AT EMIT TIME, and the listener's
  // `pending` becomes non-null — answered synchronously, with NO reliance on any timer.
  //
  // We render useHostKeyVerification alongside the wizard hook so the always-mounted
  // App-level listener contract is represented faithfully in the unit-under-test. We also
  // replace the global no-op `listen` mock with a real event-bus registry so the listener
  // actually receives the emitted event (the default mock swallows it).
  describe("WR-06 lifecycle — post-forget re-probe answered by the always-mounted listener", () => {
    type HostKeyHandler = (event: { payload: { host: string; fingerprint: string } }) => void;

    // A minimal event bus standing in for the Tauri event system: useHostKeyVerification's
    // listen("ssh-host-key-verify") registers a real handler here, and the re-probe mock
    // dispatches into it (simulating the Rust backend emitting on a now-unknown key).
    function installEventBus() {
      const handlers = new Map<string, Set<HostKeyHandler>>();
      mockListen.mockImplementation(async (event: string, cb: HostKeyHandler) => {
        let set = handlers.get(event);
        if (!set) { set = new Set(); handlers.set(event, set); }
        set.add(cb);
        return () => set!.delete(cb); // unlisten
      });
      return {
        // True only while a live listener is registered for the event.
        hasListener: (event: string) => (handlers.get(event)?.size ?? 0) > 0,
        emit: (event: string, payload: { host: string; fingerprint: string }) => {
          const set = handlers.get(event);
          if (!set) return;
          for (const cb of set) cb({ payload });
        },
      };
    }

    // Render the wizard hook AND the always-mounted TOFU listener in one tree, mirroring
    // App.tsx where useHostKeyVerification() lives unconditionally at the root alongside
    // whatever renders the wizard.
    function renderWizardWithHostKeyListener() {
      const onSetupComplete = vi.fn();
      const onClose = vi.fn();
      return renderHook(() => {
        const wizard = useWizardState({ onSetupComplete, onClose });
        const hostKey = useHostKeyVerification();
        return { wizard, hostKey };
      });
    }

    it("handleTrustNewKey forgets the old key, re-probes a now-unknown key, and the always-mounted listener answers ssh-host-key-verify — no timeout window", async () => {
      const bus = installEventBus();
      const seen: string[] = [];
      // Overwritten by the check_server_installation mock at the instant it emits the
      // event, recording whether a live listener was registered then (the WR-06
      // invariant). Seeds false so that if the re-probe never emits, the assertion below
      // fails loudly rather than reading an undefined value.
      let listenerAtEmitTime = false;

      mockInvoke.mockImplementation(async (cmd: string) => {
        seen.push(cmd);
        if (cmd === "forget_ssh_host_key") return null;
        if (cmd === "check_server_installation") {
          // The re-probe hits a now-unknown host key (TOFU re-armed by the forget). The
          // Rust backend would emit `ssh-host-key-verify`; we simulate that here. Capture
          // whether a live listener is registered at the exact moment the event fires —
          // this is the WR-06 invariant: the event must NEVER fire into a void.
          listenerAtEmitTime = bus.hasListener("ssh-host-key-verify");
          bus.emit("ssh-host-key-verify", { host: "10.0.0.1", fingerprint: "SHA256:newkey" });
          // After the user answers via the dialog the connect proceeds; return a clean
          // (not-installed) probe so the wizard resolves deterministically.
          return {
            installed: false, binaryInstalled: false, credentialsExist: false,
            rulesExist: false, vpnConfigExists: false, hostsConfigExists: false,
            certPresent: false, unitExists: false, unitEnabled: false,
            serviceActive: false, partial: false, configDiverges: false,
            version: "", users: [],
          };
        }
        return null;
      });

      const { result } = renderWizardWithHostKeyListener();

      // Route the wizard into recovery with the changed-key cause, exactly as the resume
      // path does (setRecoveryCause("SSH_HOST_KEY_CHANGED")) — without auto-forgetting.
      act(() => {
        result.current.wizard.setHost("10.0.0.1");
        result.current.wizard.setSshPassword("pass");
      });

      // The mount effect's resume probe may have emitted; reset so we measure ONLY the
      // handleTrustNewKey re-probe below.
      act(() => { result.current.hostKey.respond(true); });
      seen.length = 0;

      await act(async () => {
        await result.current.wizard.handleTrustNewKey();
      });

      // (a) the old key is forgotten with the current host/port.
      expect(mockInvoke).toHaveBeenCalledWith(
        "forget_ssh_host_key",
        expect.objectContaining({ host: "10.0.0.1", port: 22 }),
      );
      // (b) the re-probe runs AFTER the forget.
      expect(seen.indexOf("forget_ssh_host_key")).toBeLessThan(
        seen.indexOf("check_server_installation"),
      );
      // (c) a LIVE listener existed at the instant the re-probe emitted the event — there
      //     is NO window where ssh-host-key-verify fires with nothing listening.
      expect(listenerAtEmitTime).toBe(true);
      // (d) the always-mounted listener ANSWERED it: pending is non-null, set
      //     synchronously by the event handler — no reliance on any 60s timer.
      expect(result.current.hostKey.pending).toEqual({
        host: "10.0.0.1",
        fingerprint: "SHA256:newkey",
      });
    });

    it("no silent auto-forget: forget_ssh_host_key is NEVER called on the SSH_HOST_KEY_CHANGED routing — only inside the explicit handleTrustNewKey", async () => {
      installEventBus();
      const seen: string[] = [];
      mockInvoke.mockImplementation(async (cmd: string) => {
        seen.push(cmd);
        // The resume probe rejects with a changed-key error → the wizard routes into the
        // recovery fork (setRecoveryCause("SSH_HOST_KEY_CHANGED")) WITHOUT forgetting.
        if (cmd === "check_server_installation") throw new Error("SSH_HOST_KEY_CHANGED detected");
        return null;
      });

      const { result } = renderWizardWithHostKeyListener();
      act(() => {
        result.current.wizard.setHost("10.0.0.1");
        result.current.wizard.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.wizard.resolveResumeOnOpen();
      });

      // The changed-key error routed into recovery…
      expect(result.current.wizard.step).toBe("recovery");
      expect(result.current.wizard.recoveryCause).toBe("SSH_HOST_KEY_CHANGED");
      // …but the key was NOT forgotten automatically. Trust is EXPLICIT-only.
      expect(seen).not.toContain("forget_ssh_host_key");
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "forget_ssh_host_key",
        expect.anything(),
      );
    });
  });

  // ─── 7b. Single explicit auth method (D-06) ───
  // 06-uat: handleCheckServer was removed, so the D-06 single-method-at-the-IPC-boundary
  // contract is now exercised through handleUninstall (which also routes every SSH call
  // through buildAuthArgs). The field-clearing behavior of setAuthMode is unchanged.

  describe("explicit single auth method (D-06)", () => {
    it("toggling to key clears the password and the invoke carries NO password (D-06 at the IPC boundary)", async () => {
      mockInvoke.mockResolvedValue(null);

      const { result } = renderWizard();

      // Start by typing a password, then switch to key with a selected key path.
      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("secretpw");
      });
      act(() => {
        result.current.setSshKeyPath("/home/.ssh/id_ed25519");
        result.current.setAuthMode("key"); // <- clears the password (D-06)
      });

      // The cleared password is observable in state.
      expect(result.current.sshPassword).toBe("");
      expect(result.current.authMode).toBe("key");

      await act(async () => {
        await result.current.handleUninstall();
      });

      // CRITICAL: only the key method crosses the IPC boundary — no password, and
      // authMethod="key" so the backend attempts ONLY the key.
      const call = mockInvoke.mock.calls.find((c: unknown[]) => c[0] === "uninstall_server");
      expect(call).toBeTruthy();
      const args = call![1] as Record<string, unknown>;
      expect(args.authMethod).toBe("key");
      expect(args.password).toBe("");
      expect(args.keyPath).toBe("/home/.ssh/id_ed25519");
      expect(args.keyData).toBeUndefined();
    });

    it("toggling to password clears the key fields and sends only the password + authMethod (D-06)", async () => {
      mockInvoke.mockResolvedValue(null);

      const { result } = renderWizard();
      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshKeyPath("/home/.ssh/id_ed25519");
        result.current.setSshKeyData("-----BEGIN-----");
      });
      act(() => {
        result.current.setSshPassword("secretpw");
        result.current.setAuthMode("password"); // <- clears both key fields
      });

      expect(result.current.sshKeyPath).toBe("");
      expect(result.current.sshKeyData).toBe("");

      await act(async () => {
        await result.current.handleUninstall();
      });

      const call = mockInvoke.mock.calls.find((c: unknown[]) => c[0] === "uninstall_server");
      const args = call![1] as Record<string, unknown>;
      expect(args.authMethod).toBe("password");
      expect(args.password).toBe("secretpw");
      expect(args.keyPath).toBeUndefined();
      expect(args.keyData).toBeUndefined();
    });
  });

  // ─── 8. handleDeploy ────────────────────────────────

  describe("handleDeploy", () => {
    it("sets step to 'deploying' and calls deploy_server", async () => {
      // deploy_server returns the BASIC <login>.toml; the post-deploy advanced
      // re-export (fetch_server_config) then overwrites the SAME file and returns
      // its path — which is what configPath ends up pointing at.
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "deploy_server") return "/path/to/config.toml";
        if (cmd === "fetch_server_config") return "/path/to/user1.toml";
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
        const deployPromise = result.current.handleDeploy();
        // The step should change to deploying immediately
        void result.current.step;
        await deployPromise;
      });

      expect(mockInvoke).toHaveBeenCalledWith(
        "deploy_server",
        expect.objectContaining({
          host: "10.0.0.1",
          settings: expect.objectContaining({
            vpnUsername: "user1",
          }),
        }),
      );
      // configPath points at the advanced re-export, not the basic deploy result.
      expect(result.current.configPath).toBe("/path/to/user1.toml");
    });

    // WIZARD-06 / D-01: the two server-protection flags reach the deploy_server payload
    // (camelCase here → serde snake_case enable_firewall/enable_fail2ban on the Rust
    // side, Plan 01). They are sent for EVERY cert type (not gated like domain/email).
    it("carries enableFirewall/enableFail2ban (default true) into the deploy_server settings payload", async () => {
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "deploy_server") return "/path/to/config.toml";
        if (cmd === "fetch_server_config") return "/path/to/user1.toml";
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

      const call = mockInvoke.mock.calls.find((c: unknown[]) => c[0] === "deploy_server");
      expect(call).toBeTruthy();
      const settings = (call![1] as { settings: Record<string, unknown> }).settings;
      expect(settings.enableFirewall).toBe(true);
      expect(settings.enableFail2ban).toBe(true);
    });

    // The flags reflect the CURRENT toggle state at deploy time, not a hard-coded true.
    it("carries the flipped firewall/fail2ban state into the deploy_server payload", async () => {
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "deploy_server") return "/path/to/config.toml";
        if (cmd === "fetch_server_config") return "/path/to/user1.toml";
        return null;
      });

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
        result.current.setVpnUsername("user1");
        result.current.setVpnPassword("vpnpass");
        result.current.setEnableFirewall(false);
        result.current.setEnableFail2ban(false);
      });

      await act(async () => {
        await result.current.handleDeploy();
      });

      const call = mockInvoke.mock.calls.find((c: unknown[]) => c[0] === "deploy_server");
      expect(call).toBeTruthy();
      const settings = (call![1] as { settings: Record<string, unknown> }).settings;
      expect(settings.enableFirewall).toBe(false);
      expect(settings.enableFail2ban).toBe(false);
    });

    // ─── 06-uat Option X: first-user advanced persist after deploy ──
    //
    // The install used to write ONLY credentials.toml (username+password); the
    // first user's advanced posture (anti-DPI, display name, customSni=LE domain,
    // DNS) was export-only and never reached the server user, so the Users-tab
    // editor showed those fields EMPTY. After a SUCCESSFUL deploy we now persist
    // them via the two existing-user side-store commands (which never touch
    // credentials.toml — preserving D-02 no-clobber).

    it("persists the first user's advanced settings to the real server user after a successful deploy (Option X)", async () => {
      // deploy_server returns the basic config; the two persist commands resolve;
      // fetch_server_config re-exports the advanced config and returns its path.
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "deploy_server") return "/path/to/config.toml";
        if (cmd === "fetch_server_config") return "/path/to/user1.toml";
        return null;
      });

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
        result.current.setVpnUsername("user1");
        result.current.setVpnPassword("vpnpass");
        result.current.setCertType("letsencrypt");
        result.current.setDomain("vpn.example.com");
        // Trim a display name + flip anti-DPI off so we assert the captured posture.
        result.current.updateFirstUserAdvanced("displayName", "  My Laptop  ");
        result.current.updateFirstUserAdvanced("antiDpi", false);
        result.current.updateFirstUserAdvanced("dnsUpstreams", ["1.1.1.1"]);
      });

      await act(async () => {
        await result.current.handleDeploy();
      });

      // rules.toml write — anti-DPI prefix (regenerate for a fresh first user).
      expect(mockInvoke).toHaveBeenCalledWith(
        "server_update_user_config",
        expect.objectContaining({
          username: "user1",
          antiDpi: false,
          regeneratePrefix: true,
        }),
      );
      // users-advanced.toml write — display name trimmed, customSni = LE domain, DNS.
      const advCall = mockInvoke.mock.calls.find(
        (c: unknown[]) => c[0] === "server_set_user_advanced",
      );
      expect(advCall).toBeTruthy();
      const params = (advCall![1] as { params: Record<string, unknown> }).params;
      expect(params).toMatchObject({
        username: "user1",
        display_name: "My Laptop",
        custom_sni: "vpn.example.com",
        dns_upstreams: ["1.1.1.1"],
        anti_dpi: false,
        // Trimmed first-user set never sets these — safe defaults.
        upstream_protocol: null,
        skip_verification: false,
        pin_cert_der_b64: null,
      });

      // ORDER: the advanced re-export MUST run AFTER the advanced settings were
      // written server-side (server_set_user_advanced), otherwise it would re-read
      // the OLD users-advanced.toml and the install config would stay basic.
      const cmds = mockInvoke.mock.calls.map((c: unknown[]) => c[0] as string);
      const advIdx = cmds.indexOf("server_set_user_advanced");
      const fetchIdx = cmds.indexOf("fetch_server_config");
      expect(advIdx).toBeGreaterThanOrEqual(0);
      expect(fetchIdx).toBeGreaterThan(advIdx);

      // The advanced re-export overwrites the SAME per-login file; it carries the
      // first-user login so server_config.rs writes <login>.toml.
      expect(mockInvoke).toHaveBeenCalledWith(
        "fetch_server_config",
        expect.objectContaining({ clientName: "user1" }),
      );

      // configPath points at the advanced re-export, not the basic deploy result.
      expect(result.current.configPath).toBe("/path/to/user1.toml");
    });

    it("does NOT persist first-user advanced settings when deploy_server FAILS", async () => {
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "deploy_server") throw new Error("deploy failed");
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

      expect(result.current.step).toBe("error");
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "server_update_user_config",
        expect.anything(),
      );
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "server_set_user_advanced",
        expect.anything(),
      );
    });

    it("a failing advanced-persist does NOT reject handleDeploy — install stays successful (best-effort)", async () => {
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "deploy_server") return "/path/to/config.toml";
        // Both side-store writes fail — the install must still report success.
        if (
          cmd === "server_update_user_config" ||
          cmd === "server_set_user_advanced"
        ) {
          throw new Error("SSH_USERS_ADVANCED_WRITE_FAILED|1");
        }
        // The advanced re-export still succeeds (it re-reads whatever the server has).
        if (cmd === "fetch_server_config") return "/path/to/user1.toml";
        return null;
      });

      const { result } = renderWizard();
      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
        result.current.setVpnUsername("user1");
        result.current.setVpnPassword("vpnpass");
      });

      let threw = false;
      await act(async () => {
        try {
          await result.current.handleDeploy();
        } catch {
          threw = true;
        }
      });

      // handleDeploy resolved (did not reject) AND the install is marked complete.
      expect(threw).toBe(false);
      expect(result.current.configPath).toBe("/path/to/user1.toml");
      expect(result.current.step).not.toBe("error");
    });

    it("a failing advanced re-export falls back to the basic deploy path — install still completes (best-effort)", async () => {
      // The post-deploy advanced re-export (fetch_server_config) throws. The install
      // already succeeded, so configPath must fall back to the basic deploy result
      // rather than failing the whole flow.
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "deploy_server") return "/path/to/config.toml";
        if (cmd === "fetch_server_config") {
          throw new Error("SSH_EXPORT_FAILED|1");
        }
        return null; // both persist side-stores resolve
      });

      const { result } = renderWizard();
      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
        result.current.setVpnUsername("user1");
        result.current.setVpnPassword("vpnpass");
      });

      let threw = false;
      await act(async () => {
        try {
          await result.current.handleDeploy();
        } catch {
          threw = true;
        }
      });

      // handleDeploy resolved (did not reject); configPath falls back to the basic
      // deploy <login>.toml and the wizard is NOT on the error screen.
      expect(threw).toBe(false);
      expect(result.current.configPath).toBe("/path/to/config.toml");
      expect(result.current.step).not.toBe("error");
    });

    // WR-01: the port-80-busy "switch to self-signed" action sets certType then
    // immediately re-deploys in the SAME tick. setCertType is async, so handleDeploy
    // would read the STALE letsencrypt certType from its closure and re-hit the same
    // port-80 failure. handleDeploy({ overrideCertType: "selfsigned" }) must make the
    // deploy invoke fire with certType:"selfsigned" and an EMPTY domain regardless of
    // the not-yet-committed state.
    it("handleDeploy({ overrideCertType: 'selfsigned' }) deploys with selfsigned + empty domain even when certType state is still letsencrypt (WR-01)", async () => {
      mockInvoke.mockResolvedValueOnce("/path/to/config.toml");

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
        result.current.setVpnUsername("user1");
        result.current.setVpnPassword("vpnpass");
        // State is letsencrypt with a domain — exactly the port-80-busy scenario.
        result.current.setCertType("letsencrypt");
        result.current.setDomain("example.com");
      });

      await act(async () => {
        await result.current.handleDeploy({ overrideCertType: "selfsigned" });
      });

      const call = mockInvoke.mock.calls.find((c: unknown[]) => c[0] === "deploy_server");
      expect(call).toBeTruthy();
      const settings = (call![1] as { settings: Record<string, unknown> }).settings;
      // The override wins over the stale state: selfsigned cert, no domain (a self-
      // signed install must never carry the letsencrypt domain).
      expect(settings.certType).toBe("selfsigned");
      expect(settings.domain).toBe("");
    });

    it("sets error state when deploy_server rejects", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("deploy failed"));

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleDeploy();
      });

      expect(result.current.step).toBe("error");
      expect(result.current.errorMessage).toContain("deploy failed");
    });

    // ─── Bounded silent whole-deploy retry on SSH drop (D-03, Codex #6) ──

    it("retries the WHOLE deploy_server a bounded number of times on a transient SSH drop, then lands on recovery (no loop)", async () => {
      // deploy_server is a single RPC owning all stages — the retry unit is the whole
      // call. A persistent transient drop must re-invoke up to the bound then STOP at
      // the recovery fork, never loop.
      let deployCalls = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "deploy_server") {
          deployCalls += 1;
          throw new Error("SSH_TIMEOUT|10.0.0.1:22"); // transient drop every time
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

      // MAX_DEPLOY_RETRIES (3) extra attempts after the first = 4 total invokes.
      expect(deployCalls).toBe(4);
      // On exhaustion the wizard surfaces the recovery fork — NOT the error screen,
      // and NOT an infinite loop.
      expect(result.current.step).toBe("recovery");
    });

    it("a transient drop that recovers before the bound succeeds without reaching recovery", async () => {
      // First two attempts drop transiently, the third succeeds → success, no fork.
      let deployCalls = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "deploy_server") {
          deployCalls += 1;
          if (deployCalls < 3) throw new Error("connection reset by peer");
          return "/path/to/config.toml";
        }
        if (cmd === "fetch_server_config") return "/path/to/user1.toml";
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

      expect(deployCalls).toBe(3);
      // configPath = the advanced re-export written after the recovered deploy.
      expect(result.current.configPath).toBe("/path/to/user1.toml");
      expect(result.current.step).not.toBe("recovery");
    });

    it("a DETERMINISTIC (non-transient) deploy failure does NOT retry — straight to the error screen", async () => {
      // A port-in-use / cert failure is not a transport drop; retrying can't fix it,
      // so it must go to `error` (with the retry button) on the FIRST failure.
      let deployCalls = 0;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "deploy_server") {
          deployCalls += 1;
          throw new Error("Address in use (os error 98)");
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

      expect(deployCalls).toBe(1); // no retry on a deterministic failure
      expect(result.current.step).toBe("error");
    });
  });

  // ─── 9. handleFetchConfig — REMOVED (06-uat) ─────────
  // The standalone fetch flow (handleFetchConfig / fetchRetryCount / FetchingStep) was
  // removed from the install wizard. Exporting an existing user's config is done from the
  // Control Panel (per-user QR/Link), so there is no in-wizard fetch handler to test.

  // ─── 10. handleUninstall ─────────────────────────────

  describe("handleUninstall", () => {
    it("calls vpn_disconnect then uninstall_server and closes the overlay on success", async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // vpn_disconnect
        .mockResolvedValueOnce(undefined); // uninstall_server

      // 06-uat: a successful uninstall closes the wizard back to the Control Panel
      // (onClose) instead of routing to the deleted `server` screen.
      const onClose = vi.fn();
      const { result } = renderWizard({ onClose });

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleUninstall();
      });

      expect(mockInvoke).toHaveBeenCalledWith("vpn_disconnect");
      expect(mockInvoke).toHaveBeenCalledWith(
        "uninstall_server",
        expect.objectContaining({ host: "10.0.0.1" }),
      );
      expect(onClose).toHaveBeenCalled();
      expect(result.current.serverInfo).toBeNull();
    });

    it("sets error state when uninstall_server rejects", async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // vpn_disconnect
        .mockRejectedValueOnce(new Error("uninstall failed")); // uninstall_server

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleUninstall();
      });

      expect(result.current.step).toBe("error");
      expect(result.current.errorMessage).toContain("uninstall failed");
    });

    // CR-02 / D-06: in KEY mode setAuthMode("key") clears sshPassword to "". The
    // SSH-invoking handlers must route through buildAuthArgs() so they send
    // authMethod:"key" + the key and NO non-empty password — not a hand-rolled empty
    // password that the backend would treat as a LegacySequence fallback attempt.
    it("KEY-MODE handleUninstall sends authMethod:'key' + the key and NO non-empty password", async () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setAuthMode("key"); // clears sshPassword to ""
        result.current.setSshKeyPath("/home/.ssh/id_rsa");
      });

      await act(async () => {
        await result.current.handleUninstall();
      });

      const call = mockInvoke.mock.calls.find((c: unknown[]) => c[0] === "uninstall_server");
      expect(call).toBeDefined();
      const args = call![1] as { authMethod?: string; password?: string; keyPath?: string };
      expect(args.authMethod).toBe("key");
      expect(args.keyPath).toBe("/home/.ssh/id_rsa");
      // No non-empty password ever crosses the boundary in key mode.
      expect(args.password ?? "").toBe("");
    });

    // CR-02: the DESTRUCTIVE full-clean uninstall (Start over) is the highest-stakes
    // path — a spurious empty-password auth attempt here could strand the user or
    // authenticate via a blank-password path they never consented to. It must send
    // the chosen key method only.
    it("KEY-MODE handleStartOver sends authMethod:'key' + the key and NO non-empty password", async () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setAuthMode("key");
        result.current.setSshKeyPath("/home/.ssh/id_rsa");
      });

      await act(async () => {
        await result.current.handleStartOver();
      });

      const call = mockInvoke.mock.calls.find((c: unknown[]) => c[0] === "uninstall_server");
      expect(call).toBeDefined();
      const args = call![1] as { authMethod?: string; password?: string; keyPath?: string };
      expect(args.authMethod).toBe("key");
      expect(args.keyPath).toBe("/home/.ssh/id_rsa");
      expect(args.password ?? "").toBe("");
    });
  });

  // ─── 11. handleAddUser / handleDeleteUser ────────────

  describe("handleAddUser", () => {
    it("calls add_server_user with correct params", async () => {
      mockInvoke
        .mockResolvedValueOnce("ok") // add_server_user
        .mockResolvedValueOnce({     // check_server_installation refresh
          installed: true,
          version: "1.5.0",
          serviceActive: true,
          users: ["alice", "newuser"],
        });

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
        result.current.setNewUsername("newuser");
        result.current.setNewPassword("newpass");
      });

      await act(async () => {
        await result.current.handleAddUser();
      });

      expect(mockInvoke).toHaveBeenCalledWith(
        "add_server_user",
        expect.objectContaining({
          host: "10.0.0.1",
          vpnUsername: "newuser",
          vpnPassword: "newpass",
        }),
      );
      // Fields cleared after success
      expect(result.current.newUsername).toBe("");
      expect(result.current.newPassword).toBe("");
      // Server info refreshed
      expect(result.current.serverInfo?.users).toContain("newuser");
    });

    it("does nothing when username or password is empty", async () => {
      const { result } = renderWizard();

      await act(async () => {
        await result.current.handleAddUser();
      });

      expect(mockInvoke).not.toHaveBeenCalledWith(
        "add_server_user",
        expect.anything(),
      );
    });

    it("sets errorMessage when add_server_user rejects", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("user exists"));

      const { result } = renderWizard();

      act(() => {
        result.current.setNewUsername("dup");
        result.current.setNewPassword("pass");
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("sshpass");
      });

      await act(async () => {
        await result.current.handleAddUser();
      });

      expect(result.current.errorMessage).toContain("user exists");
    });
  });

  describe("handleDeleteUser", () => {
    it("calls server_remove_user with correct params", async () => {
      mockInvoke
        .mockResolvedValueOnce(undefined) // server_remove_user
        .mockResolvedValueOnce({          // check_server_installation refresh
          installed: true,
          version: "1.5.0",
          serviceActive: true,
          users: ["bob"],
        });

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleDeleteUser("alice");
      });

      expect(mockInvoke).toHaveBeenCalledWith(
        "server_remove_user",
        expect.objectContaining({
          host: "10.0.0.1",
          vpnUsername: "alice",
        }),
      );
      expect(result.current.serverInfo?.users).toEqual(["bob"]);
    });

    it("sets errorMessage when server_remove_user rejects", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("cannot remove"));

      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.handleDeleteUser("alice");
      });

      expect(result.current.errorMessage).toContain("cannot remove");
    });
  });

  // ─── Derived state ──────────────────────────────────

  describe("derived state", () => {
    it("canGoToEndpoint is true when host and password are set", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      expect(result.current.canGoToEndpoint).toBe(true);
    });

    it("canGoToEndpoint is false when host is empty", () => {
      const { result } = renderWizard();
      expect(result.current.canGoToEndpoint).toBe(false);
    });

    // WR-03: port is free-text. An empty / non-numeric / out-of-range port makes
    // parseInt(port) → NaN, which serialises to null over IPC and the Rust u16
    // command rejects it with an opaque error. Gate canGoToEndpoint AND canDeploy
    // on a valid 1..=65535 integer so the install is blocked at the form instead.
    it("canGoToEndpoint is false when the port is empty or non-numeric (WR-03)", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
        result.current.setPort(""); // cleared field
      });
      expect(result.current.canGoToEndpoint).toBe(false);

      act(() => {
        result.current.setPort("abc"); // non-numeric
      });
      expect(result.current.canGoToEndpoint).toBe(false);

      act(() => {
        result.current.setPort("70000"); // out of range
      });
      expect(result.current.canGoToEndpoint).toBe(false);

      act(() => {
        result.current.setPort("22"); // valid → unblocked
      });
      expect(result.current.canGoToEndpoint).toBe(true);
    });

    it("canDeploy is false when the port is empty or non-numeric (WR-03)", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setVpnUsername("user1");
        result.current.setVpnPassword("pass");
        result.current.setCertType("selfsigned");
        result.current.setPort(""); // cleared field
      });
      expect(result.current.canDeploy).toBe(false);

      act(() => {
        result.current.setPort("0"); // out of range (must be >= 1)
      });
      expect(result.current.canDeploy).toBe(false);

      act(() => {
        result.current.setPort("22"); // valid → unblocked
      });
      expect(result.current.canDeploy).toBe(true);
    });

    it("canDeploy is true for selfsigned with username and password", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setVpnUsername("user1");
        result.current.setVpnPassword("pass");
        result.current.setCertType("selfsigned");
      });

      expect(result.current.canDeploy).toBe(true);
    });

    it("canDeploy is false when vpnUsername is empty", () => {
      const { result } = renderWizard();

      act(() => {
        // D-11 (06-13) seeds a generated username on mount, so explicitly clear it to
        // exercise the empty-username gate (e.g. the user deleted the seeded value).
        result.current.setVpnUsername("");
        result.current.setVpnPassword("pass");
        result.current.setCertType("selfsigned");
      });

      expect(result.current.canDeploy).toBe(false);
    });

    // UAT (06-uat fix 1): Let's Encrypt requires a NON-EMPTY valid email. isValidEmail("")
    // returns true, so before this gate an empty email let the LE install proceed; the gate
    // now also requires email.trim().length > 0.
    it("canDeploy is false on Let's Encrypt when the email is empty even with a valid domain", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setVpnUsername("user1");
        result.current.setVpnPassword("pass");
        result.current.setCertType("letsencrypt");
        result.current.setDomain("vpn.example.com");
        result.current.setEmail(""); // empty email must block install
      });
      expect(result.current.canDeploy).toBe(false);

      act(() => {
        result.current.setEmail("you@example.com"); // non-empty valid email → unblocked
      });
      expect(result.current.canDeploy).toBe(true);
    });

    it("canDeploy is false on Let's Encrypt when the email is non-empty but invalid", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setVpnUsername("user1");
        result.current.setVpnPassword("pass");
        result.current.setCertType("letsencrypt");
        result.current.setDomain("vpn.example.com");
        result.current.setEmail("not-an-email");
      });
      expect(result.current.canDeploy).toBe(false);
    });

    // ── D-11 (06-13): first-user credential seed + duplicate gate + export ──

    it("does NOT re-seed vpnUsername/vpnPassword when a value is already present (resume)", () => {
      // A restored install (non-secret snapshot carries vpnUsername) must keep the
      // user's value — the first-mount seed only fills EMPTY fields.
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ vpnUsername: "my-saved-name", host: "1.2.3.4" }),
      );
      const { result } = renderWizard();
      expect(result.current.vpnUsername).toBe("my-saved-name");
    });

    it("isDuplicateVpnUsername blocks canDeploy when serverInfo.users includes the typed name (C-02)", async () => {
      const serverInfo: ServerInfo = {
        installed: true,
        version: "1.5.0",
        serviceActive: true,
        users: ["swift-fox"],
      };
      // 06-uat: handleCheckServer was removed. serverInfo is now populated via the
      // user-management handlers (which re-fetch check_server_installation). Drive it
      // through handleDeleteUser to land the reinstall-from-Found serverInfo.users set.
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "server_remove_user") return null;
        if (cmd === "check_server_installation") return serverInfo;
        return null;
      });
      const { result } = renderWizard();
      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });
      await act(async () => {
        await result.current.handleDeleteUser("ghost");
      });
      act(() => {
        result.current.setVpnUsername("swift-fox");
        result.current.setVpnPassword("pass");
        result.current.setCertType("selfsigned");
      });
      expect(result.current.serverInfo?.users).toContain("swift-fox");
      expect(result.current.isDuplicateVpnUsername).toBe(true);
      expect(result.current.canDeploy).toBe(false);
    });

    it("isDuplicateVpnUsername is false on a clean install (serverInfo null)", () => {
      const { result } = renderWizard();
      act(() => {
        result.current.setVpnUsername("swift-fox");
        result.current.setVpnPassword("pass");
        result.current.setCertType("selfsigned");
      });
      expect(result.current.isDuplicateVpnUsername).toBe(false);
      expect(result.current.canDeploy).toBe(true);
    });

    it("isValidEmail returns true for valid emails and empty string", () => {
      const { result } = renderWizard();
      expect(result.current.isValidEmail("")).toBe(true);
      expect(result.current.isValidEmail("a@b.com")).toBe(true);
      expect(result.current.isValidEmail("invalid")).toBe(false);
    });
  });

  // ─── setWizardStep persists ──────────────────────────

  describe("setWizardStep", () => {
    it("updates step and persists to localStorage", () => {
      const { result } = renderWizard();

      act(() => {
        result.current.setWizardStep("deploying");
      });

      expect(result.current.step).toBe("deploying");
      // 05-01: the snapshot persists the navigation step under `step` (the
      // Snapshot field name), replacing the old `wizardStep` key. Visible
      // behavior is unchanged — only the serialization key was renamed.
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.step).toBe("deploying");
    });
  });

  // ─── Server-verified resume (WIZARD-02, D-02; findings D, G; round-3 MEDIUM B) ─

  describe("resolveResumeOnOpen — server-verified resume", () => {
    // A complete check_server_installation payload. Overrides per test.
    function rawProbe(over?: Record<string, unknown>) {
      return {
        installed: true,
        binaryInstalled: true,
        credentialsExist: true,
        rulesExist: true,
        vpnConfigExists: true,
        hostsConfigExists: true,
        certPresent: true,
        unitExists: true,
        unitEnabled: true,
        serviceActive: true,
        partial: false,
        configDiverges: false,
        version: "1.5.0",
        users: ["alice"],
        ...over,
      };
    }

    it("a persisted 'deploying' step + a PARTIAL probe resolves to 'recovery', not 'deploying' (counter-vs-server)", async () => {
      // Seed a snapshot at "deploying" with a config marker so it would otherwise
      // restore toward the deploy screen — the probe must override it.
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ step: "deploying", host: "10.0.0.1" }),
      );
      localStorage.setItem("tt_config_path", "C:/cfg/trusttunnel_client.toml");

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "check_server_installation") return rawProbe({ partial: true });
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        return null;
      });

      const { result } = renderWizard();
      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.resolveResumeOnOpen();
      });

      // Server truth (partial) wins over the persisted "deploying" counter.
      expect(result.current.step).toBe("recovery");
    });

    it("a fully-installed server whose exported file is GONE (read_client_config REJECTS) → 'recovery' and NO auto-fetch (06-uat)", async () => {
      localStorage.setItem("tt_config_path", "C:/cfg/missing.toml");

      const seenCommands: string[] = [];
      mockInvoke.mockImplementation(async (cmd: string) => {
        seenCommands.push(cmd);
        if (cmd === "check_server_installation") return rawProbe();
        // The real local-export file is gone → read_client_config rejects.
        if (cmd === "read_client_config") throw new Error("Failed to read config: not found");
        return null;
      });

      const { result } = renderWizard();
      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.resolveResumeOnOpen();
      });

      // 06-uat: localExportComplete:false ⇒ resolveResume returns "fetching", but the
      // wizard's fetch flow was removed — an export-pending resume now routes into the
      // recovery fork (Continue / Start over from the Control Panel) and NEVER auto-starts
      // an in-wizard fetch_server_config export.
      expect(seenCommands).toContain("read_client_config");
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "fetch_server_config",
        expect.anything(),
      );
      expect(result.current.step).toBe("recovery");
    });

    it("a fully-installed server whose exported file EXISTS (read_client_config RESOLVES) → 'done' (round-3 MEDIUM B)", async () => {
      localStorage.setItem("tt_config_path", "C:/cfg/trusttunnel_client.toml");

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "check_server_installation") return rawProbe();
        if (cmd === "read_client_config") return { vpn_mode: "general" }; // file present
        return null;
      });

      const { result } = renderWizard();
      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.resolveResumeOnOpen();
      });

      expect(result.current.step).toBe("done");
    });

    it("a unitExists:true, unitEnabled:false probe resolves to 'recovery' (finding G)", async () => {
      localStorage.setItem("tt_config_path", "C:/cfg/trusttunnel_client.toml");

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "check_server_installation") return rawProbe({ unitEnabled: false });
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        return null;
      });

      const { result } = renderWizard();
      act(() => {
        result.current.setHost("10.0.0.1");
        result.current.setSshPassword("pass");
      });

      await act(async () => {
        await result.current.resolveResumeOnOpen();
      });

      // The unit exists but was never `enable --now`d → not done; recovery.
      expect(result.current.step).toBe("recovery");
    });

    it("a missing/unavailable SSH secret on resume surfaces a re-enter prompt, not an opaque crash (D-08)", async () => {
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "check_server_installation") throw new Error("SSH_KEY_LOAD_FAILED");
        return null;
      });

      const { result } = renderWizard();
      act(() => {
        result.current.setHost("10.0.0.1");
      });

      await act(async () => {
        await result.current.resolveResumeOnOpen();
      });

      expect(result.current.secretMissing).toBe(true);
      // 06-uat: the in-wizard SSH re-enter screen was removed — a secret-miss on resume
      // routes to the recovery fork (the user re-authenticates from the Control Panel).
      expect(result.current.step).toBe("recovery");
    });

    // ─── Resume secret read via the host-keyed load_ssh_credentials_for, target-
    //     validated as defence-in-depth (Codex MEDIUM #10 + finding F; 06-19 / D-15) ───

    it("reads the secret via load_ssh_credentials_for WITH the target host/port/user args and repopulates it when the bundle MATCHES (06-19 / D-15)", async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ step: "found", host: "10.0.0.1", port: "22", sshUser: "root" }),
      );
      localStorage.setItem("tt_config_path", "C:/cfg/trusttunnel_client.toml");

      let credArgs: unknown;
      mockInvoke.mockImplementation(async (cmd: string, args: unknown) => {
        if (cmd === "load_ssh_credentials_for") {
          credArgs = args;
          // The host-keyed command returns the EXACT target's bundle.
          return { host: "10.0.0.1", port: "22", user: "root", password: "frompw", keyPath: "" };
        }
        if (cmd === "check_server_installation") return rawProbe();
        if (cmd === "read_client_config") return { vpn_mode: "general" };
        return null;
      });

      const { result } = renderWizard();
      // NO session password — forces the host-keyed load.
      await act(async () => {
        await result.current.resolveResumeOnOpen();
      });

      // 06-19: the host-keyed command is invoked with the current target.
      expect(mockInvoke).toHaveBeenCalledWith("load_ssh_credentials_for", {
        host: "10.0.0.1",
        port: "22",
        user: "root",
      });
      expect(credArgs).toEqual({ host: "10.0.0.1", port: "22", user: "root" });
      // Matching bundle → secret repopulated AND used by the probe (it resolved to done).
      expect(result.current.sshPassword).toBe("frompw");
      expect(result.current.step).toBe("done");
      expect(result.current.secretMissing).toBe(false);
    });

    it("does NOT repopulate when the bundle's host does NOT match the target — routes to re-enter (round-2 finding F)", async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ step: "found", host: "10.0.0.1", port: "22", sshUser: "root" }),
      );

      let probed = false;
      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "load_ssh_credentials_for") {
          // A corrupted/legacy store returns a bundle for a DIFFERENT server —
          // the defence-in-depth gate must still reject it.
          return { host: "99.99.99.99", port: "22", user: "root", password: "otherpw", keyPath: "" };
        }
        if (cmd === "check_server_installation") { probed = true; return rawProbe(); }
        return null;
      });

      const { result } = renderWizard();
      await act(async () => {
        await result.current.resolveResumeOnOpen();
      });

      // The wrong server's secret is NEVER used; we ask the user instead.
      expect(result.current.sshPassword).toBe("");
      expect(result.current.secretMissing).toBe(true);
      // 06-uat: the in-wizard SSH re-enter screen was removed — a secret-miss on resume
      // routes to the recovery fork (the user re-authenticates from the Control Panel).
      expect(result.current.step).toBe("recovery");
      // And we never probed with the wrong password.
      expect(probed).toBe(false);
    });

    it("a port mismatch also routes to re-enter (finding F validates host AND port AND user)", async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ step: "found", host: "10.0.0.1", port: "22", sshUser: "root" }),
      );

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "load_ssh_credentials_for") {
          // Same host/user but a DIFFERENT port → still a mismatch.
          return { host: "10.0.0.1", port: "2222", user: "root", password: "otherpw", keyPath: "" };
        }
        return null;
      });

      const { result } = renderWizard();
      await act(async () => {
        await result.current.resolveResumeOnOpen();
      });

      expect(result.current.sshPassword).toBe("");
      expect(result.current.secretMissing).toBe(true);
      // 06-uat: the in-wizard SSH re-enter screen was removed — a secret-miss on resume
      // routes to the recovery fork (the user re-authenticates from the Control Panel).
      expect(result.current.step).toBe("recovery");
    });

    it("an absent/empty bundle routes to the re-enter path (D-08)", async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ step: "found", host: "10.0.0.1", port: "22", sshUser: "root" }),
      );

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "load_ssh_credentials_for") return null; // nothing saved for this target
        return null;
      });

      const { result } = renderWizard();
      await act(async () => {
        await result.current.resolveResumeOnOpen();
      });

      expect(result.current.secretMissing).toBe(true);
      // 06-uat: the in-wizard SSH re-enter screen was removed — a secret-miss on resume
      // routes to the recovery fork (the user re-authenticates from the Control Panel).
      expect(result.current.step).toBe("recovery");
    });

    it("a matching bundle with an EMPTY password (e.g. a pasted-key bundle) routes to re-enter (finding F)", async () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ step: "found", host: "10.0.0.1", port: "22", sshUser: "root" }),
      );

      mockInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === "load_ssh_credentials_for") {
          return { host: "10.0.0.1", port: "22", user: "root", password: "", keyPath: "/k" };
        }
        return null;
      });

      const { result } = renderWizard();
      await act(async () => {
        await result.current.resolveResumeOnOpen();
      });

      expect(result.current.secretMissing).toBe(true);
      // 06-uat: the in-wizard SSH re-enter screen was removed — a secret-miss on resume
      // routes to the recovery fork (the user re-authenticates from the Control Panel).
      expect(result.current.step).toBe("recovery");
    });
  });
});
