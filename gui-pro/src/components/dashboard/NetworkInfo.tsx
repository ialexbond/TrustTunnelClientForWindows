import { useTranslation } from "react-i18next";
import { Network, Shield, Zap, Globe, Ruler } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Badge } from "../../shared/ui/Badge";
import type { ClientConfig } from "../settings/useSettingsState";

interface NetworkInfoProps {
  clientConfig: ClientConfig | null;
}

export function NetworkInfo({ clientConfig }: NetworkInfoProps) {
  const { t } = useTranslation();

  if (!clientConfig) {
    return (
      <Card padding="md">
        <CardHeader
          title={t("dashboard.network", "Network")}
          icon={<Network className="w-4 h-4" />}
        />
        <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>
          {t("dashboard.no_config", "No configuration loaded")}
        </div>
      </Card>
    );
  }

  const mtu = clientConfig.listener?.tun?.mtu_size || 1280;
  const killswitch = clientConfig.killswitch_enabled;
  const antiDpi = clientConfig.endpoint?.anti_dpi;
  const ipv6 = clientConfig.endpoint?.has_ipv6;
  const postQuantum = clientConfig.post_quantum_group_enabled;
  const dns = clientConfig.dns_upstreams;
  const hasDns = dns && dns.length > 0;

  const items = [
    {
      icon: <Ruler className="w-3.5 h-3.5" />,
      label: "MTU",
      value: String(mtu),
    },
    {
      icon: <Shield className="w-3.5 h-3.5" />,
      label: t("features.kill_switch"),
      badge: killswitch,
    },
    {
      icon: <Zap className="w-3.5 h-3.5" />,
      label: t("features.anti_dpi"),
      badge: antiDpi,
    },
    {
      icon: <Globe className="w-3.5 h-3.5" />,
      label: t("features.ipv6"),
      badge: ipv6,
    },
    {
      icon: <Shield className="w-3.5 h-3.5" />,
      label: t("features.post_quantum"),
      badge: postQuantum,
    },
  ];

  return (
    <Card padding="md">
      <CardHeader
        title={t("dashboard.network", "Network")}
        icon={<Network className="w-4 h-4" />}
      />
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {items.map((item) => (
          <div key={item.label} className="flex items-center gap-1.5 text-xs">
            <span style={{ color: "var(--color-text-muted)" }}>{item.icon}</span>
            <span style={{ color: "var(--color-text-muted)" }}>{item.label}:</span>
            {"badge" in item ? (
              <Badge variant={item.badge ? "success" : "default"} size="sm">
                {item.badge ? "ON" : "OFF"}
              </Badge>
            ) : (
              <span className="font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
                {item.value}
              </span>
            )}
          </div>
        ))}
        {hasDns && (
          <div className="flex items-center gap-1.5 text-xs">
            <span style={{ color: "var(--color-text-muted)" }}>DNS:</span>
            <span className="font-[var(--font-weight-semibold)]" style={{ color: "var(--color-text-primary)" }}>
              {dns!.length} {dns!.length === 1 ? "server" : "servers"}
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}
