import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// ═══════════════════════════════════════════════════════
// Types mirroring Rust commands::geoip::GeoIpInfo struct.
// Source: gui-app/src-tauri/src/commands/geoip.rs
// ═══════════════════════════════════════════════════════

export interface GeoIpInfo {
  country: string;
  country_code: string;
  flag_emoji: string;
}

interface CachedGeoIp extends GeoIpInfo {
  fetched_at: string; // ISO
}

// ═══════════════════════════════════════════════════════
// localStorage cache with 30-day TTL (D-06).
// Pattern source: gui-app/src/components/server/useMtProtoState.ts:41-73
// ═══════════════════════════════════════════════════════

const STORAGE_PREFIX = "tt_geoip_";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function getCacheKey(host: string): string {
  return `${STORAGE_PREFIX}${host}`;
}

function loadCache(host: string): GeoIpInfo | null {
  try {
    const raw = localStorage.getItem(getCacheKey(host));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedGeoIp;
    if (!parsed.country || !parsed.flag_emoji || !parsed.fetched_at) {
      return null;
    }
    const age = Date.now() - new Date(parsed.fetched_at).getTime();
    if (Number.isNaN(age) || age > TTL_MS) {
      // Expired or invalid date — drop and refetch.
      localStorage.removeItem(getCacheKey(host));
      return null;
    }
    return {
      country: parsed.country,
      country_code: parsed.country_code,
      flag_emoji: parsed.flag_emoji,
    };
  } catch {
    // Corrupt JSON or any other error — treat as cache miss.
    return null;
  }
}

function saveCache(host: string, info: GeoIpInfo): void {
  try {
    const cached: CachedGeoIp = {
      ...info,
      fetched_at: new Date().toISOString(),
    };
    localStorage.setItem(getCacheKey(host), JSON.stringify(cached));
  } catch {
    // localStorage может быть недоступен (privacy mode / quota) — не блокируем UI.
  }
}

// ═══════════════════════════════════════════════════════
// Hook (Phase 13, D-16)
// ═══════════════════════════════════════════════════════

/**
 * useServerGeoIp — fire-once GeoIP lookup с TTL-кешем в localStorage.
 *
 * - При монтировании: cache hit → сразу geo; cache miss/expired → invoke + save.
 * - Ошибка invoke → geo=null, error=String(e). Карточка Страна покажет `—` (D-14).
 * - Повторные renders не вызывают invoke (fire-once на host).
 */
export function useServerGeoIp(sshParams: { host: string }) {
  const { host } = sshParams;

  const [geo, setGeo] = useState<GeoIpInfo | null>(() => loadCache(host));
  const [loading, setLoading] = useState<boolean>(() => loadCache(host) === null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Cache lookup runs asynchronously to avoid sync setState in effect body
    // (react-hooks/set-state-in-effect). The microtask resolves before paint, so
    // there is no visible flash for cache-hit users.
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const cached = loadCache(host);
      if (cached) {
        setGeo(cached);
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);

      invoke<GeoIpInfo>("get_server_geoip", { host })
        .then((info) => {
          if (cancelled) return;
          setGeo(info);
          saveCache(host, info);
        })
        .catch((e) => {
          if (cancelled) return;
          setGeo(null);
          setError(String(e)); // D-14: keep geo=null, card shows `—`
        })
        .finally(() => {
          if (cancelled) return;
          setLoading(false);
        });
    });

    return () => {
      cancelled = true;
    };
  }, [host]);

  return { geo, loading, error };
}
