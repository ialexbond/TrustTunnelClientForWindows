import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { Card } from "./Card";
import { Skeleton } from "./Skeleton";

export interface StatCardProps {
  label: string;
  value: string | number;
  trend?: number;
  icon?: ReactNode;
  loading?: boolean;
  className?: string;
}

function getTrendColor(trend: number): string {
  if (trend > 0) return "var(--color-status-connected)";
  if (trend < 0) return "var(--color-status-error)";
  return "var(--color-text-muted)";
}

function formatTrend(trend: number): string {
  if (trend > 0) return `+${trend}%`;
  if (trend < 0) return `${trend}%`;
  return `${trend}%`;
}

export function StatCard({ label, value, trend, icon, loading, className }: StatCardProps) {
  if (loading) {
    return (
      <Card padding="md" className={cn(className)}>
        <div className="flex flex-col gap-2">
          <Skeleton variant="circle" width={16} height={16} />
          <Skeleton variant="line" width="60%" height={24} />
          <Skeleton variant="line" width="40%" height={14} />
        </div>
      </Card>
    );
  }

  return (
    <Card padding="md" className={cn(className)}>
      <div className="flex flex-col gap-1">
        <div className="flex items-start justify-between">
          {icon && (
            <span aria-hidden="true" style={{ color: "var(--color-accent-interactive)" }}>
              {icon}
            </span>
          )}
          {trend !== undefined && trend !== 0 && (
            <span
              className="text-xs font-[var(--font-weight-semibold)]"
              style={{ color: getTrendColor(trend) }}
            >
              {formatTrend(trend)}
            </span>
          )}
        </div>
        <div
          className="text-xl font-[var(--font-weight-semibold)]"
          style={{ color: "var(--color-text-primary)" }}
        >
          {value}
        </div>
        <div
          className="text-sm"
          style={{ color: "var(--color-text-muted)" }}
        >
          {label}
        </div>
      </div>
    </Card>
  );
}
