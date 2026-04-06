import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { ServerStatsCard } from "./ServerStatsCard";
import { renderWithProviders as render } from "../../test/test-utils";

const mockInvoke = vi.mocked(invoke);

const sshCredsObj = {
  host: "1.2.3.4",
  port: "22",
  user: "root",
  password: "b64:dGVzdA==",
  keyPath: "",
};

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

/** Helper: configure invoke mock to handle load_ssh_credentials + server_stats */
function mockWithCreds(creds: typeof sshCredsObj | null, statsOrError?: any) {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "load_ssh_credentials") return creds as any;
    if (cmd === "server_get_stats") {
      if (statsOrError instanceof Error) throw statsOrError;
      return (statsOrError ?? mockStats) as any;
    }
    return null as any;
  });
}

describe("ServerStatsCard", () => {
  const defaultProps = {
    onNavigateToControl: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    i18n.changeLanguage("ru");
    localStorage.clear();
    sessionStorage.clear();
    // Default: no creds
    mockWithCreds(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows gate UI when no SSH credentials", async () => {
    await act(async () => {
      render(<ServerStatsCard {...defaultProps} />);
    });
    await waitFor(() => {
      expect(screen.getByText("Сервер")).toBeInTheDocument();
      expect(
        screen.getByText("Войдите в Панель управления для получения статистики сервера")
      ).toBeInTheDocument();
    });
  });

  it("shows control panel button when no credentials", async () => {
    await act(async () => {
      render(<ServerStatsCard {...defaultProps} />);
    });
    await waitFor(() => {
      expect(screen.getByText("Панель управления")).toBeInTheDocument();
    });
  });

  it("calls onNavigateToControl when control panel button clicked", async () => {
    const onNavigate = vi.fn();
    await act(async () => {
      render(<ServerStatsCard onNavigateToControl={onNavigate} />);
    });
    await waitFor(() => {
      expect(screen.getByText("Панель управления")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Панель управления"));
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("fetches and displays server stats when credentials present", async () => {
    mockWithCreds(sshCredsObj, mockStats);

    await act(async () => {
      render(<ServerStatsCard {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText("CPU")).toBeInTheDocument();
    });

    expect(screen.getByText("25.5%")).toBeInTheDocument();
    expect(screen.getByText("RAM")).toBeInTheDocument();
    expect(screen.getByText("Disk")).toBeInTheDocument();
  });

  it("shows server uptime when stats loaded", async () => {
    mockWithCreds(sshCredsObj, mockStats);

    await act(async () => {
      render(<ServerStatsCard {...defaultProps} />);
    });

    await waitFor(() => {
      expect(screen.getByText("1d 0h")).toBeInTheDocument();
    });
  });

  it("shows snackbar error on fetch failure", async () => {
    mockWithCreds(sshCredsObj, new Error("SSH connection failed"));

    await act(async () => {
      render(<ServerStatsCard {...defaultProps} />);
    });

    await waitFor(() => {
      // Error now displayed via SnackBar (fixed bottom snackbar)
      const snackbar = document.querySelector("[class*='fixed bottom']");
      expect(snackbar).toBeInTheDocument();
    });
  });

  it("displays cached stats from sessionStorage", async () => {
    mockWithCreds(sshCredsObj, mockStats);
    sessionStorage.setItem("tt_server_stats", JSON.stringify(mockStats));

    await act(async () => {
      render(<ServerStatsCard {...defaultProps} />);
    });

    await waitFor(() => {
      // Should show cached stats immediately
      expect(screen.getByText("CPU")).toBeInTheDocument();
      expect(screen.getByText("25.5%")).toBeInTheDocument();
    });
  });
});
