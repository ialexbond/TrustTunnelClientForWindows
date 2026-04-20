import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Server, Cpu, MemoryStick, HardDrive, Clock, RefreshCw, Loader2, LogIn,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { StatCard } from "../../shared/ui/StatCard";
import { Button } from "../../shared/ui/Button";
import { formatBytes } from "../../shared/utils/uptime";
import { useSnackBar} from "../../shared/ui/SnackBarContext";
import { formatError } from "../../shared/utils/formatError";

interface SshCredentials {
  host: string;
  port: string;
  user: string;
  password: string;
  keyPath?: string;
}

interface ServerStats {
  cpu_percent: number;
  load_1m: number;
  load_5m: number;
  load_15m: number;
  mem_total: number;
  mem_used: number;
  disk_total: number;
  disk_used: number;
  unique_ips: number;
  total_connections: number;
  uptime_seconds: number;
}

interface ServerStatsCardProps {
  onNavigateToControl: () => void;
}

async function readSshCreds(): Promise<SshCredentials | null> {
  try {
    const obj = await invoke<{ host: string; port: string; user: string; password: string; keyPath: string } | null>("load_ssh_credentials");
    if (!obj || !obj.host || (!obj.password && !obj.keyPath)) return null;
    return {
      host: obj.host,
      port: obj.port || "22",
      user: obj.user || "root",
      password: obj.password || "",
      keyPath: obj.keyPath || undefined,
    };
  } catch {
    return null;
  }
}

function formatServerUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function usageColor(percent: number): string {
  if (percent > 90) return "var(--color-danger-500)";
  if (percent > 50) return "var(--color-warning-500)";
  return "var(--color-success-500)";
}

function UsageBar({ percent }: { percent: number }) {
  return (
    <div
      className="h-1.5 rounded-full w-full"
      style={{ backgroundColor: "var(--color-bg-hover)" }}
    >
      <div
        className="h-1.5 rounded-full transition-all"
        style={{
          width: `${Math.min(percent, 100)}%`,
          backgroundColor: usageColor(percent),
        }}
      />
    </div>
  );
}

