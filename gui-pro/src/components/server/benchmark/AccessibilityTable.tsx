/**
 * AccessibilityTable — renders Section 5 (Accessibility for media and AI services).
 *
 * Services in rows, status chip colored:
 *   Yes → success (green)
 *   No  → danger (red)
 *   NoPrem → warning (yellow, PROMINENT — key signal "RU region, no premium")
 *   Blocked → destructive (dark red)
 *   Unknown → neutral
 */
import { useTranslation } from "react-i18next";
import type { AccessibilityRow, AccessibilityStatus } from "./parser";

interface AccessibilityTableProps {
  rows: AccessibilityRow[];
}

function StatusChip({ status }: { status: AccessibilityStatus }) {
  const { t } = useTranslation();

  const statusConfig: Record<
    AccessibilityStatus,
    { bg: string; color: string; i18nKey: string }
  > = {
    Yes: {
      bg: "var(--color-status-connected-bg)",
      color: "var(--color-success-500)",
      i18nKey: "server.utilities.benchmark.sections.accessibility.status.yes",
    },
    No: {
      bg: "var(--color-status-error-bg)",
      color: "var(--color-danger-500)",
      i18nKey: "server.utilities.benchmark.sections.accessibility.status.no",
    },
    NoPrem: {
      bg: "var(--color-status-warning-bg)",
      color: "var(--color-warning-500)",
      i18nKey: "server.utilities.benchmark.sections.accessibility.status.no_prem",
    },
    Blocked: {
      bg: "var(--color-status-error-bg)",
      color: "var(--color-destructive)",
      i18nKey: "server.utilities.benchmark.sections.accessibility.status.blocked",
    },
    Unknown: {
      bg: "var(--color-bg-surface)",
      color: "var(--color-text-muted)",
      i18nKey: "server.utilities.benchmark.sections.accessibility.status.yes", // fallback
    },
  };

  const config = statusConfig[status];

  return (
    <span
      className="inline-block rounded-[var(--radius-sm)] px-2 py-0.5 text-caption font-medium whitespace-nowrap"
      style={{ background: config.bg, color: config.color }}
    >
      {t(config.i18nKey)}
    </span>
  );
}

export function AccessibilityTable({ rows }: AccessibilityTableProps) {
  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <div
          key={row.service}
          className="flex items-center justify-between gap-3 py-1"
          style={{
            borderBottom: "1px solid var(--color-border)",
          }}
        >
          {/* Service name */}
          <span
            className="text-body-sm font-medium shrink-0"
            style={{ color: "var(--color-text-primary)", minWidth: 80 }}
          >
            {row.service}
          </span>

          <div className="flex items-center gap-3">
            {/* Region */}
            {row.region !== undefined && (
              <span
                className="text-caption font-mono"
                style={{ color: "var(--color-text-muted)" }}
              >
                {row.region ? `[${row.region}]` : "[-]"}
              </span>
            )}

            {/* Type */}
            {row.type && (
              <span
                className="text-caption"
                style={{ color: "var(--color-text-muted)" }}
              >
                {row.type}
              </span>
            )}

            {/* Status chip */}
            <StatusChip status={row.status} />
          </div>
        </div>
      ))}
    </div>
  );
}
