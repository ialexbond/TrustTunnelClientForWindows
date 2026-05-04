import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Trash2 } from "lucide-react";
import { validateIp, type SecurityState, type SshParams } from "./useSecurityState";
import { Button } from "../../shared/ui/Button";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";
import { formatBanTime } from "./fail2banUtils";

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
  const { t, i18n } = useTranslation();
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
        // Entry formats supported (BUG-13 hardened):
        //   - "1.2.3.4"                  — IP only (older fail2ban output)
        //   - "1.2.3.4 (5min ago)"        — fail2ban-client status sshd с ban times block
        //   - "::1"                       — IPv6 (no spaces, captured as IP)
        //   - "2001:db8::1 (1h ago)"      — IPv6 + ban time
        //   - "1.2.3.4 5min ago"          — defensive: parens-less variant from older versions
        // Two regex tries: paren-form first, then bare ip+time fallback.
        let ip = entry;
        let bannedAt = "";
        const m1 = /^(\S+)\s+\(([^)]+)\)\s*$/.exec(entry);
        if (m1) {
          ip = m1[1];
          bannedAt = m1[2];
        } else {
          const m2 = /^(\S+)\s+(\d+\s*(?:s|sec|seconds|m|min|minutes|h|hr|hours|d|day|days|w|wk|weeks|y|yr|years)(?:\s+ago)?)\s*$/i.exec(entry);
          if (m2) {
            ip = m2[1];
            bannedAt = m2[2];
          } else {
            // Fallback: just IP, no time component.
            const m3 = /^(\S+)\s*$/.exec(entry);
            ip = m3?.[1] ?? entry;
          }
        }
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
              {/* P0+ #localization — Fail2Ban backend возвращает «5min ago»
                  на английском (fail2ban-client output). Парсим и
                  локализуем через formatBanTime → «5 минут назад» в RU. */}
              {bannedAt ? formatBanTime(bannedAt, i18n.language) : ""}
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
