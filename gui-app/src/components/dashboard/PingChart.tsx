import { useTranslation } from "react-i18next";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { Activity } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import type { PingPoint } from "./useDashboardState";

interface PingChartProps {
  pingHistory: PingPoint[];
  avgPing: number | null;
  isConnected: boolean;
}

const Y_MAX = 300;

export function PingChart({ pingHistory, avgPing, isConnected }: PingChartProps) {
  const { t } = useTranslation();

  const data = pingHistory
    .filter((p) => p.ping > 0)
    .map((p, i) => ({
      idx: i,
      ping: p.ping,
      pingClamped: Math.min(p.ping, Y_MAX),
    }));

  return (
    <Card padding="md">
      <CardHeader
        title={t("dashboard.ping_history", "Ping")}
        icon={<Activity className="w-4 h-4" />}
        action={
          avgPing !== null ? (
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              {t("dashboard.avg", "avg")}: {avgPing} ms
            </span>
          ) : undefined
        }
      />
      {!isConnected || data.length === 0 ? (
        <div
          className="flex items-center justify-center text-xs py-8"
          style={{ color: "var(--color-text-muted)" }}
        >
          {t("dashboard.no_data", "No data — connect to VPN")}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <XAxis
              dataKey="idx"
              tick={false}
              tickLine={false}
              axisLine={false}
              label={{
                value: t("dashboard.ping_period", "last 10 min"),
                position: "insideBottomRight",
                offset: 0,
                style: { fontSize: 10, fill: "var(--color-text-muted)" },
              }}
            />
            <YAxis
              tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
              tickLine={false}
              axisLine={false}
              width={65}
              tickFormatter={(v) => `${v} ms`}
              domain={[0, Y_MAX]}
              allowDataOverflow
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-bg-elevated)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-md)",
                fontSize: 11,
                color: "var(--color-text-primary)",
              }}
              labelFormatter={() => ""}
              formatter={(_v, _n, props) => {
                const real = props?.payload?.ping;
                return [`${real} ms`, "Ping"];
              }}
            />
            {avgPing !== null && avgPing <= Y_MAX && (
              <ReferenceLine
                y={avgPing}
                stroke="var(--color-accent-400)"
                strokeDasharray="3 3"
                strokeOpacity={0.5}
              />
            )}
            <Line
              type="monotone"
              dataKey="pingClamped"
              stroke="var(--color-success-500)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3, fill: "var(--color-success-500)" }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}
