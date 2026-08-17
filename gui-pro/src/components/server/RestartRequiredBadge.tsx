/* eslint-disable react-refresh/only-export-components -- CVA variants are co-located with the component by design */
import { cva, type VariantProps } from "class-variance-authority";
import { useTranslation } from "react-i18next";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "../../shared/lib/cn";

/**
 * CVA variants for the badge.
 *
 * Token map (Phase 15 UI-SPEC §Color):
 *   - `disrupt-high` → `--color-status-error-bg` + `--color-danger-fg` (red, AlertTriangle)
 *   - `disrupt-low`  → `--color-warning-tint-08` + `--color-warning-fg` (yellow, RefreshCw)
 *
 * NOTE: tokens.css does not expose `--color-status-warning-bg` (only
 * `--color-status-connecting-bg` and the warning-tint scale). We use
 * `--color-warning-tint-08` because it is the theme-aware yellow tint that
 * already powers EndpointStep / wizard warning surfaces — same visual semantic
 * as the plan-specified `--color-status-warning-bg`. This deviation is logged
 * in 15-03-SUMMARY (Rule 1 — plan token reference was broken).
 */
export const restartBadgeVariants = cva(
  "inline-flex items-center gap-1 px-2 py-0.5 rounded-[var(--radius-sm)] text-caption",
  {
    variants: {
      level: {
        "disrupt-high":
          "bg-[var(--color-status-error-bg)] text-[var(--color-danger-fg)]",
        "disrupt-low":
          "bg-[var(--color-warning-tint-08)] text-[var(--color-warning-fg)]",
      },
    },
    defaultVariants: { level: "disrupt-low" },
  },
);

export interface RestartRequiredBadgeProps
  extends VariantProps<typeof restartBadgeVariants> {
  className?: string;
}

/**
 * Phase 15 inline badge marking a vpn.toml field as requiring sidecar restart.
 *
 * - `disrupt-high` (red): listen_address, ipv6_available, credentials_file —
 *    «Прервёт активные подключения» — affects existing VPN sessions.
 * - `disrupt-low` (yellow): timeouts, paths, log_level — «Перезапустит сервис» —
 *    brief sidecar bounce, no client-visible disruption.
 *
 * Pure presentational — no state, no side effects. Restart-required policy
 * itself is enforced by backend (every typed mutation calls
 * `systemctl --no-block restart trusttunnel`); this badge only communicates
 * the disruption level to the user.
 */
export function RestartRequiredBadge({
  level,
  className,
}: RestartRequiredBadgeProps) {
  const { t } = useTranslation();
  const isHigh = level === "disrupt-high";
  const labelKey = isHigh
    ? "server.config.restart_disrupt_high"
    : "server.config.restart_disrupt_low";
  const Icon = isHigh ? AlertTriangle : RefreshCw;

  return (
    <span
      role="status"
      className={cn(restartBadgeVariants({ level }), className)}
    >
      <Icon className="w-3 h-3" aria-hidden="true" />
      {t(labelKey)}
    </span>
  );
}
