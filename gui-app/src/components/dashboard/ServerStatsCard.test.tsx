import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { ServerStatsCard } from "./ServerStatsCard";

const mockInvoke = vi.mocked(invoke);

describe("ServerStatsCard", () => {
  const defaultProps = {
    onNavigateToControl: vi.fn(),
  };

  const sshCreds = JSON.stringify({
    host: "1.2.3.4",
    port: "22",
    user: "root",
    password: "b64:dGVzdA==",
  });

  const mockStats = {
    cpu_percent: 25.5,
    load_1m: 0.5,
    load_5m: 0.4,
    load_15m: 0.3,
    mem_total: 4294967296,
    mem_used: 2147483648,
    disk_total: 107374182400,
    disk_used: 53687091200,
    unique_ips: 3,
    total_connections: 5,
    uptime_seconds: 86400,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    i18n.changeLanguage("ru");
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows gate UI when no SSH credentials in localStorage", () => {
    render(<ServerStatsCard {...defaultProps} />);
    expect(screen.getByText("Сервер")).toBeInTheDocument();
    expect(
      screen.getByText("Войдите в Панель управления для получения статистики сервера")
    ).toBeInTheDocument();
  });

  it("shows control panel button when no credentials", () => {
    render(<ServerStatsCard {...defaultProps} />);
    expect(screen.getByText("Панель управления")).toBeInTheDocument();
  });

  it("calls onNavigateToControl when control panel button clicked", () => {
    const onNavigate = vi.fn();
    render(<ServerStatsCard onNavigateToControl={onNavigate} />);
    fireEvent.click(screen.getByText("Панель управления"));
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("fetches and displays server stats when credentials present", async () => {
    localStorage.setItem("trusttunnel_control_ssh", sshCreds);
    mockInvoke.mockResolvedValueOnce(mockStats as any);

    render(<ServerStatsCard {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("CPU")).toBeInTheDocument();
    });

    expect(screen.getByText("25.5%")).toBeInTheDocument();
    expect(screen.getByText("RAM")).toBeInTheDocument();
    expect(screen.getByText("Disk")).toBeInTheDocument();
  });

  it("shows server uptime when stats loaded", async () => {
    localStorage.setItem("trusttunnel_control_ssh", sshCreds);
    mockInvoke.mockResolvedValueOnce(mockStats as any);

    render(<ServerStatsCard {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("1d 0h")).toBeInTheDocument();
    });
  });

  it("shows error state and retry button on fetch failure", async () => {
    localStorage.setItem("trusttunnel_control_ssh", sshCreds);
    mockInvoke.mockRejectedValueOnce(new Error("SSH connection failed"));

    render(<ServerStatsCard {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByText("Error: SSH connection failed")).toBeInTheDocument();
    });

    expect(screen.getByText("Попробовать снова")).toBeInTheDocument();
  });

  it("displays cached stats from sessionStorage", () => {
    localStorage.setItem("trusttunnel_control_ssh", sshCreds);
    sessionStorage.setItem("tt_server_stats", JSON.stringify(mockStats));
    mockInvoke.mockResolvedValue(mockStats as any);

    render(<ServerStatsCard {...defaultProps} />);

    // Should show cached stats immediately
    expect(screen.getByText("CPU")).toBeInTheDocument();
    expect(screen.getByText("25.5%")).toBeInTheDocument();
  });
});
