import type { TFunction } from "i18next";

export function formatUptime(since: Date): string {
  const diff = Math.floor((Date.now() - since.getTime()) / 1000);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Форматирует uptime сервера (секунды) в локализованную строку для карточки Обзор.
 *
 * Правила (Phase 13):
 * - seconds <= 0 или NaN → "—"
 * - < 1 час → i18n "server.overview.uptimeFormat.mins", { mins }
 * - < 1 день → i18n "server.overview.uptimeFormat.hoursMins", { hours, mins }
 * - >= 1 день → i18n "server.overview.uptimeFormat.daysHours", { days, hours }
 *
 * Использует Math.floor, чтобы дробные секунды не давали неожиданный round up.
 */
export function formatServerUptime(seconds: number, t: TFunction): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";

  const totalSeconds = Math.floor(seconds);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return t("server.overview.uptimeFormat.daysHours", { days, hours });
  }
  if (hours > 0) {
    return t("server.overview.uptimeFormat.hoursMins", { hours, mins });
  }
  return t("server.overview.uptimeFormat.mins", { mins });
}
