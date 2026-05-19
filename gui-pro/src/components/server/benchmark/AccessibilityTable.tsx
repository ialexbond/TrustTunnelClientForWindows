/**
 * AccessibilityTable — renders Section 5 (Accessibility for media and AI services).
 *
 * Layout: 3-column grid — service (left) | country code (center) | status (right).
 * Status renders as a coloured chip with the RAW enum value (Yes / No / NoPrem / Blocked / Unknown):
 *   Yes     → success (green)
 *   No      → danger (red)
 *   NoPrem  → warning (yellow, PROMINENT — key signal "RU region, no premium")
 *   Blocked → destructive (dark red)
 *   Unknown → neutral
 *
 * Per UAT 2026-05-19: drop the localized "Available"/"Доступен" and the redundant
 * Type column (almost always "Native") — display raw enum values directly.
 */
import type { AccessibilityRow, AccessibilityStatus } from "./parser";

interface AccessibilityTableProps {
  rows: AccessibilityRow[];
}

function StatusChip({ status }: { status: AccessibilityStatus }) {
  const statusConfig: Record<AccessibilityStatus, { bg: string; color: string }> = {
    Yes: {
      bg: "var(--color-status-connected-bg)",
      color: "var(--color-success-500)",
    },
    No: {
      bg: "var(--color-status-error-bg)",
      color: "var(--color-danger-500)",
    },
    NoPrem: {
      bg: "var(--color-status-warning-bg)",
      color: "var(--color-warning-500)",
    },
    Blocked: {
      bg: "var(--color-status-error-bg)",
      color: "var(--color-destructive)",
    },
    Unknown: {
      bg: "var(--color-bg-surface)",
      color: "var(--color-text-muted)",
    },
  };

  const config = statusConfig[status];

  return (
    <span
      className="inline-block rounded-[var(--radius-sm)] px-2 py-0.5 text-caption font-medium whitespace-nowrap"
      style={{ background: config.bg, color: config.color }}
    >
      {status}
    </span>
  );
}

export function AccessibilityTable({ rows }: AccessibilityTableProps) {
  if (rows.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 w-full">
      {rows.map((row) => (
        <div
          key={row.service}
          className="grid grid-cols-[1fr_60px_1fr] items-center gap-3 py-1 w-full"
          style={{ borderBottom: "1px solid var(--color-border)" }}
        >
          {/* Service name — left */}
          <span
            className="text-body-sm font-medium truncate"
            style={{ color: "var(--color-text-primary)" }}
            title={row.service}
          >
            {row.service}
          </span>

          {/* Country code — center */}
          <span
            className="text-caption font-mono text-center"
            style={{ color: "var(--color-text-muted)" }}
          >
            {row.region ? `[${row.region}]` : "[-]"}
          </span>

          {/* Status — right */}
          <div className="flex justify-end">
            <StatusChip status={row.status} />
          </div>
        </div>
      ))}
    </div>
  );
}
