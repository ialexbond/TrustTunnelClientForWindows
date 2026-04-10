import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { VersionSection } from "./VersionSection";
import { renderWithProviders as render } from "../../test/test-utils";
import type { ServerState } from "./useServerState";

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    serverInfo: { installed: true, version: "1.4.0", serviceActive: true, users: ["alice"] },
    availableVersions: ["v1.5.0", "v1.4.0", "v1.3.0"],
    selectedVersion: "v1.5.0",
    setSelectedVersion: vi.fn(),
    actionLoading: null,
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    runAction: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

describe("VersionSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders nothing when serverInfo is null", () => {
    const state = makeState({ serverInfo: null });
    const { container } = render(<VersionSection state={state} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders version title", () => {
    const state = makeState();
    render(<VersionSection state={state} />);
    expect(screen.getByText(i18n.t("server.version.title"))).toBeInTheDocument();
  });

  it("displays current version badge", () => {
    const state = makeState();
    render(<VersionSection state={state} />);
    expect(screen.getByText("v1.4.0")).toBeInTheDocument();
  });

  it("shows current version label", () => {
    const state = makeState();
    render(<VersionSection state={state} />);
    expect(screen.getByText(new RegExp(i18n.t("server.version.current")))).toBeInTheDocument();
  });

  it("shows version dropdown when versions are available", () => {
    const state = makeState();
    render(<VersionSection state={state} />);
    // The dropdown trigger should show the selected version
    const trigger = screen.getByText("v1.5.0");
    expect(trigger).toBeInTheDocument();
  });

  it("opens dropdown and shows available versions on click", () => {
    const state = makeState();
    render(<VersionSection state={state} />);
    // Find and click the dropdown trigger button
    const trigger = document.querySelector("button[style*='height: 34px']");
    expect(trigger).toBeInTheDocument();
    fireEvent.click(trigger!);
    // Versions should appear in dropdown
    expect(screen.getByText(new RegExp("v1\\.3\\.0"))).toBeInTheDocument();
  });

  it("shows install button when a non-current version is selected", () => {
    const state = makeState({ selectedVersion: "v1.5.0" });
    render(<VersionSection state={state} />);
    const installBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.version.install_version")) });
    expect(installBtn).toBeInTheDocument();
  });

  it("does not show install button when selected version matches current", () => {
    const state = makeState({ selectedVersion: "v1.4.0" });
    render(<VersionSection state={state} />);
    expect(screen.queryByRole("button", { name: new RegExp(i18n.t("server.version.install_version")) })).not.toBeInTheDocument();
  });

  it("does not show dropdown when no versions are available", () => {
    const state = makeState({ availableVersions: [] });
    render(<VersionSection state={state} />);
    expect(document.querySelector("button[style*='height: 34px']")).not.toBeInTheDocument();
  });
});
