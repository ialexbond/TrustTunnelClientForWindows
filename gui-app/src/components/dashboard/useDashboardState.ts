import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { VpnStatus } from "../../shared/types";
import type { ClientConfig } from "../settings/useSettingsState";

export interface PingPoint {
  time: number;
  ping: number;
}

export interface SpeedResult {
  download_mbps: number;
  upload_mbps: number;
  timestamp: number;
}

export interface DashboardState {
  // Ping history (last 60 points, every 10s)
  pingHistory: PingPoint[];
  currentPing: number | null;
  avgPing: number | null;

  // Speed test
  speed: SpeedResult | null;
  speedTesting: boolean;
  speedError: string | null;
  runSpeedTest: () => void;

  // Session stats
  recoveryCount: number;
  errorCount: number;

  // Config data
  clientConfig: ClientConfig | null;
}

const MAX_PING_POINTS = 60;

export function useDashboardState(
  status: VpnStatus,
  configPath: string,
  _connectedSince: Date | null,
): DashboardState {
  const [pingHistory, setPingHistory] = useState<PingPoint[]>([]);
  const [currentPing, setCurrentPing] = useState<number | null>(null);
  const [speed, setSpeed] = useState<SpeedResult | null>(null);
  const [speedTesting, setSpeedTesting] = useState(false);
  const [speedError, setSpeedError] = useState<string | null>(null);
  const [recoveryCount, setRecoveryCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [clientConfig, setClientConfig] = useState<ClientConfig | null>(null);
  const endpointRef = useRef<{ host: string; port: number } | null>(null);
  const prevStatusRef = useRef<VpnStatus>(status);
  const isConnected = status === "connected";

  // Load config
  useEffect(() => {
    if (!configPath) return;
    invoke<ClientConfig>("read_client_config", { configPath })
      .then((cfg) => {
        setClientConfig(cfg);
        const raw = cfg?.endpoint?.hostname || "";
        const parts = raw.split(":");
        const host = parts[0] || "";
        const port = parts.length > 1 ? parseInt(parts[1], 10) : 443;
        if (host) endpointRef.current = { host, port };
      })
      .catch(() => {});
  }, [configPath, status]);

  // Track recovery/error from vpn-status events
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;

    if (status === "recovering" && prev !== "recovering") {
      setRecoveryCount((c) => c + 1);
    }
    if (status === "error" && prev !== "error") {
      setErrorCount((c) => c + 1);
    }
    // Reset on disconnect
    if (status === "disconnected" && prev !== "disconnected") {
      setRecoveryCount(0);
      setErrorCount(0);
      setPingHistory([]);
      setCurrentPing(null);
      setSpeed(null);
    }
  }, [status]);

  // Ping polling
  const doPing = useCallback(async () => {
    if (!endpointRef.current) return;
    const { host, port } = endpointRef.current;
    try {
      const ms = await invoke<number>("ping_endpoint", { host, port });
      const point: PingPoint = { time: Date.now(), ping: ms };
      setCurrentPing(ms);
      setPingHistory((prev) => {
        const next = [...prev, point];
        return next.length > MAX_PING_POINTS ? next.slice(-MAX_PING_POINTS) : next;
      });
    } catch {
      setCurrentPing(-1);
    }
  }, []);

  useEffect(() => {
    if (!isConnected) return;
    doPing();
    const iv = setInterval(doPing, 10000);
    return () => clearInterval(iv);
  }, [isConnected, doPing]);

  // Listen for vpn-status to also track via event
  useEffect(() => {
    const unlisten = listen<{ status: string }>("vpn-status", (event) => {
      const s = event.payload?.status;
      if (s === "recovering") setRecoveryCount((c) => c + 1);
      if (s === "error") setErrorCount((c) => c + 1);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Speed test
  const runSpeedTest = useCallback(async () => {
    if (speedTesting || !isConnected) return;
    setSpeedTesting(true);
    setSpeedError(null);
    try {
      const result = await invoke<{ download_mbps: number; upload_mbps: number }>("speedtest_run");
      setSpeed({ ...result, timestamp: Date.now() });
    } catch (e) {
      setSpeedError(String(e));
    } finally {
      setSpeedTesting(false);
    }
  }, [speedTesting, isConnected]);

  // Avg ping
  const avgPing = pingHistory.length > 0
    ? Math.round(pingHistory.filter(p => p.ping > 0).reduce((s, p) => s + p.ping, 0) / pingHistory.filter(p => p.ping > 0).length) || null
    : null;

  return {
    pingHistory,
    currentPing,
    avgPing,
    speed,
    speedTesting,
    speedError,
    runSpeedTest,
    recoveryCount,
    errorCount,
    clientConfig,
  };
}
