/**
 * IpTypeTable — renders Section 2 (IP Type) from Check.Place output.
 *
 * Pivoted layout (sources as rows, fields as columns) — fits narrow Modal viewport
 * unlike the original sources-as-columns orientation, which truncated 5th column.
 */
import { useTranslation } from "react-i18next";
import type { IpTypeRow } from "./parser";

interface IpTypeTableProps {
  rows: IpTypeRow[];
}

export function IpTypeTable({ rows }: IpTypeTableProps) {
  const { t } = useTranslation();

  if (rows.length === 0) return null;

  const hasDatabase = rows.some((r) => r.database);
  const hasUsage = rows.some((r) => r.usage);
  const hasCompany = rows.some((r) => r.company);

  return (
    <div className="overflow-x-auto">
      <table className="text-mono-sm w-full" style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th
              className="text-caption text-left"
              style={{
                color: "var(--color-text-muted)",
                fontFamily: "inherit",
                fontWeight: "var(--font-weight-medium)",
                padding: "4px 12px 4px 0",
                minWidth: 110,
              }}
            />
            {hasDatabase && (
              <th
                className="text-caption text-left"
                style={{
                  color: "var(--color-text-muted)",
                  fontFamily: "inherit",
                  fontWeight: "var(--font-weight-medium)",
                  padding: "4px 12px",
                  minWidth: 100,
                }}
              >
                {t("server.utilities.benchmark.sections.ip_type.database")}
              </th>
            )}
            {hasUsage && (
              <th
                className="text-caption text-left"
                style={{
                  color: "var(--color-text-muted)",
                  fontFamily: "inherit",
                  fontWeight: "var(--font-weight-medium)",
                  padding: "4px 12px",
                  minWidth: 100,
                }}
              >
                {t("server.utilities.benchmark.sections.ip_type.usage")}
              </th>
            )}
            {hasCompany && (
              <th
                className="text-caption text-left"
                style={{
                  color: "var(--color-text-muted)",
                  fontFamily: "inherit",
                  fontWeight: "var(--font-weight-medium)",
                  padding: "4px 12px",
                  minWidth: 100,
                }}
              >
                {t("server.utilities.benchmark.sections.ip_type.company")}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.source}>
              <td
                className="text-caption"
                style={{
                  color: "var(--color-text-muted)",
                  padding: "3px 12px 3px 0",
                  whiteSpace: "nowrap",
                }}
              >
                {row.source}
              </td>
              {hasDatabase && (
                <td
                  className="text-mono-sm"
                  style={{ color: "var(--color-text-primary)", padding: "3px 12px" }}
                >
                  {row.database ?? "—"}
                </td>
              )}
              {hasUsage && (
                <td
                  className="text-mono-sm"
                  style={{ color: "var(--color-text-primary)", padding: "3px 12px" }}
                >
                  {row.usage ?? "—"}
                </td>
              )}
              {hasCompany && (
                <td
                  className="text-mono-sm"
                  style={{ color: "var(--color-text-secondary)", padding: "3px 12px" }}
                >
                  {row.company ?? "—"}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
