import { useState } from "react";
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
 * Renders banned IPs list из jail.banned_ips. Каждая строка имеет
 * кнопку «Разбанить» (calls `security_fail2ban_unban`).
 *
 * P UAT 2026-05-04 fixes:
 * - Column headers убраны (бессмысленные «IP» / «Заблокирован»).
 * - Per-row loading state (busyIp set) — кнопка показывает spinner
 *   моментально, IP убирается из UI optimistically.
 *
 * Empty state «Нет заблокированных IP» если list пустой.
 *
 * Per S-02 invariant — frontend re-validates IP перед IPC.
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

  // P UAT 2026-05-04: per-IP busy + optimistic remove. Без этого user
  // нажимает Разбанить → молчание ~2-5s пока backend processes → IP
  // убирается «через тысячу лет» (после reload). Now: instant UI feedback.
  const [busyIp, setBusyIp] = useState<string | null>(null);
  const [optimisticallyRemoved, setOptimisticallyRemoved] = useState<Set<string>>(new Set());

  const bannedIps = (jail?.banned_ips ?? []).filter((entry) => {
    // Filter out optimistically-removed IPs до того как backend reload подтвердит.
    const m = /^(\S+)/.exec(entry);
    const ip = m?.[1] ?? entry;
    return !optimisticallyRemoved.has(ip);
  });

  const handleUnban = async (ip: string) => {
    // S-02 — validate IP перед IPC (frontend mirror of backend re-validation V13).
    const ipErr = validateIp(ip);
    if (ipErr) {
      pushSuccess(t(ipErr), "error");
      return;
    }
    setBusyIp(ip);
    // Optimistic — убираем IP из списка моментально. Если backend fail —
    // вернём через cleanup в catch + state.load() reload.
    setOptimisticallyRemoved((prev) => new Set([...prev, ip]));
    try {
      await invoke("security_fail2ban_unban", {
        ...sshParams,
        jail: jail?.name ?? "sshd",
        ip,
      });
      activityLog("STATE", `fail2ban.unbanned ip=${ip}`);
      pushSuccess(t("server.security.fail2ban.snack.ip_unbanned", { ip }));
      await state.load();
      // Backend confirmed — remove из optimistic set (реальный jail.banned_ips
      // уже не содержит этот IP после reload).
      setOptimisticallyRemoved((prev) => {
        const n = new Set(prev);
        n.delete(ip);
        return n;
      });
    } catch (e) {
      pushSuccess(formatError(e), "error");
      // Rollback optimistic remove — backend не ответил OK.
      setOptimisticallyRemoved((prev) => {
        const n = new Set(prev);
        n.delete(ip);
        return n;
      });
    } finally {
      setBusyIp(null);
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
      {/* P UAT 2026-05-04: column headers «IP» / «Заблокирован» убраны.
          IP виден сам по себе (mono-формат), время бана в muted color
          справа от IP, кнопка-действие в конце строки. */}
      {bannedIps.map((entry, idx) => {
        // Entry formats supported (BUG-13 hardened):
        //   - "1.2.3.4"                  — IP only
        //   - "1.2.3.4 (5min ago)"        — paren-form
        //   - "::1"                       — IPv6 (no spaces)
        //   - "2001:db8::1 (1h ago)"      — IPv6 + time
        //   - "1.2.3.4 5min ago"          — defensive parens-less variant
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
            const m3 = /^(\S+)\s*$/.exec(entry);
            ip = m3?.[1] ?? entry;
          }
        }
        const isBusy = busyIp === ip;
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
              {bannedAt ? formatBanTime(bannedAt, i18n.language) : ""}
            </span>
            <Button
              variant="danger-outline"
              size="sm"
              onClick={() => void handleUnban(ip)}
              loading={isBusy}
              disabled={isBusy}
              icon={!isBusy ? <Trash2 className="w-3.5 h-3.5" /> : undefined}
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
