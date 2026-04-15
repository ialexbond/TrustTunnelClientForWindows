import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { ServiceSection } from "./ServiceSection";
import type { ServerState } from "./useServerState";

// Mock sub-components
vi.mock("./SecuritySection", () => ({
  SecuritySection: () => <div data-testid="security-section" />,
}));

vi.mock("./LogsSection", () => ({
  LogsSection: () => <div data-testid="logs-section" />,
}));

vi.mock("./DangerZoneSection", () => ({
  DangerZoneSection: () => <div data-testid="danger-zone-section" />,
}));

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    serverInfo: {
      installed: true,
      version: "1.4.0",
      serviceActive: true,
      users: ["alice"],
    },
    actionLoading: null,
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    runAction: vi.fn(),
    pushSuccess: vi.fn(),
    setActionResult: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

describe("ServiceSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it("renders service controls title", () => {
    const state = makeState();
    render(<ServiceSection state={state} />);
    expect(screen.getByText(i18n.t("server.service.controls_title"))).toBeInTheDocument();
  });

  it("renders restart button", () => {
    const state = makeState();
    render(<ServiceSection state={state} />);
    expect(
      screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.restart")) })
    ).toBeInTheDocument();
  });

  it("renders stop button when service is active", () => {
    const state = makeState();
    render(<ServiceSection state={state} />);
    expect(
      screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.stop")) })
    ).toBeVisible();
  });

  it("renders start button when service is stopped", () => {
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.4.0",
        serviceActive: false,
        users: ["alice"],
      },
    });
    render(<ServiceSection state={state} />);
    expect(
      screen.getByRole("button", { name: new RegExp(i18n.t("server.actions.start")) })
    ).toBeInTheDocument();
  });

  it("does not render start button when service is active", () => {
    const state = makeState();
    render(<ServiceSection state={state} />);
    expect(
      screen.queryByRole("button", { name: new RegExp(i18n.t("server.actions.start")) })
    ).not.toBeInTheDocument();
  });

  it("renders DangerZone in Accordion (collapsed by default)", () => {
    const state = makeState();
    render(<ServiceSection state={state} />);
    // Accordion trigger with danger title should be visible
    expect(screen.getByText(i18n.t("server.danger.title"))).toBeInTheDocument();
    // DangerZoneSection inside accordion — not visible when collapsed
    const dangerZone = screen.queryByTestId("danger-zone-section");
    if (dangerZone) {
      expect(dangerZone).not.toBeVisible();
    }
  });

  it("renders diagnostics section (SecuritySection)", () => {
    const state = makeState();
    render(<ServiceSection state={state} />);
    expect(screen.getByTestId("security-section")).toBeInTheDocument();
  });

  it("has aria-live region for screen readers", () => {
    const state = makeState();
    const { container } = render(<ServiceSection state={state} />);
    const liveRegion = container.querySelector("[aria-live='polite']");
    expect(liveRegion).toBeInTheDocument();
  });

  it("clicking stop button opens confirm dialog", () => {
    const state = makeState();
    render(<ServiceSection state={state} />);
    const stopBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("server.actions.stop")),
    });
    fireEvent.click(stopBtn);
    // ConfirmDialog should appear with stop_title
    expect(screen.getByText(i18n.t("server.danger.stop_title"))).toBeInTheDocument();
  });

  it("clicking restart button calls runAction", () => {
    const state = makeState();
    render(<ServiceSection state={state} />);
    const restartBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("server.actions.restart")),
    });
    fireEvent.click(restartBtn);
    expect(state.runAction).toHaveBeenCalledWith(
      "restart",
      expect.any(Function),
      expect.any(String)
    );
  });

  it("renders LogsSection", () => {
    const state = makeState();
    render(<ServiceSection state={state} />);
    expect(screen.getByTestId("logs-section")).toBeInTheDocument();
  });
});
