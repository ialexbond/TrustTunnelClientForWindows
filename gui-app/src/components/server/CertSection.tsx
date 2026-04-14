import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  ShieldCheck,
  Info,
  RefreshCw,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Badge } from "../../shared/ui/Badge";
import { Tooltip } from "../../shared/ui/Tooltip";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
import { formatError } from "../../shared/utils/formatError";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

interface CertInfo {
  certType: "self_signed" | "lets_encrypt" | "unknown";
  domain: string;
  notAfter: string;
  autoRenew: boolean;
}

interface CertInfoResponse {
  hostname?: string;
  certPath?: string;
  notAfter?: string;
  issuer?: string;
  subject?: string;
  autoRenew?: boolean;
}

function parseCertInfo(data: unknown): CertInfo {
  const result: CertInfo = {
    certType: "unknown",
    domain: "",
    notAfter: "",
    autoRenew: false,
  };

  let parsed: unknown = data;
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data);
    } catch {
      const str = data as string;
      const typeMatch = str.match(/type\s*[:=]\s*"?([^"\n]+)"?/i);
      if (typeMatch) {
        const val = typeMatch[1].trim().toLowerCase();
        if (val.includes("let") || val.includes("acme")) result.certType = "lets_encrypt";
        else if (val.includes("self")) result.certType = "self_signed";
      }
      const domainMatch = str.match(/domain\s*[:=]\s*"?([^"\n]+)"?/i);
      if (domainMatch) result.domain = domainMatch[1].trim();
      const expiryMatch = str.match(/not_?after\s*[:=]\s*"?([^"\n]+)"?/i);
      if (expiryMatch) result.notAfter = expiryMatch[1].trim();
      const renewMatch = str.match(/auto_?renew\s*[:=]\s*(true|false)/i);
      if (renewMatch) result.autoRenew = renewMatch[1].toLowerCase() === "true";
      return result;
    }
  }

  if (parsed && typeof parsed === "object") {
    const obj = parsed as CertInfoResponse;
    const issuer = (obj.issuer || "").toLowerCase();
    const subject = (obj.subject || "").toLowerCase();
    if (issuer.includes("let's encrypt") || issuer.includes("acme") || issuer.includes("letsencrypt") || issuer.includes("r3") || issuer.includes("r10") || issuer.includes("r11")) {
      result.certType = "lets_encrypt";
    } else if (
      issuer.includes("self") ||
      (!obj.issuer && obj.hostname) ||
      // Self-signed: issuer equals subject
      (issuer && subject && issuer === subject)
    ) {
      result.certType = "self_signed";
    }
    result.domain = obj.hostname || obj.subject?.replace(/^CN\s*=\s*/, "") || "";
    result.notAfter = obj.notAfter || "";
    result.autoRenew = obj.autoRenew ?? false;
  }

  return result;
}

function daysUntil(dateStr: string): number | null {
  try {
    const target = new Date(dateStr);
    if (isNaN(target.getTime())) return null;
    const now = new Date();
    const diff = target.getTime() - now.getTime();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  } catch {
    return null;
  }
}

function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const lastDigit = abs % 10;
  if (abs >= 11 && abs <= 19) return `${n} ${many}`;
  if (lastDigit === 1) return `${n} ${one}`;
  if (lastDigit >= 2 && lastDigit <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}

function formatDaysHuman(totalDays: number, lang: string): string {
  if (totalDays <= 0) return lang === "ru" ? "Истёк" : "Expired";

  const years = Math.floor(totalDays / 365);
  const months = Math.floor((totalDays % 365) / 30);
  const days = totalDays % 30;

  if (lang === "ru") {
    const parts: string[] = [];
    if (years > 0) parts.push(pluralRu(years, "год", "года", "лет"));
    if (months > 0) parts.push(pluralRu(months, "месяц", "месяца", "месяцев"));
    if (days > 0 && years === 0) parts.push(pluralRu(days, "день", "дня", "дней"));
    if (parts.length === 0) parts.push(pluralRu(totalDays, "день", "дня", "дней"));
    return parts.join(" ");
  }

  // English
  const parts: string[] = [];
  if (years > 0) parts.push(`${years}y`);
  if (months > 0) parts.push(`${months}mo`);
  if (days > 0 && years === 0) parts.push(`${days}d`);
  if (parts.length === 0) parts.push(`${totalDays}d`);
  return parts.join(" ");
}

