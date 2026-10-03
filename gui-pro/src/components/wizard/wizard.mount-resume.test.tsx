// ═══════════════════════════════════════════════════════
// wizard.mount-resume.test.tsx — CR-01: server-verified resume reaches the SCREEN
// ═══════════════════════════════════════════════════════
//
// The review (CR-01) found that WIZARD-02 (verify-don't-remember resume) was dead
// at runtime: resolveResumeOnOpen was only ever called from tests, never from the
// mounted component tree, so the persisted-step seed (the remembered counter the
// phase set out to replace) was the sole runtime driver of the initial screen.
//
// These tests mount the FULL <SetupWizard/> (not just the hook) with a saved host +
// a mocked check_server_installation, and assert the probe-driven override actually
// REACHES the rendered screen — proving the mount effect (useWizardState.ts) wires
// the resume probe into runtime. They are the proof the reviewer asked for:
//   (1) a PARTIAL server → the rendered step becomes `recovery` (NOT the stale
//       persisted snapshot step, NOT a silent auto-complete — D-01).
//   (2) a fully-installed+enabled+active+export-present server → `done`.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import SetupWizard from "../SetupWizard";

const STORAGE_KEY = "trusttunnel_wizard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockInvoke = invoke as any;

describe("wizard mount-resume — CR-01: server-verified resume reaches the screen", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(null);
    i18n.changeLanguage("ru");
  });

  it("a PARTIAL server overrides the stale persisted 'deploying' snapshot → the rendered screen is recovery (server-verified, NOT a silent auto-complete — D-01)", async () => {
    // App restart MID-INSTALL: a snapshot persisted at "deploying" with a config
    // marker — a naive counter-based restore would paint the deploy screen. The mount
    // probe must instead consult server reality and resolve from it.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ step: "deploying", host: "10.0.0.1", port: "22", sshUser: "root" }),
    );
    localStorage.setItem("tt_config_path", "C:/cfg/trusttunnel_client.toml");

    mockInvoke.mockImplementation(async (cmd: string) => {
      // The session has no in-memory password, so the resume reads the host-keyed
      // bundle (06-19); it must MATCH the resume target so the probe proceeds (finding F).
      if (cmd === "load_ssh_credentials_for") {
        return { host: "10.0.0.1", port: "22", user: "root", password: "pw", keyPath: "" };
      }
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

    render(<SetupWizard onSetupComplete={vi.fn()} />);

    // The probe-driven override actually reaches the SCREEN: the recovery fork title
    // renders, NOT the stale "deploying" snapshot. A partial server resolves to the
    // EXPLICIT recovery fork — never a silent auto-complete or auto-deploy (D-01).
    await waitFor(() => {
      expect(screen.getByText(i18n.t("wizard.recovery.title"))).toBeInTheDocument();
    });
    // The probe actually ran against server reality.
    expect(mockInvoke).toHaveBeenCalledWith(
      "check_server_installation",
      expect.objectContaining({ host: "10.0.0.1" }),
    );
  });

  it("a fully-installed+enabled+active+export-present server → the rendered screen is done", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ step: "server", host: "10.0.0.1", port: "22", sshUser: "root" }),
    );
    localStorage.setItem("tt_config_path", "C:/cfg/trusttunnel_client.toml");

    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_ssh_credentials_for") {
        return { host: "10.0.0.1", port: "22", user: "root", password: "pw", keyPath: "" };
      }
      if (cmd === "check_server_installation") {
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
          users: [],
        };
      }
      // The REAL local-export check succeeds (the file exists and is readable).
      if (cmd === "read_client_config") return { vpn_mode: "general" };
      return null;
    });

    render(<SetupWizard onSetupComplete={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(i18n.t("wizard.done.title"))).toBeInTheDocument();
    });
  });
});
