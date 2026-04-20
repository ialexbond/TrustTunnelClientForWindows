import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RotateCcw } from "lucide-react";
import { NumberInput } from "../../shared/ui";
import { Button } from "../../shared/ui/Button";
import { useConfirm } from "../../shared/ui/useConfirm";
import type { SecurityState } from "./useSecurityState";

interface SshPortSectionProps {
  state: SecurityState;
}

export function SshPortSection({ state }: SshPortSectionProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [newPort, setNewPort] = useState("");

  const currentPort = state.status?.firewall.current_ssh_port ?? 22;
  const parsed = newPort ? parseInt(newPort, 10) : NaN;
  const isValid = !isNaN(parsed) && parsed >= 1024 && parsed <= 65535 && parsed !== currentPort;

  const handleApply = async () => {
    if (!isValid) return;
    await state.changeSshPort(parsed);
    setNewPort("");
  };

  const handleResetToDefault = async () => {
    const ok = await confirm({
      title: t("server.security.confirm.reset_port_title"),
      message: t("server.security.confirm.reset_port_message"),
      variant: "warning",
    });
    if (!ok) return;
    void state.changeSshPort(22);
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
            disabled={!isValid || state.portBusy || state.loading}
          >
            {t("server.security.ssh_port.apply")}
          </Button>
          {currentPort !== 22 && state.status && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleResetToDefault}
              aria-label={t("server.security.ssh_port.reset")}
            >
              <RotateCcw className="w-3 h-3" />
              <span className="ml-1">{t("server.security.ssh_port.reset")}</span>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
