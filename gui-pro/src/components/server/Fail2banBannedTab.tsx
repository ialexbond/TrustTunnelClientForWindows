import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Trash2 } from "lucide-react";
import { validateIp, type SecurityState, type SshParams } from "./useSecurityState";
import { Button } from "../../shared/ui/Button";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";

/**
 * Phase 16 Plan 04 — Fail2banBannedTab.
 *
 * Renders banned IPs table из jail.banned_ips. Каждая строка имеет
 * кнопку «Разбанить» (calls `security_fail2ban_unban`).
 *
 * Empty state «Нет заблокированных IP» если list пустой.
 *
 * Per S-02 invariant — frontend re-validates IP перед IPC (mirror
 * backend validate_ip). Even though banned IPs приходят сами с сервера,
 * defensive re-validation предотвращает potential injection через
 * malformed parsing output.
 */
interface Fail2banBannedTabProps {
  state: SecurityState;
  jail: { name: string; banned_ips: string[] } | undefined;
  sshParams: SshParams;
}

export function Fail2banBannedTab({
  state,
  jail,
  sshParams,
}: Fail2banBannedTabProps) {
  const { t } = useTranslation();
  const pushSuccess = useSnackBar();
  const { log: activityLog } = useActivityLog();

  const bannedIps = jail?.banned_ips ?? [];

  const handleUnban = async (ip: string) => {
    // S-02 — validate IP перед IPC (frontend mirror of backend re-validation V13).
    const ipErr = validateIp(ip);
    if (ipErr) {
      pushSuccess(t(ipErr), "error");
      return;
    }
    try {
      await invoke("security_fail2ban_unban", {
        ...sshParams,
        jail: jail?.name ?? "sshd",
        ip,
      });
      activityLog("STATE", `fail2ban.unbanned ip=${ip}`);
      pushSuccess(t("server.security.fail2ban.snack.ip_unbanned", { ip }));
      await state.load();
    } catch (e) {
      pushSuccess(formatError(e), "error");
    }
  };

  if (bannedIps.length === 0) {
    return (
      <div
        className="py-6 text-center text-body-sm"
        style={{ color: "var(--color-text-muted)" }}
        data-testid="banned-empty"
      >
        {t("server.security.fail2ban.banned_empty")}
      </div>
    );
  }

  return (
    <div className="space-y-1" data-testid="banned-list">
      <div
        className="grid items-center gap-2 px-3 py-2 text-caption"
        style={{
          gridTemplateColumns: "minmax(0,1fr) auto auto",
          color: "var(--color-text-muted)",
        }}
      >
        <span>{t("server.security.fail2ban.banned_ip_label")}</span>
        <span>{t("server.security.fail2ban.banned_at_label")}</span>
        <span></span>
      </div>
      {bannedIps.map((entry, idx) => {
        // Entry format: "1.2.3.4" OR "1.2.3.4 (5min ago)" — split safely.
        const match = /^(\S+)(?:\s+\((.+)\))?$/.exec(entry);
        const ip = match?.[1] ?? entry;
        const bannedAt = match?.[2] ?? "";
        return (
          <div
            key={`${ip}-${idx}`}
            className="grid items-center gap-2 px-3 py-2 rounded-[var(--radius-sm)] hover:bg-[var(--color-bg-hover)]"
            style={{ gridTemplateColumns: "minmax(0,1fr) auto auto" }}
            data-testid={`banned-row-${idx}`}
          >
            <code className="text-mono-sm">{ip}</code>
            <span
              className="text-caption"
              style={{ color: "var(--color-text-muted)" }}
            >
              {bannedAt}
            </span>
            <Button
              variant="danger-outline"
              size="sm"
              onClick={() => void handleUnban(ip)}
              icon={<Trash2 className="w-3.5 h-3.5" />}
              data-testid={`unban-button-${idx}`}
            >
              {t("server.security.fail2ban.banned_unban_button")}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
