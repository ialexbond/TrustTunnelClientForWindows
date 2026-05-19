/**
 * IpTypeTable — renders Section 2 (IP Type) from Check.Place output.
 *
 * Multi-source columnar table: sources as columns, database/usage/company as rows.
 * Horizontal scroll on narrow viewport.
 */
import { useTranslation } from "react-i18next";
import type { IpTypeRow } from "./parser";

interface IpTypeTableProps {
  rows: IpTypeRow[];
}

export function IpTypeTable({ rows }: IpTypeTableProps) {
  const { t } = useTranslation();

  if (rows.length === 0) return null;

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
                padding: "4px 8px 4px 0",
                minWidth: 100,
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
                  minWidth: 90,
                }}
              >
                {row.source}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* Database row */}
          {rows.some((r) => r.database) && (
            <tr>
              <td
                className="text-caption"
                style={{ color: "var(--color-text-muted)", padding: "3px 8px 3px 0" }}
              >
                {t("server.utilities.benchmark.sections.ip_type.database")}
              </td>
              {rows.map((row) => (
                <td
                  key={row.source}
                  className="text-center text-mono-sm"
                  style={{ color: "var(--color-text-primary)", padding: "3px 8px" }}
                >
                  {row.database ?? "—"}
                </td>
              ))}
            </tr>
          )}
          {/* Usage row */}
          {rows.some((r) => r.usage) && (
            <tr>
              <td
                className="text-caption"
                style={{ color: "var(--color-text-muted)", padding: "3px 8px 3px 0" }}
              >
                {t("server.utilities.benchmark.sections.ip_type.usage")}
              </td>
              {rows.map((row) => (
                <td
                  key={row.source}
                  className="text-center text-mono-sm"
                  style={{ color: "var(--color-text-primary)", padding: "3px 8px" }}
                >
                  {row.usage ?? "—"}
                </td>
              ))}
            </tr>
          )}
          {/* Company row */}
          {rows.some((r) => r.company) && (
            <tr>
              <td
                className="text-caption"
                style={{ color: "var(--color-text-muted)", padding: "3px 8px 3px 0" }}
              >
                {t("server.utilities.benchmark.sections.ip_type.company")}
              </td>
              {rows.map((row) => (
                <td
                  key={row.source}
                  className="text-center text-mono-sm"
                  style={{ color: "var(--color-text-secondary)", padding: "3px 8px" }}
                >
                  {row.company ?? "—"}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
