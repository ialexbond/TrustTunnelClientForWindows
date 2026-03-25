import { useTranslation } from "react-i18next";
import { Globe, Network, Plus, Trash2, HelpCircle } from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Toggle } from "../../shared/ui/Toggle";
import { Button } from "../../shared/ui/Button";
import { Input } from "../../shared/ui/Input";
import { Tooltip } from "../../shared/ui/Tooltip";
import type { SettingsState } from "./useSettingsState";

interface Props {
  state: SettingsState;
}

export function NetworkSection({ state }: Props) {
  const { t } = useTranslation();
  const { config, updateField } = state;
  if (!config) return null;

  const dnsUpstreams = config.dns_upstreams || [];

  return (
    <Card padding="md">
      <CardHeader
        icon={<Globe className="w-4 h-4" />}
        title={t("settings.network.title")}
      />

      {/* IPv6 toggle with tooltip */}
      <Toggle
        value={config.endpoint?.has_ipv6 || false}
        onChange={(v) => updateField("endpoint.has_ipv6", v)}
        label={t("features.ipv6")}
        description={t("help_text.ipv6")}
        icon={<Network className="w-3.5 h-3.5" />}
        labelExtra={
          <Tooltip text={t("tooltips.ipv6_detailed")}>
            <HelpCircle className="w-3 h-3 cursor-help" style={{ color: "var(--color-text-muted)" }} />
          </Tooltip>
        }
      />

      {/* Separator */}
      <div className="my-3" style={{ borderTop: "1px solid var(--color-border)" }} />

      {/* DNS Upstreams */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
            DNS Upstreams
          </span>
          <Tooltip text={t("tooltips.dns_upstreams")}>
            <HelpCircle className="w-3 h-3 cursor-help" style={{ color: "var(--color-text-muted)" }} />
          </Tooltip>
        </div>

        {dnsUpstreams.map((upstream, idx) => (
          <div key={idx} className="flex items-center gap-1.5">
            <Input
              value={upstream}
              onChange={(e) => {
                const arr = [...dnsUpstreams];
                arr[idx] = e.target.value;
                updateField("dns_upstreams", arr);
              }}
              placeholder="8.8.8.8:53 / tls://1.1.1.1 / https://dns.example/dns-query"
              className="!py-1.5 text-xs"
              fullWidth
            />
            <Button
              variant="ghost"
              size="sm"
              icon={<Trash2 className="w-3.5 h-3.5" />}
              onClick={() => {
                const arr = [...dnsUpstreams];
                arr.splice(idx, 1);
                updateField("dns_upstreams", arr);
              }}
              className="shrink-0 self-stretch text-[var(--color-danger-400)] hover:text-[var(--color-danger-500)]"
            />
          </div>
        ))}

        <Button
          variant="ghost"
          size="sm"
          icon={<Plus className="w-3.5 h-3.5" />}
          fullWidth
          onClick={() => updateField("dns_upstreams", [...dnsUpstreams, ""])}
          className="border border-dashed"
          style={{ borderColor: "var(--color-border)" }}
        >
          {t("buttons.add_dns")}
        </Button>
      </div>
    </Card>
  );
}
