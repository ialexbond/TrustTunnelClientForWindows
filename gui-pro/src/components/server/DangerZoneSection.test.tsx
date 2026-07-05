import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { DangerZoneSection } from "./DangerZoneSection";
import { renderWithProviders as render } from "../../test/test-utils";
import type { ServerState } from "./useServerState";

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    uninstallLoading: false,
    setUninstallLoading: vi.fn(),
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    onSwitchToSetup: vi.fn(),
    onClearConfig: vi.fn(),
    setActionResult: vi.fn(),
    setServerInfo: vi.fn(),
    host: "10.0.0.1",
    serverInfo: null,
    actionLoading: null,
    runAction: vi.fn(async (_name: string, fn: () => Promise<unknown>) => { await fn(); }),
    pushSuccess: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

describe("DangerZoneSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders danger zone title", () => {
    const state = makeState();
    render(<DangerZoneSection state={state} />);
    expect(screen.getByText(i18n.t("server.danger.title"))).toBeInTheDocument();
  });

  it("does NOT show reinstall button (removed per UAT 2026-05-19)", () => {
    const state = makeState();
    render(<DangerZoneSection state={state} />);
    expect(screen.queryByTestId("danger-zone-reinstall-button")).not.toBeInTheDocument();
  });

  it("shows uninstall button", () => {
    const state = makeState();
    render(<DangerZoneSection state={state} />);
    expect(
      screen.getByRole("button", { name: new RegExp(i18n.t("server.danger.uninstall")) }),
    ).toBeInTheDocument();
  });

  it("clicking uninstall opens confirm dialog (via ConfirmDialogProvider)", async () => {
    const state = makeState();
    render(<DangerZoneSection state={state} />);
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(i18n.t("server.danger.uninstall")) }),
    );
    // Dialog is rendered by ConfirmDialogProvider (from renderWithProviders wrapper)
    expect(
      await screen.findByText(i18n.t("server.danger.confirm_uninstall_title")),
    ).toBeInTheDocument();
    expect(
      screen.getByText(i18n.t("server.danger.confirm_uninstall_message")),
    ).toBeInTheDocument();
  });

  it("INSTALL-LOCK (16-12): confirming delete shows a loader on the confirm button while the uninstall runs, then invokes uninstall_server", async () => {
    // Gate the uninstall invoke on a manual resolve so we can observe the
    // in-flight loading state on the CONFIRM button (the destructive op runs
    // through the confirm dialog's `action` hook — the modal stays open with a
    // spinner and can't be interrupted mid-flight).
    let resolveUninstall: (() => void) | undefined;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "uninstall_server") {
        return new Promise<void>((res) => {
          resolveUninstall = () => res();
        });
      }
      return Promise.resolve(undefined);
    });
    const state = makeState();
    render(<DangerZoneSection state={state} />);
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(i18n.t("server.danger.uninstall")) }),
    );
    // Click the danger confirm button in the dialog.
    const confirmBtn = await screen.findByRole("button", {
      name: new RegExp(i18n.t("server.danger.confirm_delete_btn")),
    });
    fireEvent.click(confirmBtn);

    // While the uninstall is pending: the confirm button is disabled (loading) and
    // the invoke was fired.
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("uninstall_server", state.sshParams);
    });
    const dialogConfirm = screen.getByRole("button", {
      name: new RegExp(i18n.t("server.danger.confirm_delete_btn")),
    });
    expect(dialogConfirm).toBeDisabled();

    // Complete the uninstall → dialog resolves, serverInfo cleared.
    resolveUninstall?.();
    await waitFor(() => {
      expect(state.setServerInfo).toHaveBeenCalledWith({
        installed: false,
        version: "",
        serviceActive: false,
        users: [],
      });
    });
  });

  // ── Phase 17 Plan 06: Stop/Start conditional toggle (D-3.3) ──

  it("renders_stop_button_when_service_active — Stop visible, Start absent", () => {
    const state = makeState({
      serverInfo: { installed: true, version: "1.0", serviceActive: true, users: [] } as ServerState["serverInfo"],
    });
    render(<DangerZoneSection state={state} />);
    expect(screen.getByTestId("danger-zone-stop-button")).toBeInTheDocument();
    expect(screen.queryByTestId("danger-zone-start-button")).not.toBeInTheDocument();
  });

  it("renders_start_button_when_service_inactive — Start visible, Stop absent", () => {
    const state = makeState({
      serverInfo: { installed: true, version: "1.0", serviceActive: false, users: [] } as ServerState["serverInfo"],
    });
    render(<DangerZoneSection state={state} />);
    expect(screen.getByTestId("danger-zone-start-button")).toBeInTheDocument();
    expect(screen.queryByTestId("danger-zone-stop-button")).not.toBeInTheDocument();
  });

  it("stop_click_confirms_with_danger_variant_then_invokes server_stop_service", async () => {
    const runAction = vi.fn(async (_name: string, fn: () => Promise<unknown>) => { await fn(); });
    const state = makeState({
      serverInfo: { installed: true, version: "1.0", serviceActive: true, users: [] } as ServerState["serverInfo"],
      runAction: runAction as unknown as ServerState["runAction"],
    });
    vi.mocked(invoke).mockResolvedValue(undefined);
    render(<DangerZoneSection state={state} />);
    fireEvent.click(screen.getByTestId("danger-zone-stop-button"));
    // ConfirmDialog appears from renderWithProviders (ConfirmDialogProvider).
    // CTA-01 (09-24): the confirm button now reads the action verb «Остановить»,
    // not the generic «Подтвердить».
    // Exact name match: the Stop *trigger* button reads «Остановить сервис»,
    // while the confirm button is just «Остановить» — a regex would match both.
    const confirmBtn = await screen.findByRole("button", {
      name: i18n.t("server.danger.stop_confirm_btn"),
    });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_stop_service", expect.any(Object));
    });
    // runAction called with "stop" action name
    expect(runAction).toHaveBeenCalledWith("stop", expect.any(Function), expect.any(String));
  });

  // CTA-01 (09-24): the Stop-service confirm button names the action it triggers.
  it("CTA-01: stop confirm button renders «Остановить» (not the generic «Подтвердить»)", async () => {
    const state = makeState({
      serverInfo: { installed: true, version: "1.0", serviceActive: true, users: [] } as ServerState["serverInfo"],
    });
    render(<DangerZoneSection state={state} />);
    fireEvent.click(screen.getByTestId("danger-zone-stop-button"));
    const confirmBtn = await screen.findByRole("button", {
      name: i18n.t("server.danger.stop_confirm_btn"),
    });
    expect(confirmBtn).toHaveTextContent("Остановить");
    // The generic «Подтвердить» label must NOT be the confirm action here.
    expect(
      screen.queryByRole("button", { name: i18n.t("buttons.confirm") }),
    ).not.toBeInTheDocument();
  });

  it("start_click_no_confirm_invokes_directly server_start_service", async () => {
    const runAction = vi.fn(async (_name: string, fn: () => Promise<unknown>) => { await fn(); });
    const state = makeState({
      serverInfo: { installed: true, version: "1.0", serviceActive: false, users: [] } as ServerState["serverInfo"],
      runAction: runAction as unknown as ServerState["runAction"],
    });
    vi.mocked(invoke).mockResolvedValue(undefined);
    render(<DangerZoneSection state={state} />);
    fireEvent.click(screen.getByTestId("danger-zone-start-button"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_start_service", expect.any(Object));
    });
    // runAction called with "start" — no confirm dialog opened (ConfirmDialog title absent)
    expect(runAction).toHaveBeenCalledWith("start", expect.any(Function), expect.any(String));
    expect(screen.queryByText(i18n.t("server.danger.stop_title"))).not.toBeInTheDocument();
  });

  it("uninstall_button_renders_in_both_states (Reinstall removed per UAT 2026-05-19)", () => {
    // When service is active
    const stateActive = makeState({
      serverInfo: { installed: true, version: "1.0", serviceActive: true, users: [] } as ServerState["serverInfo"],
    });
    const { unmount } = render(<DangerZoneSection state={stateActive} />);
    expect(screen.queryByTestId("danger-zone-reinstall-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("danger-zone-uninstall-button")).toBeInTheDocument();
    unmount();

    // When service is inactive
    const stateInactive = makeState({
      serverInfo: { installed: true, version: "1.0", serviceActive: false, users: [] } as ServerState["serverInfo"],
    });
    render(<DangerZoneSection state={stateInactive} />);
    expect(screen.queryByTestId("danger-zone-reinstall-button")).not.toBeInTheDocument();
    expect(screen.getByTestId("danger-zone-uninstall-button")).toBeInTheDocument();
  });
});
