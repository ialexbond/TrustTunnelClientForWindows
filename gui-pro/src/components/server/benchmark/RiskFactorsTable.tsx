/**
 * RiskFactorsTable — multi-source matrix for Section 4 (Risk Factors).
 *
 * Sources as columns, factors as rows.
 * Cells: Yes (warning chip) / No (muted) / N/A (muted small).
 */
import { useTranslation } from "react-i18next";
import type { RiskFactorsRow } from "./parser";

interface RiskFactorsTableProps {
  rows: RiskFactorsRow[];
}

type YesNoNA = "Yes" | "No" | "N/A" | undefined;

function FactorCell({ value }: { value: YesNoNA }) {
  if (!value) return <span style={{ color: "var(--color-text-muted)" }}>—</span>;
  if (value === "Yes") {
    return (
      <span
        className="inline-block rounded-[var(--radius-sm)] px-1.5 py-0.5 text-caption font-medium"
        style={{
          background: "var(--color-status-warning-bg)",
          color: "var(--color-warning-500)",
        }}
      >
        Yes
      </span>
    );
  }
  if (value === "N/A") {
    return (
      <span className="text-caption" style={{ color: "var(--color-text-muted)" }}>
        N/A
      </span>
    );
  }
  return (
    <span className="text-caption" style={{ color: "var(--color-text-secondary)" }}>
      No
    </span>
  );
}

const FACTOR_KEYS: Array<{ key: keyof RiskFactorsRow; i18nKey: string }> = [
  { key: "region", i18nKey: "server.utilities.benchmark.sections.risk_factors.region" },
  { key: "proxy", i18nKey: "server.utilities.benchmark.sections.risk_factors.proxy" },
  { key: "tor", i18nKey: "server.utilities.benchmark.sections.risk_factors.tor" },
  { key: "vpn", i18nKey: "server.utilities.benchmark.sections.risk_factors.vpn" },
  { key: "server", i18nKey: "server.utilities.benchmark.sections.risk_factors.server" },
  { key: "abuser", i18nKey: "server.utilities.benchmark.sections.risk_factors.abuser" },
  { key: "robot", i18nKey: "server.utilities.benchmark.sections.risk_factors.robot" },
];

export function RiskFactorsTable({ rows }: RiskFactorsTableProps) {
  const { t } = useTranslation();

  if (rows.length === 0) return null;

  return (
    <div className="overflow-x-auto w-full">
      <table className="text-mono-sm w-full" style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th
              className="text-caption text-left"
              style={{
                color: "var(--color-text-muted)",
                fontFamily: "inherit",
                fontWeight: "var(--font-weight-medium)",
                padding: "4px 8px 4px 0",
                minWidth: 80,
              }}
            />
            {rows.map((row) => (
              <th
                key={row.source}
                className="text-caption text-center"
                style={{
                  color: "var(--color-text-muted)",
                  fontFamily: "inherit",
                  fontWeight: "var(--font-weight-medium)",
                  padding: "4px 8px",
                  minWidth: 80,
                }}
              >
                {row.source}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {FACTOR_KEYS.map(({ key, i18nKey }) => (
            <tr key={key}>
              <td
                className="text-caption"
                style={{
                  color: "var(--color-text-muted)",
                  padding: "3px 8px 3px 0",
                  verticalAlign: "middle",
                }}
              >
                {t(i18nKey)}
              </td>
              {rows.map((row) => (
                <td
                  key={row.source}
                  className="text-center"
                  style={{ padding: "3px 8px", verticalAlign: "middle" }}
                >
                  {key === "region" ? (
                    <span className="text-mono-sm" style={{ color: "var(--color-text-secondary)" }}>
                      {row.region ? `[${row.region}]` : "—"}
                    </span>
                  ) : (
                    <FactorCell value={row[key] as YesNoNA} />
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
