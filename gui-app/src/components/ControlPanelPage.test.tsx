import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../shared/i18n";
import { ControlPanelPage } from "./ControlPanelPage";

// Mock child components to isolate ControlPanelPage logic
vi.mock("./ServerPanel", () => ({
  ServerPanel: (props: any) => (
    <div data-testid="server-panel">
      ServerPanel host={props.host}
      <button data-testid="mock-export-btn" onClick={() => props.onConfigExported("/exported/config.toml")}>Export</button>
      <button data-testid="mock-disconnect-btn" onClick={props.onDisconnect}>Disconnect</button>
    </div>
  ),
}));

vi.mock("./server/SshConnectForm", () => ({
  SshConnectForm: ({ onConnect }: any) => (
    <div data-testid="ssh-connect-form">
      <button
        data-testid="mock-connect-btn"
        onClick={() =>
          onConnect({
            host: "1.2.3.4",
            port: "22",
            user: "root",
            password: "pass",
          })
        }
      >
        Connect
      </button>
    </div>
  ),
}));

const mockInvoke = vi.mocked(invoke);

/** Helper: configure invoke mock to return given creds from load_ssh_credentials */
function mockCredsLoaded(creds: { host: string; port?: string; user?: string; password?: string; keyPath?: string } | null) {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "load_ssh_credentials") {
      if (!creds) return null;
      return {
        host: creds.host,
        port: creds.port || "22",
        user: creds.user || "root",
        password: creds.password || "",
        keyPath: creds.keyPath || "",
      } as any;
    }
    if (cmd === "clear_ssh_credentials") return null as any;
    if (cmd === "save_ssh_credentials") return null as any;
    return null as any;
  });
}

describe("ControlPanelPage", () => {
  const defaultProps = {
    onConfigExported: vi.fn(),
    onSwitchToSetup: vi.fn(),
    onNavigateToSettings: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    localStorage.clear();
    vi.useFakeTimers();
    // Default: no creds
    mockCredsLoaded(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders SSH connect form when no creds", async () => {
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
    expect(screen.queryByTestId("server-panel")).not.toBeInTheDocument();
  });

  it("renders ServerPanel when SSH creds exist", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      port: "22",
      user: "root",
      password: "secret",
    });
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("ssh-connect-form")).not.toBeInTheDocument();
  });

  it("shows disconnect button when connected", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      port: "22",
      user: "root",
      password: "secret",
    });
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });
    const btn = screen.getByRole("button", { name: /Сменить сервер/i });
    expect(btn).toBeInTheDocument();
  });

  it("disconnect button clears creds and shows SSH form", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      port: "22",
      user: "root",
      password: "secret",
    });
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });

    const btn = screen.getByRole("button", { name: /Сменить сервер/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockInvoke).toHaveBeenCalledWith("clear_ssh_credentials");
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });

  it("connecting via SshConnectForm shows ServerPanel", async () => {
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-connect-btn"));
    });

    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
    expect(screen.getByText(/host=1\.2\.3\.4/)).toBeInTheDocument();
  });

  // ── b64 deobfuscation of stored creds ──

  it("deobfuscates b64-prefixed password from backend", async () => {
    // "pass123" in base64 = "cGFzczEyMw=="
    mockCredsLoaded({
      host: "10.0.0.1",
      port: "22",
      user: "root",
      password: "b64:cGFzczEyMw==",
    });
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
  });

  it("handles invalid b64 password gracefully (returns raw value)", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      port: "22",
      user: "root",
      password: "b64:!!!invalid!!!",
    });
    // Should not crash — deobfuscate returns raw value on decode failure
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
  });

  it("returns null when load_ssh_credentials throws", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_ssh_credentials") throw new Error("backend error");
      return null as any;
    });
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });

  it("returns null for creds missing host", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_ssh_credentials") return { host: "", port: "22", user: "root", password: "pass", keyPath: "" } as any;
      return null as any;
    });
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });

  it("returns null for creds missing both password and keyPath", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_ssh_credentials") return { host: "10.0.0.1", port: "22", user: "root", password: "", keyPath: "" } as any;
      return null as any;
    });
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });

  it("reads creds with keyPath instead of password", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      keyPath: "/home/.ssh/id_rsa",
    });
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
  });

  it("uses default port and user when not specified", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      password: "secret",
    });
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
  });

  // ── Disconnect clears refresh signal too ──

  it("disconnect also clears trusttunnel_control_refresh", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      password: "secret",
    });
    localStorage.setItem("trusttunnel_control_refresh", "12345");
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Сменить сервер/i }));
    });

    expect(mockInvoke).toHaveBeenCalledWith("clear_ssh_credentials");
    expect(localStorage.getItem("trusttunnel_control_refresh")).toBeNull();
  });

  // ── Refresh signal polling ──

  it("picks up new creds when trusttunnel_control_refresh changes", async () => {
    vi.useRealTimers();
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();

    // Now mock that creds are available and set refresh signal
    mockCredsLoaded({ host: "5.5.5.5", password: "newpass" });
    localStorage.setItem("trusttunnel_control_refresh", Date.now().toString());

    // Wait for the polling interval to pick up the new creds
    await waitFor(() => {
      expect(screen.getByTestId("server-panel")).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it("shows SSH form when creds removed via refresh signal", async () => {
    vi.useRealTimers();
    mockCredsLoaded({
      host: "10.0.0.1",
      password: "secret",
    });
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();

    // Simulate creds removal + refresh signal
    mockCredsLoaded(null);
    localStorage.setItem("trusttunnel_control_refresh", Date.now().toString());

    await waitFor(() => {
      expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  // ── Config export callback triggers onNavigateToSettings ──

  it("onConfigExported and onNavigateToSettings called on export", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      password: "secret",
    });
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });

    fireEvent.click(screen.getByTestId("mock-export-btn"));

    expect(defaultProps.onConfigExported).toHaveBeenCalledWith("/exported/config.toml");
    expect(defaultProps.onNavigateToSettings).toHaveBeenCalled();
  });

  it("onConfigExported works without onNavigateToSettings prop", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      password: "secret",
    });
    const props = { onConfigExported: vi.fn(), onSwitchToSetup: vi.fn() };
    await act(async () => {
      render(<ControlPanelPage {...props} />);
    });

    fireEvent.click(screen.getByTestId("mock-export-btn"));

    expect(props.onConfigExported).toHaveBeenCalledWith("/exported/config.toml");
  });

  // ── ServerPanel disconnect callback ──

  it("disconnect via ServerPanel callback clears creds", async () => {
    mockCredsLoaded({
      host: "10.0.0.1",
      password: "secret",
    });
    await act(async () => {
      render(<ControlPanelPage {...defaultProps} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mock-disconnect-btn"));
    });

    expect(mockInvoke).toHaveBeenCalledWith("clear_ssh_credentials");
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });
});