export function ServerStatsCard({ onNavigateToControl }: ServerStatsCardProps) {
  const { t } = useTranslation();
  const [hasCreds, setHasCreds] = useState(false);

  // Load initial creds state
  useEffect(() => {
    readSshCreds().then((c) => setHasCreds(!!c));
  }, []);
  const [stats, setStats] = useState<ServerStats | null>(() => {
    try {
      const cached = sessionStorage.getItem("tt_server_stats");
      return cached ? JSON.parse(cached) : null;
    } catch { return null; }
  });
  const [loading, setLoading] = useState(false);
  const pushSuccess = useSnackBar();
  const initialFetchDone = useRef(false);

  // Watch for SSH creds appearing/disappearing (not object identity)
  useEffect(() => {
    const iv = setInterval(() => {
      readSshCreds().then((c) => {
        const has = !!c;
        setHasCreds((prev) => {
          if (prev !== has) {
            if (!has) {
              setStats(null);
              initialFetchDone.current = false;
              try { sessionStorage.removeItem("tt_server_stats"); } catch { /* ignored */ }
            }
            return has;
          }
          return prev;
        });
      });
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const fetchStats = useCallback(async () => {
    const c = await readSshCreds();
    if (!c) return;
    // Only show loader if we have no cached data yet
    if (!stats) setLoading(true);
    try {
      const result = await invoke<ServerStats>("server_get_stats", {
        host: c.host,
        port: parseInt(c.port, 10),
        user: c.user,
        password: c.password,
        keyPath: c.keyPath || null,
      });
      setStats(result);
      try { sessionStorage.setItem("tt_server_stats", JSON.stringify(result)); } catch { /* ignored */ }
    } catch (e) {
      pushSuccess(formatError(e), "error");
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch once when creds appear, then every 30s. Independent of VPN status.
  useEffect(() => {
    if (!hasCreds) return;
    if (!initialFetchDone.current) {
      initialFetchDone.current = true;
      fetchStats();
    }
    const iv = setInterval(fetchStats, 30000);
    return () => clearInterval(iv);
  }, [hasCreds, fetchStats]);

  // No SSH connection — show gate
  if (!hasCreds) {
    return (
      <Card padding="md">
        <CardHeader
          title={t("dashboard.server_stats", "Server")}
          icon={<Server className="w-4 h-4" />}
        />
        <div className="flex flex-col items-center gap-3 py-4">
          <div
            className="p-3 rounded-full"
            style={{ backgroundColor: "var(--color-bg-elevated)", border: "1px solid var(--color-border)" }}
          >
            <Server className="w-6 h-6" style={{ color: "var(--color-text-muted)" }} />
          </div>
          <p className="text-xs text-center" style={{ color: "var(--color-text-muted)" }}>
            {t("dashboard.server_stats_hint", "Connect via Control Panel to see server stats")}
          </p>
          <Button
            variant="ghost"
            size="sm"
            icon={<LogIn className="w-3.5 h-3.5" />}
            onClick={onNavigateToControl}
          >
            {t("dashboard.go_to_control", "Control Panel")}
          </Button>
        </div>
      </Card>
    );
  }

  if (loading && !stats) {
    return (
      <div className="space-y-3">
        <StatCard label="CPU" value="--" icon={<Cpu className="w-4 h-4" />} loading />
        <StatCard label="RAM" value="--" icon={<MemoryStick className="w-4 h-4" />} loading />
        <StatCard label="Disk" value="--" icon={<HardDrive className="w-4 h-4" />} loading />
      </div>
    );
  }

  if (!stats) return null;

  const memPercent = stats.mem_total > 0 ? (stats.mem_used / stats.mem_total) * 100 : 0;
  const diskPercent = stats.disk_total > 0 ? (stats.disk_used / stats.disk_total) * 100 : 0;

  return (
    <Card padding="md">
      <CardHeader
        title={t("dashboard.server_stats", "Server")}
        icon={<Server className="w-4 h-4" />}
        action={
          <div className="flex items-center gap-2">
            {stats.uptime_seconds > 0 && (
              <span className="text-[10px] flex items-center gap-1" style={{ color: "var(--color-text-muted)" }}>
                <Clock className="w-3 h-3" />
                {formatServerUptime(stats.uptime_seconds)}
              </span>
            )}
            <button
              onClick={fetchStats}
              disabled={loading}
              className="transition-colors disabled:opacity-50"
              style={{ color: "var(--color-text-muted)" }}
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            </button>
          </div>
        }
      />
      <div className="space-y-3">
        {/* CPU */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--color-text-muted)" }}>
              <Cpu className="w-3.5 h-3.5" />
              <span>CPU</span>
            </div>
            <span className="text-xs font-semibold" style={{ color: "var(--color-text-primary)" }}>
              {stats.cpu_percent.toFixed(1)}%
            </span>
          </div>
          <UsageBar percent={stats.cpu_percent} />
        </div>

        {/* Memory */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--color-text-muted)" }}>
              <MemoryStick className="w-3.5 h-3.5" />
              <span>RAM</span>
            </div>
            <span className="text-xs font-semibold" style={{ color: "var(--color-text-primary)" }}>
              {formatBytes(stats.mem_used)} / {formatBytes(stats.mem_total)}
            </span>
          </div>
          <UsageBar percent={memPercent} />
        </div>

        {/* Disk */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1.5 text-xs" style={{ color: "var(--color-text-muted)" }}>
              <HardDrive className="w-3.5 h-3.5" />
              <span>Disk</span>
            </div>
            <span className="text-xs font-semibold" style={{ color: "var(--color-text-primary)" }}>
              {formatBytes(stats.disk_used)} / {formatBytes(stats.disk_total)}
            </span>
          </div>
          <UsageBar percent={diskPercent} />
        </div>

      </div>
    </Card>
  );
}
