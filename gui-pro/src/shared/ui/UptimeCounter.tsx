import { useEffect, useState } from "react";
import { formatUptime } from "../utils/uptime";

/**
 * Live «HH:MM:SS» session-uptime counter, ticking once per second from `since`.
 *
 * Extracted from StatusPanel so BOTH surfaces that show the VPN session uptime reuse ONE
 * implementation: the StatusPanel (Settings / About / Routing tabs) AND the connected lead
 * card on the «Подключение» tab (`ConfigCard`). The card had a designed uptime slot + Storybook
 * story from Phase 11 but its live wiring was never connected — this component + the
 * `connectedSince` thread close that gap.
 *
 * Only THIS span re-renders each second (isolated ticker), never the parent card/panel.
 */
export function UptimeCounter({ since }: { since: Date }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);
  return <span>{formatUptime(since)}</span>;
}
