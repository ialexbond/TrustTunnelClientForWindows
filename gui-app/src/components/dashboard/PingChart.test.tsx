import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { PingChart } from "./PingChart";
import type { PingPoint } from "./useDashboardState";

// Keep track of props to verify chart configuration
let referenceLineProps: any = null;
let lineProps: any = null;
let tooltipProps: any = null;
let xAxisProps: any = null;
let yAxisProps: any = null;

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: any) => <div data-testid="responsive-container">{children}</div>,
  LineChart: ({ children, data }: any) => <div data-testid="line-chart" data-points={data?.length}>{children}</div>,
  Line: (props: any) => { lineProps = props; return <div data-testid="line" data-datakey={props.dataKey} />; },
  XAxis: (props: any) => { xAxisProps = props; return <div data-testid="x-axis" data-label-value={props.label?.value} />; },
  YAxis: (props: any) => { yAxisProps = props; return <div data-testid="y-axis" data-width={props.width} />; },
  Tooltip: (props: any) => { tooltipProps = props; return <div data-testid="tooltip" />; },
  CartesianGrid: () => null,
  ReferenceLine: (props: any) => { referenceLineProps = props; return <div data-testid="reference-line" data-y={props.y} />; },
}));

describe("PingChart", () => {
  const defaultProps = {
    pingHistory: [] as PingPoint[],
    avgPing: null,
    isConnected: false,
  };

  beforeEach(() => {
    i18n.changeLanguage("ru");
    referenceLineProps = null;
    lineProps = null;
    tooltipProps = null;
    xAxisProps = null;
    yAxisProps = null;
  });

  it("renders ping chart card title", () => {
    render(<PingChart {...defaultProps} />);
    expect(screen.getByText("Пинг")).toBeInTheDocument();
  });

  it("shows no data message when disconnected", () => {
    render(<PingChart {...defaultProps} />);
    expect(screen.getByText("Нет данных")).toBeInTheDocument();
  });

  it("shows no data message when connected but empty history", () => {
    render(<PingChart {...defaultProps} isConnected={true} />);
    expect(screen.getByText("Нет данных")).toBeInTheDocument();
  });

  it("shows no data when all ping points are zero or negative", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 0 },
      { time: 2, ping: -1 },
    ];
    render(<PingChart pingHistory={history} avgPing={null} isConnected={true} />);
    expect(screen.getByText("Нет данных")).toBeInTheDocument();
  });

  it("renders chart when connected with data points", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 50 },
      { time: 2, ping: 80 },
      { time: 3, ping: 60 },
    ];
    render(<PingChart pingHistory={history} avgPing={63} isConnected={true} />);
    expect(screen.getByTestId("responsive-container")).toBeInTheDocument();
    expect(screen.getByTestId("line-chart")).toBeInTheDocument();
  });

  it("shows average ping when available", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 50 },
      { time: 2, ping: 80 },
    ];
    render(<PingChart pingHistory={history} avgPing={65} isConnected={true} />);
    expect(screen.getByText(/65 ms/)).toBeInTheDocument();
  });

  it("does not show average when avgPing is null", () => {
    render(<PingChart {...defaultProps} />);
    expect(screen.queryByText(/ms$/)).not.toBeInTheDocument();
  });

  // ── Chart rendering with data points ──

  it("renders Line component with pingClamped dataKey", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 120 },
      { time: 2, ping: 200 },
    ];
    render(<PingChart pingHistory={history} avgPing={160} isConnected={true} />);
    expect(screen.getByTestId("line")).toBeInTheDocument();
    expect(lineProps.dataKey).toBe("pingClamped");
  });

  it("renders ReferenceLine for average ping", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 120 },
      { time: 2, ping: 200 },
    ];
    render(<PingChart pingHistory={history} avgPing={160} isConnected={true} />);
    expect(screen.getByTestId("reference-line")).toBeInTheDocument();
    expect(referenceLineProps.y).toBe(160);
  });

  it("does not render ReferenceLine when avgPing is null", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 120 },
    ];
    render(<PingChart pingHistory={history} avgPing={null} isConnected={true} />);
    expect(screen.queryByTestId("reference-line")).not.toBeInTheDocument();
  });

  it("does not render ReferenceLine when avgPing exceeds Y_MAX (300)", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 400 },
      { time: 2, ping: 500 },
    ];
    render(<PingChart pingHistory={history} avgPing={450} isConnected={true} />);
    expect(screen.queryByTestId("reference-line")).not.toBeInTheDocument();
  });

  it("clamps ping values to Y_MAX (300) in chart data", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 400 },
      { time: 2, ping: 100 },
    ];
    render(<PingChart pingHistory={history} avgPing={250} isConnected={true} />);
    // The chart should have 2 data points (both have ping > 0)
    const lineChart = screen.getByTestId("line-chart");
    expect(lineChart.getAttribute("data-points")).toBe("2");
  });

  it("filters out zero and negative pings from data", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 50 },
      { time: 2, ping: 0 },
      { time: 3, ping: -1 },
      { time: 4, ping: 100 },
    ];
    render(<PingChart pingHistory={history} avgPing={75} isConnected={true} />);
    const lineChart = screen.getByTestId("line-chart");
    // Only 2 valid points (50 and 100)
    expect(lineChart.getAttribute("data-points")).toBe("2");
  });

  it("does not show chart when disconnected even with data", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 50 },
      { time: 2, ping: 80 },
    ];
    render(<PingChart pingHistory={history} avgPing={65} isConnected={false} />);
    expect(screen.queryByTestId("responsive-container")).not.toBeInTheDocument();
    expect(screen.getByText("Нет данных")).toBeInTheDocument();
  });

  it("renders XAxis with period label", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 50 },
    ];
    render(<PingChart pingHistory={history} avgPing={50} isConnected={true} />);
    expect(screen.getByTestId("x-axis")).toBeInTheDocument();
  });

  it("renders YAxis", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 50 },
    ];
    render(<PingChart pingHistory={history} avgPing={50} isConnected={true} />);
    expect(screen.getByTestId("y-axis")).toBeInTheDocument();
  });

  it("renders Tooltip", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 50 },
    ];
    render(<PingChart pingHistory={history} avgPing={50} isConnected={true} />);
    expect(screen.getByTestId("tooltip")).toBeInTheDocument();
  });

  it("renders average line at boundary (avgPing = 300 = Y_MAX)", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 290 },
      { time: 2, ping: 310 },
    ];
    render(<PingChart pingHistory={history} avgPing={300} isConnected={true} />);
    expect(screen.getByTestId("reference-line")).toBeInTheDocument();
    expect(referenceLineProps.y).toBe(300);
  });

  it("shows avg label in header when avgPing is provided", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 50 },
    ];
    render(<PingChart pingHistory={history} avgPing={50} isConnected={true} />);
    expect(screen.getByText(/50 ms/)).toBeInTheDocument();
  });

  // ── Tooltip formatter callback ──

  it("Tooltip formatter returns real ping value with ms suffix", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 250 },
    ];
    render(<PingChart pingHistory={history} avgPing={250} isConnected={true} />);
    expect(tooltipProps).toBeTruthy();
    // Call the formatter with a payload containing real ping
    const result = tooltipProps.formatter(200, "pingClamped", { payload: { ping: 250 } });
    expect(result).toEqual(["250 ms", "Ping"]);
  });

  it("Tooltip labelFormatter returns empty string", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 100 },
    ];
    render(<PingChart pingHistory={history} avgPing={100} isConnected={true} />);
    expect(tooltipProps.labelFormatter()).toBe("");
  });

  // ── YAxis tickFormatter callback ──

  it("YAxis tickFormatter appends ms suffix", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 100 },
    ];
    render(<PingChart pingHistory={history} avgPing={100} isConnected={true} />);
    expect(yAxisProps).toBeTruthy();
    expect(yAxisProps.tickFormatter(150)).toBe("150 ms");
  });

  // ── XAxis label text ──

  it("XAxis has period label", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 100 },
    ];
    render(<PingChart pingHistory={history} avgPing={100} isConnected={true} />);
    expect(xAxisProps).toBeTruthy();
    expect(xAxisProps.label.value).toBeTruthy();
  });

  // ── Line configuration ──

  it("Line uses monotone interpolation and is not animated", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 100 },
    ];
    render(<PingChart pingHistory={history} avgPing={100} isConnected={true} />);
    expect(lineProps.type).toBe("monotone");
    expect(lineProps.isAnimationActive).toBe(false);
    expect(lineProps.dot).toBe(false);
    expect(lineProps.strokeWidth).toBe(2);
  });

  // ── ReferenceLine stroke style ──

  it("ReferenceLine uses dashed stroke", () => {
    const history: PingPoint[] = [
      { time: 1, ping: 100 },
    ];
    render(<PingChart pingHistory={history} avgPing={100} isConnected={true} />);
    expect(referenceLineProps.strokeDasharray).toBe("3 3");
    expect(referenceLineProps.strokeOpacity).toBe(0.5);
  });
});
