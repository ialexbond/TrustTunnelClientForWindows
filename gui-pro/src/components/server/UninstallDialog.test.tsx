import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { UninstallDialog } from "./UninstallDialog";
import { renderWithProviders as render } from "../../test/test-utils";

const SSH = { host: "10.0.0.1", port: 22, user: "root", password: "pass" };

// Labels (ru) — queried by accessible name, never by CSS. NOTE: there is no user-accounts
// row — users are part of the protocol and are always removed with it (18-UAT). The protocol
// row (fixed, disabled) is the stable "detection settled" anchor.
const L = {
  protocol: () => i18n.t("server.uninstall.components.protocol"),
  ufw: () => i18n.t("server.uninstall.components.ufw"),
  fail2ban: () => i18n.t("server.uninstall.components.fail2ban"),
  bbr: () => i18n.t("server.uninstall.components.bbr"),
  mtproto: () => i18n.t("server.uninstall.components.mtproto"),
};

interface MockOpts {
  ufw?: boolean;
  fail2ban?: boolean;
  mtproto?: boolean;
  /** 18-09: MTProto ownership marker (`managedByUs`) reported by mtproto_get_status. */
  mtprotoManagedByUs?: boolean;
  bbr?: boolean;
  snapshot?: null | Record<string, unknown>;
  // 18-10: read_server_ownership_markers response (install/enable markers). Defaults to all
  // false → marker-gated affordances stay closed unless a test opts in.
  ufwInstalledMarker?: boolean;
  fail2banInstalledMarker?: boolean;
  bbrPriorMarker?: boolean;
  bbrSnapshotRevertable?: boolean;
  onUninstall?: (args: Record<string, unknown> | undefined) => void;
}

