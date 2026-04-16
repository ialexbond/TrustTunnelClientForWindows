import { Shield, RefreshCw, Loader2, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { Tooltip } from "../../shared/ui/Tooltip";
import type { ServerState } from "./useServerState";
import { useSecurityState } from "./useSecurityState";
import { Fail2banSection } from "./Fail2banSection";
import { FirewallSection } from "./FirewallSection";

interface Props { state: ServerState; }

export function SecuritySection({ state }: Props) {
  const { t } = useTranslation();
  const security = useSecurityState(state.sshParams, state.pushSuccess, state.onPortChanged);

  return (
    <Card>
      <CardHeader
        title={t("server.security.title")}
        icon={<Shield className="w-3.5 h-3.5" />}
        action={
          <div className="flex items-center gap-2">
            <Tooltip text={t("server.security.tooltip")}>
              <Info className="w-3.5 h-3.5 cursor-help" style={{ color: "var(--color-text-muted)" }} />
            </Tooltip>
            <Button variant="ghost" size="sm" icon={<RefreshCw className="w-3 h-3" />} onClick={() => void security.load()} disabled={security.loading}>
              {t("server.security.refresh")}
            </Button>
          </div>
        }
      />

      {security.loading && !security.status && (
        <div className="flex items-center gap-2 text-xs py-3" style={{ color: "var(--color-text-muted)" }}>
          <Loader2 className="w-3 h-3 animate-spin" /> {t("server.security.loading")}
        </div>
      )}

      {security.status && (
        <div className="space-y-4">
          <Fail2banSection status={security.status.fail2ban} state={security} />
          <FirewallSection status={security.status.firewall} state={security} />
        </div>
      )}

      {/* Confirm dialog — shared overlay for all sub-components */}
      <ConfirmDialog
        open={!!security.confirm}
        title={security.confirm?.title ?? ""}
        message={security.confirm?.message ?? ""}
        variant={security.confirm?.variant ?? "danger"}
        confirmLabel={t("buttons.confirm")}
        cancelLabel={t("buttons.cancel")}
        onCancel={() => security.setConfirm(null)}
        onConfirm={() => security.confirm?.onConfirm()}
      />
    </Card>
  );
}
