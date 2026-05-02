/**
 * Phase 16 polish — Fail2Ban output parsers + localizers.
 *
 * Backend `security_fail2ban_get_status` returns banned IPs как они приходят
 * из `fail2ban-client status sshd` — formatting English-only:
 *   "5min ago" / "1h ago" / "2 days ago" / "Currently failed" / etc.
 *
 * UI должен показывать локализованный текст пользователю. Эти helpers парсят
 * raw English output и возвращают человеко-читаемый text согласно текущему
 * языку (`i18n.language`).
 */

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
