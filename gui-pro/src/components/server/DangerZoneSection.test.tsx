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

  it("shows reinstall button", () => {
    const state = makeState();
    render(<DangerZoneSection state={state} />);
    expect(
      screen.getByRole("button", { name: new RegExp(i18n.t("server.danger.reinstall")) }),
    ).toBeInTheDocument();
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

  it("clicking reinstall button calls onSwitchToSetup", () => {
    const state = makeState();
    render(<DangerZoneSection state={state} />);
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(i18n.t("server.danger.reinstall")) }),
    );
    expect(state.onSwitchToSetup).toHaveBeenCalled();
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
    // ConfirmDialog appears from renderWithProviders (ConfirmDialogProvider)
    const confirmBtn = await screen.findByRole("button", { name: new RegExp(i18n.t("buttons.confirm")) });
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_stop_service", expect.any(Object));
    });
    // runAction called with "stop" action name
    expect(runAction).toHaveBeenCalledWith("stop", expect.any(Function), expect.any(String));
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

  it("existing_reinstall_uninstall_still_render in both states (backwards compat)", () => {
    // When service is active
    const stateActive = makeState({
      serverInfo: { installed: true, version: "1.0", serviceActive: true, users: [] } as ServerState["serverInfo"],
    });
    const { unmount } = render(<DangerZoneSection state={stateActive} />);
    expect(screen.getByTestId("danger-zone-reinstall-button")).toBeInTheDocument();
    expect(screen.getByTestId("danger-zone-uninstall-button")).toBeInTheDocument();
    unmount();

    // When service is inactive
    const stateInactive = makeState({
      serverInfo: { installed: true, version: "1.0", serviceActive: false, users: [] } as ServerState["serverInfo"],
    });
    render(<DangerZoneSection state={stateInactive} />);
    expect(screen.getByTestId("danger-zone-reinstall-button")).toBeInTheDocument();
    expect(screen.getByTestId("danger-zone-uninstall-button")).toBeInTheDocument();
  });
});
