import { Wrench, RefreshCw, Loader2, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { Tooltip } from "../../shared/ui/Tooltip";
import type { ServerState } from "./useServerState";
import { useMtProtoState } from "./useMtProtoState";
import { MtProtoSection } from "./MtProtoSection";

interface Props { state: ServerState; }

export function UtilitiesSection({ state }: Props) {
  const { t } = useTranslation();
  const mtproto = useMtProtoState(state.sshParams, state.pushSuccess);

  return (
    <Card>
      <CardHeader
        title={t("server.utilities.title")}
        icon={<Wrench className="w-3.5 h-3.5" />}
        action={
          <div className="flex items-center gap-2">
            <Tooltip text={t("server.utilities.tooltip")}>
              <Info className="w-3.5 h-3.5 cursor-help" style={{ color: "var(--color-text-muted)" }} />
            </Tooltip>
            <Button variant="ghost" size="sm" icon={<RefreshCw className="w-3 h-3" />} onClick={() => void mtproto.load()} disabled={mtproto.loading}>
              {t("server.utilities.refresh")}
            </Button>
          </div>
        }
      />

      {mtproto.loading && !mtproto.status && (
        <div className="flex items-center gap-2 text-xs py-3" style={{ color: "var(--color-text-muted)" }}>
          <Loader2 className="w-3 h-3 animate-spin" /> {t("server.utilities.loading")}
        </div>
      )}

      {mtproto.status && (
        <div className="space-y-4">
          <MtProtoSection state={mtproto} />
        </div>
      )}

      {/* Confirm dialog for uninstall (per D-11) */}
      <ConfirmDialog
        open={!!mtproto.confirm}
        title={mtproto.confirm?.title ?? ""}
        message={mtproto.confirm?.message ?? ""}
        confirmLabel={t("server.utilities.mtproto.uninstall")}
        cancelLabel={t("buttons.cancel")}
        variant="warning"
        onCancel={() => mtproto.setConfirm(null)}
        onConfirm={() => mtproto.confirm?.onConfirm()}
      />
    </Card>
  );
}
