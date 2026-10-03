import { useTranslation } from "react-i18next";
import { Badge } from "../../shared/ui/Badge";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";
import { Skeleton } from "../../shared/ui/Skeleton";
import { Tooltip } from "../../shared/ui/Tooltip";
// PA-3 (17-02): `ConfigPing`/`PingBand` now live in the STATE module that produces them
// (`usePerConfigPing`), not here in the presentation component. This pill imports them DOWNWARD; it
// re-exports them for backward compatibility so existing `./ConfigPingPill` type importers keep working.
import type { ConfigPing, PingBand } from "../../shared/hooks/usePerConfigPing";
export type { ConfigPing, PingBand } from "../../shared/hooks/usePerConfigPing";

/**
 * `ConfigPingPill` — the production per-config ping pill rendering the FIVE honest D-16
 * states (lifted from the story-tier `connectionDemos.tsx` `ConfigPingBadge`, pixel
 * reference). It is a pure presentational component: it renders whatever band the
 * `usePerConfigPing` hook resolved, it does not measure anything itself.
 *
 * The five states (memory/v3/screens/connection.md §Цвета пинга; thresholds IN-22):
 *   - green  (≤ 150 ms)    → Badge variant=success, numeric «N ms»
 *   - yellow (151–300 ms)  → Badge variant=warning, numeric «N ms»
 *   - red    (> 300 ms)    → Badge variant=danger,  numeric «N ms»
 *   - timeout              → Badge variant=danger «Недоступен» (NOT a number)
 *   - no-data              → neutral StatusIndicator «—» + tooltip, NEVER red
 *   - measuring            → a coloured Skeleton loader (tint = the band being
 *                            re-measured; grey for a first probe), no text
 *
 * Layout-stability (no jump while re-measuring): when a config whose ping is ALREADY known is
 * re-measured, the skeleton reserves the EXACT width the resolved value will take — it lays a
 * shimmer over an invisible copy of the prior «N ms» badge — so a 3-digit value (e.g. «185 ms»)
 * does not collapse to a narrow 2-digit skeleton and snap back (user-reported jump). Only the
 * FIRST-ever probe (no prior value) uses the fixed `PING_PILL_MIN_W` footprint, shared with the
 * no-data «—» so measuring→«—» also keeps one size. Numeric / «Недоступен» badges are naturally
 * wider, so the min is a floor, never a clamp.
 *
 * All colours come from tokens.css (no hardcoded hex); the only icon-like element is the
 * shared `StatusIndicator` dot. Uses the canonical `variant` prop (never severity/tone).
 * The «Недоступен» / no-data / measuring strings reference the `connection.ping.*` i18n
 * keys added in Plan 02 Task 3 — no new key is introduced here.
 */

/** Shared ping-pill footprint (px). The measuring Skeleton renders at exactly this width,
 *  and the «—» (no-data) Badge takes it as its MIN width — so the pill keeps the same
 *  footprint whether it is loading or resolved to a dash. One constant locks the two. */
export const PING_PILL_MIN_W = 44;

/** Map a numeric band to its canonical Badge variant. */
const numericVariant: Record<"green" | "yellow" | "red", "success" | "warning" | "danger"> = {
  green: "success",
  yellow: "warning",
  red: "danger",
};

/** Skeleton tint per band — the measuring loader takes the colour of the band being
 *  (re)measured; grey when there is no prior band (first-ever probe). Token-driven. */
function pingSkeletonTint(band: PingBand): string {
  switch (band) {
    case "green":
      return "var(--color-success-tint-25)";
    case "yellow":
      return "var(--color-status-warning-bg)";
    case "red":
    case "timeout":
      return "var(--color-status-error-bg)";
    default:
      return "var(--color-skeleton)"; // grey — visible in both themes
  }
}