export function CertSection({ state }: Props) {
  const { t, i18n } = useTranslation();
  const { sshParams, certRaw: preloadedCert, setCertRaw: setPreloadedCert } = state;

  const [renewLoading, setRenewLoading] = useState(false);
  const [_renewStatus, setRenewStatus] = useState<string>("");
  const [confirmRenew, setConfirmRenew] = useState(false);

  const certInfo = preloadedCert ? parseCertInfo(preloadedCert) : null;

  const loadCert = async () => {
    try {
      const raw = await invoke<unknown>("server_get_cert_info", sshParams);
      setPreloadedCert(raw);
    } catch (e) {
      state.pushSuccess(formatError(e), "error");
    }
  };

  const handleRenew = async () => {
    setConfirmRenew(false);
    setRenewLoading(true);
    setRenewStatus(t("server.cert.renew_progress_connecting"));
    let succeeded = false;
    try {
      setRenewStatus(t("server.cert.renew_progress_renewing"));
      await invoke("server_renew_cert", sshParams);
      succeeded = true;
    } catch (e) {
      const raw = formatError(e);
      // Translate cryptic backend codes to human-readable messages
      let msg: string;
      if (raw.includes("CERT_RENEW_FAILED|1")) {
        msg = t("server.cert.error_certbot_failed");
      } else if (raw.includes("CERT_RENEW_FAILED|2") || raw.includes("CERT_RENEW_FAILED|124")) {
        // Exit code 2 = certbot error (often rate limit); 124 = timeout killed by `timeout` command
        msg = t("server.cert.error_rate_limit");
      } else {
        msg = t("server.cert.error_generic", { detail: raw });
      }
      state.pushSuccess(msg, "error");
    } finally {
      // Always reload cert info — even if certbot returned an error (e.g. rate limit),
      // the cert file may have been updated by a previous successful run + our copy logic.
      setRenewStatus(t("server.cert.renew_progress_reloading"));
      await new Promise(r => setTimeout(r, 2000));
      await loadCert();
      setRenewStatus("");
      setRenewLoading(false);
      if (succeeded) state.pushSuccess(t("server.cert.renewed"));
    }
  };

  const daysLeft = certInfo?.notAfter ? daysUntil(certInfo.notAfter) : null;

  const certTypeBadge = (type: CertInfo["certType"]) => {
    switch (type) {
      case "lets_encrypt":
        return <Badge variant="success" size="sm">Let's Encrypt</Badge>;
      case "self_signed":
        return <Badge variant="warning" size="sm">{t("server.cert.self_signed")}</Badge>;
      default:
        return <Badge variant="neutral" size="sm">{t("server.cert.unknown")}</Badge>;
    }
  };

  if (!certInfo) return null;

  return (
    <Card>
      <CardHeader
        title={t("server.cert.title")}
        icon={<ShieldCheck className="w-3.5 h-3.5" />}
        action={
          <Tooltip text={t("server.cert.tooltip")}>
            <Info className="w-3.5 h-3.5 cursor-help" style={{ color: "var(--color-text-muted)" }} />
          </Tooltip>
        }
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-[11px]" style={{ color: "var(--color-text-secondary)" }}>{t("server.cert.type")}</span>
          {certTypeBadge(certInfo.certType)}
        </div>

        {certInfo.domain && (
          <div className="flex items-center justify-between">
            <span className="text-[11px]" style={{ color: "var(--color-text-secondary)" }}>{t("server.cert.domain")}</span>
            <Badge
              variant={certInfo.certType === "lets_encrypt" ? "success" : certInfo.certType === "self_signed" ? "warning" : "neutral"}
              size="sm"
            >
              {certInfo.domain}
            </Badge>
          </div>
        )}

        {certInfo.notAfter && (
          <div className="flex items-center justify-between">
            <span className="text-[11px]" style={{ color: "var(--color-text-secondary)" }}>{t("server.cert.expires")}</span>
            <div className="flex items-center gap-2">
              {daysLeft !== null && (
                <Badge
                  variant={daysLeft <= 7 ? "danger" : daysLeft <= 30 ? "warning" : "success"}
                  size="sm"
                >
                  {formatDaysHuman(daysLeft, i18n.language)}
                </Badge>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-[11px]" style={{ color: "var(--color-text-secondary)" }}>{t("server.cert.auto_renew")}</span>
          <Badge variant={certInfo.autoRenew ? "success" : "neutral"} size="sm">
            {certInfo.autoRenew ? t("server.cert.configured") : t("server.cert.not_configured")}
          </Badge>
        </div>

        {certInfo.certType === "lets_encrypt" && (
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            loading={renewLoading}
            disabled={renewLoading}
            onClick={() => setConfirmRenew(true)}
          >
            {t("server.cert.renew")}
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmRenew}
        title={t("server.cert.renew")}
        message={t("server.cert.renew_confirm_message")}
        confirmLabel={t("server.cert.renew")}
        cancelLabel={t("buttons.cancel")}
        variant="warning"
        onCancel={() => setConfirmRenew(false)}
        onConfirm={handleRenew}
        loading={renewLoading}
      />
    </Card>
  );
}
