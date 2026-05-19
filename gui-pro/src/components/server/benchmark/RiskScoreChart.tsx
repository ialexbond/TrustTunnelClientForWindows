/**
 * RiskScoreChart — horizontal multi-bar chart for Section 3 (Risk Score).
 *
 * Each source = 1 row. Layout:
 *   [source name ~120px] [5-segment bar with indicator at current level] [score ~60px]
 *
 * 5 segments: VeryLow | Low | Medium | High | VeryHigh
 * Each segment uses semantic color tokens. Indicator marker at source's current level.
 * Pure CSS — no chart libraries.
 */
import { useTranslation } from "react-i18next";
import type { RiskScoreRow, RiskLevel } from "./parser";

interface RiskScoreChartProps {
  rows: RiskScoreRow[];
}

const LEVELS: RiskLevel[] = ["VeryLow", "Low", "Medium", "High", "VeryHigh"];

// Semantic color tokens per level segment
const SEGMENT_COLORS: Record<RiskLevel, string> = {
  VeryLow: "var(--color-success-400)",
  Low: "var(--color-success-500)",
  Medium: "var(--color-warning-400)",
  High: "var(--color-danger-400)",
  VeryHigh: "var(--color-danger-600)",
  Unknown: "var(--color-border)",
};

const SEGMENT_BG_COLORS: Record<RiskLevel, string> = {
  VeryLow: "var(--color-status-connected-bg)",
  Low: "var(--color-status-connected-bg)",
  Medium: "var(--color-status-warning-bg)",
  High: "var(--color-status-error-bg)",
  VeryHigh: "var(--color-status-error-bg)",
  Unknown: "var(--color-bg-surface)",
};

function LevelSegment({
  level,
  active,
}: {
  level: RiskLevel;
  active: boolean;
}) {
  return (
    <div
      style={{
        flex: 1,
        height: 12,
        borderRadius: 2,
        background: active ? SEGMENT_COLORS[level] : SEGMENT_BG_COLORS[level],
        opacity: active ? 1 : 0.35,
        transition: "all 150ms ease",
        position: "relative",
      }}
    >
      {/* Active indicator marker */}
      {active && (
        <div
          style={{
            position: "absolute",
            bottom: -4,
            left: "50%",
            transform: "translateX(-50%)",
            width: 0,
            height: 0,
            borderLeft: "4px solid transparent",
            borderRight: "4px solid transparent",
            borderBottom: `4px solid ${SEGMENT_COLORS[level]}`,
          }}
        />
      )}
    </div>
  );
}

export function RiskScoreChart({ rows }: RiskScoreChartProps) {
  const { t } = useTranslation();

  if (rows.length === 0) return null;

  const levelI18nKey = (level: RiskLevel): string => {
    const map: Record<RiskLevel, string> = {
      VeryLow: "server.utilities.benchmark.sections.risk.level.very_low",
      Low: "server.utilities.benchmark.sections.risk.level.low",
      Medium: "server.utilities.benchmark.sections.risk.level.medium",
      High: "server.utilities.benchmark.sections.risk.level.high",
      VeryHigh: "server.utilities.benchmark.sections.risk.level.very_high",
      Unknown: "server.utilities.benchmark.sections.risk.level.low",
    };
    return map[level] ?? map.Low;
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Legend */}
      <div className="flex items-center flex-wrap gap-x-3 gap-y-1">
        {LEVELS.map((level) => (
          <div key={level} className="flex items-center gap-1">
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: 2,
                background: SEGMENT_COLORS[level],
              }}
            />
            <span className="text-caption" style={{ color: "var(--color-text-muted)" }}>
              {t(levelI18nKey(level))}
            </span>
          </div>
        ))}
      </div>

      {/* Rows — grid full width: source label + bar (flex grows) + score-with-level text */}
      {rows.map((row) => (
        <div
          key={row.source}
          className="grid grid-cols-[110px_1fr_120px] gap-3 items-center w-full"
          style={{ marginBottom: 6 }}
        >
          {/* Source label */}
          <span
            className="text-caption"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {row.source}
          </span>

          {/* Bar segments */}
          <div className="flex items-center gap-0.5">
            {LEVELS.map((level) => (
              <LevelSegment
                key={level}
                level={level}
                active={row.level === level}
              />
            ))}
          </div>

          {/* Score + level */}
          <div className="flex items-center gap-1 justify-start">
            {row.score > 0 && (
              <span className="text-mono-sm" style={{ color: "var(--color-text-primary)" }}>
                {row.unit === "percent" ? `${row.score}%` : row.score}
              </span>
            )}
            <span
              className="text-caption"
              style={{ color: SEGMENT_COLORS[row.level] }}
            >
              {t(levelI18nKey(row.level))}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}
