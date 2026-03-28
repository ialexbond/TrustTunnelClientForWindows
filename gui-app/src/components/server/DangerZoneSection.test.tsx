import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { DangerZoneSection } from "./DangerZoneSection";
import type { ServerState } from "./useServerState";

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    confirmUninstall: false,
    setConfirmUninstall: vi.fn(),
    uninstallLoading: false,
    setUninstallLoading: vi.fn(),
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    onSwitchToSetup: vi.fn(),
    onClearConfig: vi.fn(),
    setActionResult: vi.fn(),
    setServerInfo: vi.fn(),
    host: "10.0.0.1",
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
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.danger.reinstall")) })).toBeInTheDocument();
  });

  it("shows uninstall button", () => {
    const state = makeState();
    render(<DangerZoneSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.danger.uninstall")) })).toBeInTheDocument();
  });

  it("clicking uninstall button calls setConfirmUninstall(true)", () => {
    const state = makeState();
    render(<DangerZoneSection state={state} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.danger.uninstall")) }));
    expect(state.setConfirmUninstall).toHaveBeenCalledWith(true);
  });

  it("clicking reinstall button calls onSwitchToSetup", () => {
    const state = makeState();
    render(<DangerZoneSection state={state} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("server.danger.reinstall")) }));
    expect(state.onSwitchToSetup).toHaveBeenCalled();
  });

  it("shows confirmation dialog when confirmUninstall is true", () => {
    const state = makeState({ confirmUninstall: true });
    render(<DangerZoneSection state={state} />);
    expect(screen.getByText(i18n.t("server.danger.confirm_uninstall_title"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.danger.confirm_uninstall_message"))).toBeInTheDocument();
  });

  it("shows cancel and confirm buttons in the uninstall dialog", () => {
    const state = makeState({ confirmUninstall: true });
    render(<DangerZoneSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("buttons.cancel")) })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.danger.confirm_delete_btn")) })).toBeInTheDocument();
  });

  it("clicking cancel in dialog calls setConfirmUninstall(false)", () => {
    const state = makeState({ confirmUninstall: true });
    render(<DangerZoneSection state={state} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("buttons.cancel")) }));
    expect(state.setConfirmUninstall).toHaveBeenCalledWith(false);
  });
});
