import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "../../src/test/tauri-mock";
import { invoke } from "@tauri-apps/api/core";
import SetupWizard from "./SetupWizard";

describe("SetupWizard", () => {
  const defaultProps = {
    onSetupComplete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "auto_detect_config") return null;
      if (cmd === "check_process_conflict") return null;
      return null;
    });
  });

  it("renders landing page title", () => {
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByText("TrustTunnel VPN")).toBeInTheDocument();
  });

  it("renders setup server button", () => {
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByText("Настроить сервер")).toBeInTheDocument();
  });

  it("has fetch config option", () => {
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByText("Забрать конфиг с сервера")).toBeInTheDocument();
  });

  it("has import existing config option", () => {
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByText("У меня есть конфиг")).toBeInTheDocument();
  });

  it("shows system requirements", () => {
    render(<SetupWizard {...defaultProps} />);
    expect(screen.getByText(/Linux-сервер/)).toBeInTheDocument();
  });
});