function mockInvoke(opts: MockOpts = {}) {
  vi.mocked(invoke).mockImplementation((cmd: string, args?: unknown) => {
    switch (cmd) {
      case "security_get_status":
        return Promise.resolve({
          firewall: { installed: opts.ufw ?? false },
          fail2ban: { installed: opts.fail2ban ?? false },
        });
      case "mtproto_get_status":
        return Promise.resolve({
          installed: opts.mtproto ?? false,
          managedByUs: opts.mtprotoManagedByUs ?? false,
        });
      case "detect_bbr_status":
        return Promise.resolve(opts.bbr ?? false);
      case "read_server_snapshot":
        return Promise.resolve(opts.snapshot ?? null);
      case "read_server_ownership_markers":
        return Promise.resolve({
          ufwInstalledMarker: opts.ufwInstalledMarker ?? false,
          fail2banInstalledMarker: opts.fail2banInstalledMarker ?? false,
          bbrPriorMarker: opts.bbrPriorMarker ?? false,
          bbrSnapshotRevertable: opts.bbrSnapshotRevertable ?? false,
        });
      case "uninstall_server":
        opts.onUninstall?.(args as Record<string, unknown> | undefined);
        return Promise.resolve(undefined);
      default:
        return Promise.resolve(undefined);
    }
  });
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof UninstallDialog>> = {}) {
  const props = {
    open: true,
    sshParams: SSH,
    onClose: vi.fn(),
    onSuccess: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  render(<UninstallDialog {...props} />);
  return props;
}

describe("UninstallDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("(a) renders ONLY detected components + the fixed protocol row (D-01)", async () => {
    // ufw present, fail2ban absent, mtproto absent, bbr absent, no snapshot.
    mockInvoke({ ufw: true, fail2ban: false, mtproto: false, bbr: false, snapshot: null });
    renderDialog();

    // ufw + the always-present protocol row are shown. There is NO user-accounts checkbox
    // (users go with the protocol — 18-UAT).
    expect(await screen.findByRole("checkbox", { name: L.ufw() })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: L.protocol() })).toBeInTheDocument();
    // Undetected components are NOT rendered.
    expect(screen.queryByRole("checkbox", { name: L.fail2ban() })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: L.bbr() })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: L.mtproto() })).not.toBeInTheDocument();
  });

  it("(a2) the protocol row is fixed/disabled (always removed — cannot be unchecked)", async () => {
    mockInvoke({ ufw: true, snapshot: null });
    renderDialog();
    const proto = await screen.findByRole("checkbox", { name: L.protocol() });
    expect(proto).toHaveAttribute("aria-checked", "true");
    expect(proto).toHaveAttribute("aria-disabled", "true");
  });

  it("(d) MTProto checkbox HIDDEN when snapshot shows telemt pre-existed (D-05)", async () => {
    // mtproto detected, but snapshot proves it pre-existed → NOT ours → no checkbox.
    mockInvoke({ mtproto: true, snapshot: { mtprotoPresent: true } });
    renderDialog();
    await screen.findByRole("checkbox", { name: L.protocol() });
    expect(screen.queryByRole("checkbox", { name: L.mtproto() })).not.toBeInTheDocument();
  });

  it("(d2) MTProto checkbox HIDDEN when there is no snapshot (D-05)", async () => {
    mockInvoke({ mtproto: true, snapshot: null });
    renderDialog();
    await screen.findByRole("checkbox", { name: L.protocol() });
    expect(screen.queryByRole("checkbox", { name: L.mtproto() })).not.toBeInTheDocument();
  });

  it("(d3) MTProto checkbox HIDDEN when only the snapshot proves telemt absent — no marker (WR-8)", async () => {
    // WR-8: snapshot-absence alone is NOT ownership. Without the .tt-installed-mtproto marker the
    // backend folds nothing, so the row must stay hidden (offering it would be a silent no-op).
    mockInvoke({ mtproto: true, snapshot: { mtprotoPresent: false } });
    renderDialog();
    await screen.findByRole("checkbox", { name: L.protocol() });
    expect(screen.queryByRole("checkbox", { name: L.mtproto() })).not.toBeInTheDocument();
  });

  it("(d4) 18-09: MTProto checkbox SHOWN on a LEGACY server (no snapshot) when managedByUs=true", async () => {
    // The LEGACY hole: MTProto installed THROUGH THE APP on a server with no pre-install
    // snapshot. The ownership marker (managedByUs) proves it is ours → the row is offered.
    mockInvoke({ mtproto: true, mtprotoManagedByUs: true, snapshot: null });
    renderDialog();
    expect(await screen.findByRole("checkbox", { name: L.mtproto() })).toBeInTheDocument();
  });

  it("(d5) 18-09: MTProto checkbox HIDDEN on a legacy server when managedByUs is false/undefined (D-05)", async () => {
    // Admin's own pre-existing telemt on a legacy server: detected, but no marker and no
    // snapshot → NOT ours → never offered.
    mockInvoke({ mtproto: true, mtprotoManagedByUs: false, snapshot: null });
    renderDialog();
    await screen.findByRole("checkbox", { name: L.protocol() });
    expect(screen.queryByRole("checkbox", { name: L.mtproto() })).not.toBeInTheDocument();
  });

  it("(d6) 18-09: managedByUs=true also SHOWS the row even if the snapshot recorded telemt present (marker wins the OR)", async () => {
    // The marker is only ever written by OUR install → it authoritatively means «ours»,
    // so it wins the OR regardless of what the snapshot recorded.
    mockInvoke({ mtproto: true, mtprotoManagedByUs: true, snapshot: { mtprotoPresent: true } });
    renderDialog();
    expect(await screen.findByRole("checkbox", { name: L.mtproto() })).toBeInTheDocument();
  });

  it("(f) 18-10: BBR row SHOWN on a LEGACY server (no snapshot) when the .tt-bbr-prior marker is present", async () => {
    // BBR enabled THROUGH the app on a server with no snapshot → the marker proves it is ours.
    mockInvoke({ bbr: true, snapshot: null, bbrPriorMarker: true });
    renderDialog();
    expect(await screen.findByRole("checkbox", { name: L.bbr() })).toBeInTheDocument();
  });

  it("(f2) BBR row HIDDEN when only the snapshot proves a non-bbr algo — no marker (WR-8)", async () => {
    // WR-8: the snapshot no longer authorizes the revert; only the .tt-bbr-prior marker does.
    mockInvoke({ bbr: true, snapshot: { }, bbrSnapshotRevertable: true });
    renderDialog();
    await screen.findByRole("checkbox", { name: L.protocol() });
    expect(screen.queryByRole("checkbox", { name: L.bbr() })).not.toBeInTheDocument();
  });

  it("(f3) 18-10: BBR row HIDDEN when detected but NOT ours (admin's own BBR — no marker, no snapshot proof)", async () => {
    // An admin's pre-existing BBR on a legacy server: on now, but neither marker nor snapshot
    // proof → the row is hidden so the user can never be led to revert a BBR that is not ours.
    mockInvoke({ bbr: true, snapshot: null });
    renderDialog();
    await screen.findByRole("checkbox", { name: L.protocol() });
    expect(screen.queryByRole("checkbox", { name: L.bbr() })).not.toBeInTheDocument();
  });

  it("(e) confirm invokes uninstall_server with the assembled selection payload (no userConfigs field)", async () => {
    let captured: Record<string, unknown> | undefined;
    mockInvoke({
      ufw: true,
      fail2ban: true,
      bbr: true,
      mtproto: true,
      // WR-8: ownership is marker-only — the app-written markers make the mtproto + bbr rows ours
      // (shown + checked). The snapshot is no longer part of the ownership decision.
      mtprotoManagedByUs: true,
      bbrPriorMarker: true,
      onUninstall: (args) => { captured = args; },
    });
    renderDialog();

    // Wait for detection to settle (mtproto row appears only when ours).
    await screen.findByRole("checkbox", { name: L.mtproto() });

    fireEvent.click(screen.getByRole("button", { name: i18n.t("server.uninstall.confirm") }));

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("uninstall_server", expect.objectContaining({
        host: SSH.host,
        selection: { ufw: true, fail2ban: true, bbr: true, mtproto: true },
      }));
    });
    // 18-UAT: the payload has NO userConfigs key — users are removed with the protocol backend-side.
    expect(captured?.selection).toEqual({ ufw: true, fail2ban: true, bbr: true, mtproto: true });
  });
});
