import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders SSH connect form when no creds in localStorage", () => {
    render(<ControlPanelPage {...defaultProps} />);
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
    expect(screen.queryByTestId("server-panel")).not.toBeInTheDocument();
  });

  it("renders ServerPanel when SSH creds exist in localStorage", () => {
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({
        host: "10.0.0.1",
        port: "22",
        user: "root",
        password: "secret",
      })
    );
    render(<ControlPanelPage {...defaultProps} />);
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("ssh-connect-form")).not.toBeInTheDocument();
  });

  it("shows disconnect button when connected", () => {
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({
        host: "10.0.0.1",
        port: "22",
        user: "root",
        password: "secret",
      })
    );
    render(<ControlPanelPage {...defaultProps} />);
    const btn = screen.getByRole("button", { name: /Сменить сервер/i });
    expect(btn).toBeInTheDocument();
  });

  it("disconnect button clears creds and shows SSH form", () => {
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({
        host: "10.0.0.1",
        port: "22",
        user: "root",
        password: "secret",
      })
    );
    render(<ControlPanelPage {...defaultProps} />);

    const btn = screen.getByRole("button", { name: /Сменить сервер/i });
    fireEvent.click(btn);

    expect(localStorage.getItem("trusttunnel_control_ssh")).toBeNull();
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });

  it("connecting via SshConnectForm shows ServerPanel", () => {
    render(<ControlPanelPage {...defaultProps} />);
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("mock-connect-btn"));

    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
    expect(screen.getByText(/host=1\.2\.3\.4/)).toBeInTheDocument();
  });

  // ── b64 deobfuscation of stored creds ──

  it("deobfuscates b64-prefixed password from localStorage", () => {
    // "pass123" in base64 = "cGFzczEyMw=="
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({
        host: "10.0.0.1",
        port: "22",
        user: "root",
        password: "b64:cGFzczEyMw==",
      })
    );
    render(<ControlPanelPage {...defaultProps} />);
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
  });

  it("handles invalid b64 password gracefully (returns raw value)", () => {
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({
        host: "10.0.0.1",
        port: "22",
        user: "root",
        password: "b64:!!!invalid!!!",
      })
    );
    // Should not crash — deobfuscate returns raw value on decode failure
    render(<ControlPanelPage {...defaultProps} />);
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
  });

  it("returns null for invalid JSON in localStorage", () => {
    localStorage.setItem("trusttunnel_control_ssh", "not-json");
    render(<ControlPanelPage {...defaultProps} />);
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });

  it("returns null for creds missing host", () => {
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({ port: "22", user: "root" })
    );
    render(<ControlPanelPage {...defaultProps} />);
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });

  it("returns null for creds missing both password and keyPath", () => {
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({ host: "10.0.0.1", port: "22", user: "root" })
    );
    render(<ControlPanelPage {...defaultProps} />);
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });

  it("reads creds with keyPath instead of password", () => {
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({ host: "10.0.0.1", keyPath: "/home/.ssh/id_rsa" })
    );
    render(<ControlPanelPage {...defaultProps} />);
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
  });

  it("uses default port and user when not specified", () => {
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({ host: "10.0.0.1", password: "secret" })
    );
    render(<ControlPanelPage {...defaultProps} />);
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
  });

  // ── Disconnect clears refresh signal too ──

  it("disconnect also clears trusttunnel_control_refresh", () => {
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({ host: "10.0.0.1", password: "secret" })
    );
    localStorage.setItem("trusttunnel_control_refresh", "12345");
    render(<ControlPanelPage {...defaultProps} />);

    fireEvent.click(screen.getByRole("button", { name: /Сменить сервер/i }));

    expect(localStorage.getItem("trusttunnel_control_ssh")).toBeNull();
    expect(localStorage.getItem("trusttunnel_control_refresh")).toBeNull();
  });

  // ── Refresh signal polling ──

  it("picks up new creds when trusttunnel_control_refresh changes", () => {
    render(<ControlPanelPage {...defaultProps} />);
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();

    // Simulate wizard storing creds and setting refresh signal
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({ host: "5.5.5.5", password: "newpass" })
    );
    localStorage.setItem("trusttunnel_control_refresh", Date.now().toString());

    // Advance timer to trigger the polling interval
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByTestId("server-panel")).toBeInTheDocument();
  });

  it("shows SSH form when creds removed via refresh signal", () => {
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({ host: "10.0.0.1", password: "secret" })
    );
    render(<ControlPanelPage {...defaultProps} />);
    expect(screen.getByTestId("server-panel")).toBeInTheDocument();

    // Simulate creds removal + refresh signal
    localStorage.removeItem("trusttunnel_control_ssh");
    localStorage.setItem("trusttunnel_control_refresh", Date.now().toString());

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });

  // ── Config export callback triggers onNavigateToSettings ──

  it("onConfigExported and onNavigateToSettings called on export", () => {
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({ host: "10.0.0.1", password: "secret" })
    );
    render(<ControlPanelPage {...defaultProps} />);

    fireEvent.click(screen.getByTestId("mock-export-btn"));

    expect(defaultProps.onConfigExported).toHaveBeenCalledWith("/exported/config.toml");
    expect(defaultProps.onNavigateToSettings).toHaveBeenCalled();
  });

  it("onConfigExported works without onNavigateToSettings prop", () => {
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({ host: "10.0.0.1", password: "secret" })
    );
    const props = { onConfigExported: vi.fn(), onSwitchToSetup: vi.fn() };
    render(<ControlPanelPage {...props} />);

    fireEvent.click(screen.getByTestId("mock-export-btn"));

    expect(props.onConfigExported).toHaveBeenCalledWith("/exported/config.toml");
  });

  // ── ServerPanel disconnect callback ──

  it("disconnect via ServerPanel callback clears creds", () => {
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({ host: "10.0.0.1", password: "secret" })
    );
    render(<ControlPanelPage {...defaultProps} />);

    fireEvent.click(screen.getByTestId("mock-disconnect-btn"));

    expect(localStorage.getItem("trusttunnel_control_ssh")).toBeNull();
    expect(screen.getByTestId("ssh-connect-form")).toBeInTheDocument();
  });
});
