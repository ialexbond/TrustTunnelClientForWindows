/**
 * Phase 16 polish — Fail2Ban output parsers + localizers + duration normalizer.
 *
 * Backend `security_fail2ban_get_status` returns banned IPs как они приходят
 * из `fail2ban-client status sshd` — formatting English-only:
 *   "5min ago" / "1h ago" / "2 days ago" / "Currently failed" / etc.
 *
 * UI должен показывать локализованный текст пользователю. Эти helpers парсят
 * raw English output и возвращают человеко-читаемый text согласно текущему
 * языку (`i18n.language`).
 */

/**
 * BUG-01 fix: normalize fail2ban duration strings к canonical numeric seconds.
 *
 * Fail2Ban backend (`/etc/fail2ban/jail.local` template via `install_fail2ban`)
 * пишет default values в format с time-suffix:
 *   bantime  = 1h
 *   findtime = 10m
 *
 * Frontend `FAIL2BAN_PRESETS` хранит numeric seconds:
 *   balanced: { bantime: "600", findtime: "600" }
 *
 * String comparison `cfg.bantime === jail.bantime` was failing → fresh install
 * детектился как "Своя конфигурация" вместо "Сбалансированная". Этот helper
 * нормализует обе стороны к canonical seconds string перед сравнением.
 *
 * Format reference (mirror backend `is_safe_duration` in sanitize.rs):
 *   - bare number: "600" → 600
 *   - N + s/sec/seconds: "30s" → 30
 *   - N + m/min/minutes: "10m" → 600
 *   - N + h/hour/hours: "1h" → 3600
 *   - N + d/day/days: "1d" → 86400
 *   - N + w/week/weeks: "1w" → 604800
 *   - N + y/year/years: "1y" → 31536000
 *
 * Returns `null` для invalid input — caller использует raw string fallback.
 */
export function normalizeDurationToSeconds(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Bare number → as-is.
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return Number.isFinite(n) ? n : null;
  }

  // N + suffix.
  const m = /^(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days|w|wk|week|weeks|y|yr|year|years)$/i.exec(
    trimmed,
  );
  if (!m) return null;
  const amount = parseInt(m[1], 10);
  if (!Number.isFinite(amount)) return null;
  const u = m[2].toLowerCase();
  if (u.startsWith("s")) return amount;
  if (u === "m" || u.startsWith("min")) return amount * 60;
  if (u.startsWith("h")) return amount * 3600;
  if (u.startsWith("d")) return amount * 86400;
  if (u.startsWith("w")) return amount * 604800;
  if (u.startsWith("y")) return amount * 31536000;
  return null;
}

/**
 * BUG-01 fix: compare two fail2ban duration strings semantically (e.g. "1h" === "3600").
 * Returns false если хоть одна сторона не парсится — defensive default.
 */
export function durationsEqual(a: string | undefined, b: string | undefined): boolean {
  const na = normalizeDurationToSeconds(a);
  const nb = normalizeDurationToSeconds(b);
  if (na === null || nb === null) return false;
  return na === nb;
}

interface ParsedDuration {
  /** Целочисленное количество единиц. */
  amount: number;
  /** Единица для Intl.RelativeTimeFormat. */
  unit: Intl.RelativeTimeFormatUnit;
}

/**
 * Парсит fail2ban-client style relative time strings:
 *   - "5min" / "5 min" / "5 minute" / "5 minutes"
 *   - "1h" / "1 hour" / "1 hours"
 *   - "2d" / "2 day" / "2 days"
 *   - "30s" / "30 sec" / "30 seconds"
 *   - "1w" / "1 week"
 *   - "1y" / "1 year"
 *
 * Optional " ago" suffix игнорируется (мы всегда возвращаем relative-past).
 *
 * Returns `null` если raw не матчит ни один known pattern (например,
 * "Currently failed" или ISO timestamp — caller будет показывать raw).
 */
export function parseAgoDuration(raw: string): ParsedDuration | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase().replace(/\s+ago$/i, "").trim();

  // Match: digits + optional space + unit (s/sec/seconds, m/min/minute,
  // h/hr/hour, d/day, w/week, y/year — all with optional plural 's').
  const m = /^(\d+)\s*(s|sec|second|seconds|m|min|minute|minutes|h|hr|hour|hours|d|day|days|w|wk|week|weeks|y|yr|year|years)$/i.exec(
    trimmed,
  );
  if (!m) return null;

  const amount = parseInt(m[1], 10);
  const unitToken = m[2].toLowerCase();

  let unit: Intl.RelativeTimeFormatUnit;
  if (unitToken.startsWith("s")) unit = "second";
  else if (unitToken === "m" || unitToken.startsWith("min")) unit = "minute";
  else if (unitToken.startsWith("h")) unit = "hour";
  else if (unitToken.startsWith("d")) unit = "day";
  else if (unitToken.startsWith("w")) unit = "week";
  else if (unitToken.startsWith("y")) unit = "year";
  else return null;

  return { amount, unit };
}

/**
 * Локализует ban time (например, "5min ago" → «5 минут назад» в RU,
 * "5 minutes ago" в EN). Falls back to raw string если parse failed.
 *
 * Использует `Intl.RelativeTimeFormat` — нативный API с правильной
 * pluralизацией для всех языков.
 */
export function formatBanTime(raw: string, lang: string): string {
  const parsed = parseAgoDuration(raw);
  if (!parsed) return raw; // unknown format → show as-is

  try {
    const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "always" });
    // Negative because "X minutes ago" = -X minutes from now.
    return rtf.format(-parsed.amount, parsed.unit);
  } catch {
    return raw;
  }
}
