import type { VpnStatus } from "../types";

/**
 * Map a `VpnStatus` to the StatusBadge colour variant. Extracted into a shared module
 * (out of StatusPanel.tsx) so BOTH `StatusPanel` and the Phase-11 `ConfigCard` lead card
 * reuse the EXACT SAME mapping (connection.md design contract: new states land in the
 * right colour band by construction). No new VpnStatus value / no `switching` wire-state
 * is added (Pitfall 4).
 *
 * COLOR LOGIC (user decision): 🟡 yellow = ANY active state working toward a connection
 * (connecting / reconnecting / recovering — «Восстановление» is a process, not a failure,
 * so it must NOT look alarming); only the TERMINAL «Ошибка» is 🔴 red; `disconnecting`
 * (teardown-in-flight) + `disconnected` are ⚪ gray.
 */
export const statusBadgeVariant = (
  s: VpnStatus,
): "connected" | "connecting" | "error" | "disconnected" => {
  if (s === "connected") return "connected";
  if (s === "connecting" || s === "reconnecting" || s === "recovering") return "connecting";
  if (s === "error") return "error";
  // disconnecting + disconnected → gray
  return "disconnected";
};
