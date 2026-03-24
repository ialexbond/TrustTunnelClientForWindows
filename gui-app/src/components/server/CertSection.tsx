import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  ShieldCheck,
  Info,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { Badge } from "../../shared/ui/Badge";
import { Tooltip } from "../../shared/ui/Tooltip";
import { ConfirmDialog } from "../../shared/ui/ConfirmDialog";
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
    if (issuer.includes("let's encrypt") || issuer.includes("acme") || issuer.includes("letsencrypt")) {
      result.certType = "lets_encrypt";
    } else if (issuer.includes("self") || (!obj.issuer && obj.hostname)) {
      result.certType = "self_signed";
    }
    result.domain = obj.hostname || obj.subject?.replace(/^CN=/, "") || "";
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

export function CertSection({ state }: Props) {
  const { t } = useTranslation();
  const { sshParams, setActionResult } = state;

  const [certInfo, setCertInfo] = useState<CertInfo | null>(null);
  const [certLoading, setCertLoading] = useState(true);
  const [certError, setCertError] = useState("");
  const [renewLoading, setRenewLoading] = useState(false);
  const [renewStatus, setRenewStatus] = useState<string>("");
  const [confirmRenew, setConfirmRenew] = useState(false);

  const loadCert = async () => {
    setCertLoading(true);
    setCertError("");
    try {
      const raw = await invoke<unknown>("server_get_cert_info", sshParams);
      setCertInfo(parseCertInfo(raw));
    } catch (e) {
      setCertError(String(e));
      setCertInfo(null);
    } finally {
      setCertLoading(false);
    }
  };

  // Auto-load on mount
  useEffect(() => {
    loadCert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRenew = async () => {
    setConfirmRenew(false);
    setRenewLoading(true);
    setRenewStatus(t("server.cert.renew_progress_connecting"));
    try {
      setRenewStatus(t("server.cert.renew_progress_renewing"));
      await invoke("server_renew_cert", sshParams);
      setRenewStatus(t("server.cert.renew_progress_done"));
      setActionResult({ type: "ok", message: t("server.cert.renewed") });
      await loadCert();
    } catch (e) {
      setRenewStatus("");
      setActionResult({ type: "error", message: String(e) });
    } finally {
      setRenewLoading(false);
      setTimeout(() => setRenewStatus(""), 3000);
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
        return <Badge variant="default" size="sm">{t("server.cert.unknown")}</Badge>;
    }
  };

  if (certLoading) {
    return (
      <Card>
        <CardHeader title={t("server.cert.title")} icon={<ShieldCheck className="w-3.5 h-3.5" />} />
        <div className="flex items-center gap-2 py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: "var(--color-text-muted)" }} />
          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>{t("server.cert.loading")}</span>
        </div>
      </Card>
    );
  }

  if (certError) {
    return (
      <Card>
        <CardHeader title={t("server.cert.title")} icon={<ShieldCheck className="w-3.5 h-3.5" />} />
        <p className="text-[11px]" style={{ color: "var(--color-danger-500)" }}>{certError}</p>
        <Button variant="secondary" size="sm" onClick={loadCert} className="mt-2">{t("server.actions.retry")}</Button>
      </Card>
    );
  }

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
            <code
              className="text-[11px] px-1.5 py-0.5 rounded-[var(--radius-sm)] font-mono"
              style={{ backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-primary)" }}
            >
              {certInfo.domain}
            </code>
          </div>
        )}

        {certInfo.notAfter && (
          <div className="flex items-center justify-between">
            <span className="text-[11px]" style={{ color: "var(--color-text-secondary)" }}>{t("server.cert.expires")}</span>
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono" style={{ color: "var(--color-text-primary)" }}>{certInfo.notAfter}</span>
              {daysLeft !== null && (
                <Badge
                  variant={daysLeft <= 7 ? "danger" : daysLeft <= 30 ? "warning" : "success"}
                  size="sm"
                >
                  {t("server.cert.days_left", { days: daysLeft })}
                </Badge>
              )}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-[11px]" style={{ color: "var(--color-text-secondary)" }}>{t("server.cert.auto_renew")}</span>
          <Badge variant={certInfo.autoRenew ? "success" : "default"} size="sm">
            {certInfo.autoRenew ? t("server.cert.configured") : t("server.cert.not_configured")}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            loading={renewLoading}
            onClick={() => setConfirmRenew(true)}
          >
            {renewLoading ? t("server.cert.renewing") : t("server.cert.renew")}
          </Button>
          {renewStatus && (
            <span className="text-[10px] animate-pulse" style={{ color: "var(--color-text-muted)" }}>
              {renewStatus}
            </span>
          )}
        </div>
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
