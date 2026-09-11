// Phase 13 / Plan 13-08 — the SINGLE source of truth for the CONNECT-plate detail rows.
//
// The richer CONNECT notification (owner-approved in Storybook) shows, under the body, three detail
// rows: the endpoint ADDRESS (domain → globe, bare IP → server glyph), the LOGIN, and the connect-
// time PING (coloured by quality). Both the Storybook story (`Notification.stories.tsx`) and the
// PRODUCTION plate (`notification.tsx`) build these rows from THIS module so the demo and the real
// plate can never drift — the story used to carry local copies of `isIpAddress` / `pingColor` /
// `connectDetails`; they were lifted here verbatim and the story now imports them.
//
// D-29: every value here is a DISPLAY string (address / login / ping) — NEVER the endpoint password.
// Only the CONNECT kinds pass these rows; disconnect / error / reconnect / recovering stay compact.
import { Globe, Server, User, Gauge } from "lucide-react";
import type { ConnectionToastDetailRow } from "./ConnectionToast";
import type { PlateLang } from "./notificationCopy";

/** The status colour tokens the ping quality maps onto (`var(--…)`, never hex — CLAUDE.md). */
const TOK = {
  connected: "var(--color-status-connected)",
  warning: "var(--color-status-warning)",
  error: "var(--color-status-error)",
  muted: "var(--color-text-muted)",
} as const;

/** Small leading detail-row icon size — ~12px, decorative (the row's value carries the meaning). */
const DETAIL_ICON = "h-3 w-3";

/** The ping unit per plate language (review #4). The unit used to be a hardcoded Cyrillic «мс», so
 *  an English plate showed "142 мс" amid otherwise-English text. Russian keeps «мс» (matches the
 *  owner-approved «42 мс» look); English mirrors it as "ms". */
const PING_UNIT: Record<PlateLang, string> = { ru: "мс", en: "ms" };

/**
 * Colour the connect-time ping by quality, using the EXACT SAME thresholds as the Connection-tab card
 * pill (`usePerConfigPing.bandForMs`, IN-22): green ≤150 ms, amber ≤300, red beyond. One threshold set
 * everywhere so the same ms never reads a different colour on the notification vs the card (owner:
 * "везде одинаково" — was green<100/amber<200 here, which disagreed with the card's ≤150/≤300).
 * Returns a `var(--…)` status token. Used only for a numeric ping — a missing ping («—») renders
 * muted, no colour (see `buildConnectDetails`).
 */
export function pingColor(ms: number): string {
  if (ms <= 150) return TOK.connected;
  if (ms <= 300) return TOK.warning;
  return TOK.error;
}

/**
 * Is the endpoint address a bare IP literal (vs a domain name)? Drives the address-row icon: a
 * server glyph for an IP, a globe for a domain. Detects IPv4 (`1.2.3.4`) and IPv6 (contains a `:`
 * before the port, or is bracketed `[..]`); everything else is treated as a domain. Mirrors the
 * host:port shape the Rust `read_endpoint_host_port` emits (`host:port`, IPv6 kept bracketed).
 */
export function isIpAddress(address: string): boolean {
  const host = address.replace(/^\[/, "").replace(/\].*$/, "").replace(/:\d+$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4
  if (host.includes(":") || address.startsWith("[")) return true; // IPv6
  return false;
}

/**
 * Build the address / login / ping detail rows for a CONNECT plate.
 *
 * - address: domain → globe icon, bare IP → server icon; rendered mono (aligns host:port).
 * - login: the endpoint username (User icon). Never the password (D-29).
 * - ping: the connect-time reachability ping. A numeric ping renders «{ms} мс» / "{ms} ms" mono
 *   (unit per `lang` — review #4), coloured by quality (`pingColor`). A `null` ping (no measurement /
 *   unreachable at connect) renders «—» in muted with NO colour — the honest no-data state (mirrors
 *   the ping.rs `NoData` «—» convention), never a misleading green/red.
 *
 * `lang` is REQUIRED (no default) so a new call site cannot silently render the Russian unit on an
 * English plate — the exact drift review #4 caught.
 */
export function buildConnectDetails(
  address: string,
  login: string,
  pingMs: number | null,
  lang: PlateLang,
): ConnectionToastDetailRow[] {
  const AddressIcon = isIpAddress(address) ? Server : Globe;
  return [
    { icon: <AddressIcon className={DETAIL_ICON} />, value: address, mono: true },
    { icon: <User className={DETAIL_ICON} />, value: login },
    pingMs === null
      ? // No measurement — honest «—» in muted, no quality colour (never red for "not measured").
        { icon: <Gauge className={DETAIL_ICON} />, value: "—", mono: true, valueColor: TOK.muted }
      : {
          icon: <Gauge className={DETAIL_ICON} />,
          value: `${pingMs} ${PING_UNIT[lang]}`,
          mono: true,
          valueColor: pingColor(pingMs),
        },
  ];
}
