/**
 * HorizontalProgressBar — replaces StepProgress for BenchmarkModal running state.
 *
 * - Width fills based on percent (if available) or (stage+1)/5 * 100.
 * - Above bar: label = activity ?? stageLabel.
 * - Below bar: percent text + step counter "Этап N/5 · 56%".
 * - Smooth CSS transition on width (transition-all duration-300 ease-out).
 * - Subtle pulse animation when activity for >2s without update (signals alive).
 */
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

interface HorizontalProgressBarProps {
  /** UI stage [0, 4] from backend benchmark-progress event */
  stage: number;
  /** Total stages */
  totalStages?: number;
  /** Explicit percent [0, 100] from parse_signal::Percent — optional */
  percent?: number | null;
  /** Activity label from parse_signal::Activity — optional */
  activity?: string | null;
  /** i18n key for the current stage label */
  stageLabel: string;
}

export function HorizontalProgressBar({
  stage,
  totalStages = 5,
  percent,
  activity,
  stageLabel,
}: HorizontalProgressBarProps) {
  const { t } = useTranslation();
  const [pulsing, setPulsing] = useState(false);

  // Calculate fill percent
  const fillPct =
    percent != null
      ? Math.min(100, Math.max(0, percent))
      : Math.round(((stage + 1) / totalStages) * 100);

  const displayLabel = activity ?? stageLabel;

  // Pulse detection: if percent/activity don't change for 2s, start pulsing
  useEffect(() => {
    // Reset pulsing state on each update
    const timer = setTimeout(() => {
      setPulsing(true);
    }, 2000);

    return () => {
      clearTimeout(timer);
      setPulsing(false);
    };
  }, [percent, activity, stage]);

  const stepText = t("server.utilities.benchmark.progress.step", {
    n: stage + 1,
    total: totalStages,
  });
  const pctText = t("server.utilities.benchmark.progress.percent", { pct: fillPct });

  return (
    <div className="flex flex-col gap-2">
      {/* Label above bar */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-body-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
          {displayLabel}
        </span>
        <span className="text-caption" style={{ color: "var(--color-text-muted)" }}>
          {stepText} · {pctText}
        </span>
      </div>

      {/* Bar track */}
      <div
        className="w-full rounded-full overflow-hidden"
        style={{
          height: 8,
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${fillPct}%`,
            background: "var(--color-accent-interactive)",
            borderRadius: "inherit",
            transition: "width 300ms ease-out",
            // Pulse animation: subtle opacity oscillation when stuck
            animation: pulsing ? "tt-progress-pulse 1.5s ease-in-out infinite" : "none",
          }}
        />
      </div>
    </div>
  );
}

// Inline global style for pulse animation
// Injected once when component is first loaded
if (typeof document !== "undefined" && !document.getElementById("tt-progress-pulse-style")) {
  const style = document.createElement("style");
  style.id = "tt-progress-pulse-style";
  style.textContent = `
    @keyframes tt-progress-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.55; }
    }
  `;
  document.head.appendChild(style);
}
