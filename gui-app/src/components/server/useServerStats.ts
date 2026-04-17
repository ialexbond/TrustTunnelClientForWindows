import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../../shared/utils/formatError";
import { translateSshError } from "../../shared/utils/translateSshError";

// ═══════════════════════════════════════════════════════
// Types mirroring Rust server_monitoring::server_get_stats JSON shape.
// Source: gui-app/src-tauri/src/ssh/server/server_monitoring.rs:131-143
// ═══════════════════════════════════════════════════════

export interface ServerStats {
  cpu_percent: number;
  load_1m: number;
  load_5m: number;
  load_15m: number;
  mem_total: number; // bytes
  mem_used: number; // bytes
  disk_total: number; // bytes
  disk_used: number; // bytes
  unique_ips: number;
  total_connections: number;
  uptime_seconds: number;
}

export interface SshParams {
  host: string;
  port: number;
  user: string;
  password: string;
  keyPath?: string;
  [key: string]: unknown;
}

interface Options {
  /** Poll только когда true (D-02, D-03). */
  enabled: boolean;
  /** Default 10_000 (D-01). */
  intervalMs?: number;
}

// Backoff sequence (D-13): normal → slower → paused → reset on first success.
// Index by failureRef.current: 0-1 fails → intervalMs (10s default), 2 fails → 30s, 3+ fails → 60s.
const BACKOFF_SEQUENCE = [10_000, 30_000, 60_000] as const;

/**
 * useServerStats — polling hook для карточек Обзора (Phase 13, D-15).
 *
 * Поведение:
 * - enabled=true → вызывает `server_get_stats` каждые intervalMs (default 10s).
 * - enabled=false → не опрашивает и очищает существующий setInterval.
 * - После 3 подряд ошибок увеличивает паузу до 60s; при первом успехе сбрасывает
 *   failureCount на 0 и возвращается к intervalMs (D-13).
 *
 * Возвращает: { stats, loading, error, failureCount } (D-15).
 *
 * Implementation: использует рекурсивный setTimeout (вместо setInterval),
 * чтобы каждый следующий тик планировался с актуальным backoff-интервалом
 * без необходимости перезапуска useEffect при изменении failureCount
 * (избегает лавины вызовов из-за immediate-fire на каждом перезапуске эффекта).
 */
export function useServerStats(sshParams: SshParams, options: Options) {
  const { t } = useTranslation();
  const { enabled, intervalMs = 10_000 } = options;

  const [stats, setStats] = useState<ServerStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failureCount, setFailureCount] = useState(0);
  const failureRef = useRef(0);

  // Destructure primitives for стабильных deps (pattern: useSecurityState.ts:147-162).
  const { host, port, user, password, keyPath } = sshParams;

  const fetchStats = useCallback(async () => {
    setLoading(true);
    try {
      const s = await invoke<ServerStats>("server_get_stats", {
        host,
        port,
        user,
        password,
        keyPath,
      });
      setStats(s);
      setError(null);
      failureRef.current = 0;
      setFailureCount(0);
    } catch (e) {
      failureRef.current += 1;
      setFailureCount(failureRef.current);
      setError(translateSshError(formatError(e), t));
    } finally {
      setLoading(false);
    }
  }, [host, port, user, password, keyPath, t]);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
      if (cancelled) return;
      // Compute backoff based on current failure count (D-13):
      // 0-1 fails → intervalMs, 2 fails → 30s, 3+ fails → 60s.
      const nextDelay =
        failureRef.current >= 3
          ? BACKOFF_SEQUENCE[2]
          : failureRef.current >= 2
            ? BACKOFF_SEQUENCE[1]
            : intervalMs;

      timeoutId = setTimeout(async () => {
        if (cancelled) return;
        await fetchStats();
        if (cancelled) return;
        scheduleNext();
      }, nextDelay);
    };

    // First fire: planned at intervalMs, NOT immediate. Tests rely on
    // `settleAndTick` (advance 0 + advance 10_000) producing exactly 1 call.
    scheduleNext();

    return () => {
      cancelled = true;
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [enabled, fetchStats, intervalMs]);

  return { stats, loading, error, failureCount };
}
