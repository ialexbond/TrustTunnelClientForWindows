import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "../shared/i18n";
import DashboardPanel from "./DashboardPanel";

// Mock recharts
vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  LineChart: ({ children }: any) => <div>{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
}));

// Mock dashboard sub-components to isolate DashboardPanel
vi.mock("./dashboard/PingChart", () => ({
  PingChart: () => <div data-testid="ping-chart">PingChart</div>,
}));

vi.mock("./dashboard/SpeedTestCard", () => ({
  SpeedTestCard: () => <div data-testid="speed-test-card">SpeedTestCard</div>,
}));

vi.mock("./dashboard/SessionStats", () => ({
  SessionStats: () => <div data-testid="session-stats">SessionStats</div>,
}));

vi.mock("./dashboard/NetworkInfo", () => ({
  NetworkInfo: () => <div data-testid="network-info">NetworkInfo</div>,
}));

vi.mock("./dashboard/ServerStatsCard", () => ({
  ServerStatsCard: () => <div data-testid="server-stats-card">ServerStatsCard</div>,
}));

vi.mock("./dashboard/useDashboardState", () => ({
  useDashboardState: () => ({
    pingHistory: [],
    currentPing: null,
    avgPing: null,
    speed: null,
    speedTesting: false,
    speedError: null,
    runSpeedTest: vi.fn(),
    recoveryCount: 0,
    errorCount: 0,
    clientConfig: null,
  }),
}));

vi.mock("./StatusPanel", () => ({
  __esModule: true,
  default: () => <div data-testid="status-panel">StatusPanel</div>,
}));

describe("DashboardPanel", () => {
  const defaultProps = {
    status: "disconnected" as const,
    connectedSince: null,
    configPath: "",
    vpnMode: "general",
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onNavigateToControl: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    localStorage.clear();
  });

  it("renders without crashing in disconnected state", () => {
    render(<DashboardPanel {...defaultProps} />);
    // Should show the dashboard title
    expect(screen.getByText(/Дашборд|Dashboard/i)).toBeInTheDocument();
  });

  it("shows config required message when no configPath", () => {
    render(<DashboardPanel {...defaultProps} />);
    // When no configPath, shows "Сначала укажите файл конфигурации или настройте сервер"
    expect(
      screen.getByText(/укажите файл конфигурации/)
    ).toBeInTheDocument();
  });

  it("shows connect button when disconnected with configPath", () => {
    render(<DashboardPanel {...defaultProps} configPath="/some/config.json" />);
    expect(screen.getByRole("button", { name: /Подключить|connect/i })).toBeInTheDocument();
  });

  it("renders server section placeholder when no SSH creds", () => {
    render(<DashboardPanel {...defaultProps} />);
    // There are two cards — dashboard and server. Check the server title specifically.
    const serverTitle = screen.getByText("Сервер");
    expect(serverTitle).toBeInTheDocument();
  });

  it("renders ServerStatsCard when SSH creds exist", () => {
    localStorage.setItem(
      "trusttunnel_control_ssh",
      JSON.stringify({
        host: "10.0.0.1",
        port: "22",
        user: "root",
        password: "secret",
      })
    );
    render(<DashboardPanel {...defaultProps} />);
    expect(screen.getByTestId("server-stats-card")).toBeInTheDocument();
  });

  it("renders full dashboard sections when connected", () => {
    render(
      <DashboardPanel
        {...defaultProps}
        status="connected"
        connectedSince={new Date()}
        configPath="/some/config.json"
      />
    );
    expect(screen.getByTestId("status-panel")).toBeInTheDocument();
    expect(screen.getByTestId("ping-chart")).toBeInTheDocument();
    expect(screen.getByTestId("speed-test-card")).toBeInTheDocument();
    expect(screen.getByTestId("session-stats")).toBeInTheDocument();
    expect(screen.getByTestId("network-info")).toBeInTheDocument();
    expect(screen.getByTestId("server-stats-card")).toBeInTheDocument();
  });

  it("handles connecting state", () => {
    render(
      <DashboardPanel
        {...defaultProps}
        status="connecting"
        configPath="/some/config.json"
      />
    );
    // connecting state shows the connecting label on button
    expect(screen.getByText(/Подключение/)).toBeInTheDocument();
  });
});
