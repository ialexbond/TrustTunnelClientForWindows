import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
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
});
