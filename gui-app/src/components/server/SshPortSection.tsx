import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { NumberInput } from "../../shared/ui";
import { Button } from "../../shared/ui/Button";
import type { SecurityState } from "./useSecurityState";

interface SshPortSectionProps {
  state: SecurityState;
}

export function SshPortSection({ state }: SshPortSectionProps) {
  const { t } = useTranslation();
  const [newPort, setNewPort] = useState("");

  const currentPort = state.status?.firewall.current_ssh_port ?? 22;
  const parsed = newPort ? parseInt(newPort, 10) : NaN;
  const isValid = !isNaN(parsed) && parsed >= 1024 && parsed <= 65535 && parsed !== currentPort;

  const handleApply = () => {
    if (!isValid) return;
    void state.changeSshPort(parsed);
    setNewPort("");
  };

  return (
    <div className="pt-3 border-t space-y-2" style={{ borderColor: "var(--color-border)" }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold" style={{ color: "var(--color-text-primary)" }}>
          {t("server.security.ssh_port.title")}
        </span>
        <span className="text-[10px] font-mono" style={{ color: "var(--color-text-muted)" }}>
          {t("server.security.ssh_port.current", { port: currentPort })}
        </span>
      </div>

      {state.portBusy ? (
        <div className="flex items-center gap-2 py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--color-accent-500)" }} />
          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {t("server.security.ssh_port.changing")}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <NumberInput
              value={newPort}
              onChange={setNewPort}
              min={1024}
              max={65535}
              placeholder={t("server.security.ssh_port.range_hint")}
              disabled={state.portBusy}
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={handleApply}
            disabled={!isValid || state.portBusy}
          >
            {t("server.security.ssh_port.apply")}
          </Button>
        </div>
      )}
    </div>
  );
}