export function ConfigPingPill({ ping }: { ping: ConfigPing }) {
  const { t } = useTranslation();
  const isMeasuring = ping.measuring === true || ping.band === "measuring";

  // normal-case keeps «ms» lowercase (Badge base upper-cases); whitespace-nowrap stops
  // «180 ms» wrapping to two lines in the column.
  const pillClass = "whitespace-nowrap normal-case";

  if (isMeasuring) {
    // The Skeleton is aria-hidden (decorative), so the accessible label lives on a
    // role="status" wrapper screen readers DO announce while the probe is in flight.
    const tint = pingSkeletonTint(ping.band);
    // The prior value (kept by usePerConfigPing across a re-measure) tells us how wide the
    // resolved badge will be. Reserve that exact width with an invisible badge + a shimmer
    // overlay so the pill never changes size between «measuring» and the number (no jump).
    const priorLabel =
      ping.valueMs != null ? `${ping.valueMs} ${t("connection.ping.unit")}` : null;
    if (priorLabel) {
      return (
        <span
          role="status"
          aria-label={t("connection.ping.measuring")}
          className="relative inline-flex"
        >
          {/* Invisible copy of the resolved badge — reserves its exact footprint. */}
          <Badge variant="neutral" className={`${pillClass} invisible`} aria-hidden="true">
            {priorLabel}
          </Badge>
          {/* Shimmer laid over that reserved box, tinted to the band being re-measured. */}
          <span className="absolute inset-0 flex">
            <Skeleton rounded className="h-full w-full" style={{ backgroundColor: tint }} />
          </span>
        </span>
      );
    }
    // First-ever probe — no prior value to size to → the fixed footprint shared with «—».
    return (
      <span role="status" aria-label={t("connection.ping.measuring")} className="inline-flex">
        <Skeleton rounded height={18} width={PING_PILL_MIN_W} style={{ backgroundColor: tint }} />
      </span>
    );
  }

  if (ping.band === "no-data") {
    // The lone «—» is narrow, so floor its width to the measuring-skeleton footprint and
    // centre the dash — measuring→«—» keeps the same size, no jump. NEVER red (D-16):
    // neutral badge + a StatusIndicator neutral dot to read as "no signal", not an error.
    return (
      <Tooltip text={t("connection.ping.no_data_tooltip")}>
        <Badge
          variant="neutral"
          className={`${pillClass} justify-center gap-1`}
          style={{ minWidth: PING_PILL_MIN_W }}
        >
          <StatusIndicator status="neutral" size="sm" label={t("connection.ping.no_data_tooltip")} />
          {t("connection.ping.no_data")}
        </Badge>
      </Tooltip>
    );
  }

  if (ping.band === "timeout") {
    // D-03 (17-02): the honest tooltip clarifies that «Недоступен» is about SERVER reachability (the
    // direct connect was refused/timed out), NOT a verdict that the config is broken.
    return (
      <Tooltip text={t("connection.ping.unreachable_tooltip")}>
        <Badge variant="danger" className={pillClass}>
          {t("connection.ping.unreachable")}
        </Badge>
      </Tooltip>
    );
  }

  // Numeric band (green/yellow/red) — «N ms». By here measuring/no-data/timeout have all
  // returned, but the compiler still sees the full PingBand union, so narrow explicitly:
  // any band that is not a known numeric one falls back to no-data «—» (never red).
  if (ping.band !== "green" && ping.band !== "yellow" && ping.band !== "red") {
    return (
      <Tooltip text={t("connection.ping.no_data_tooltip")}>
        <Badge
          variant="neutral"
          className={`${pillClass} justify-center gap-1`}
          style={{ minWidth: PING_PILL_MIN_W }}
        >
          <StatusIndicator status="neutral" size="sm" label={t("connection.ping.no_data_tooltip")} />
          {t("connection.ping.no_data")}
        </Badge>
      </Tooltip>
    );
  }
  const label = `${ping.valueMs ?? 0} ${t("connection.ping.unit")}`;
  // D-03 (17-02): the honest tooltip states the numeric value is the direct-connect latency = SERVER
  // reachability, and explicitly NOT a promise that «этот конфиг рабочий / можно подключиться». The
  // colour band and number are unchanged (TA-1 banding preserved) — only the meaning is labelled honestly.
  return (
    <Tooltip text={t("connection.ping.reachable_tooltip")}>
      <Badge variant={numericVariant[ping.band]} className={pillClass}>
        {label}
      </Badge>
    </Tooltip>
  );
}
