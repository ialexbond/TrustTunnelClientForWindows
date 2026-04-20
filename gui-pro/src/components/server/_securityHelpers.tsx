import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Copy,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { Input } from "../../shared/ui/Input";

// ─── Small helpers shared by Fail2banSection + FirewallSection ────

export function StatusBadge({ state, label }: { state: "on" | "off" | "warn"; label: string }) {
  const map = {
    on: { color: "var(--color-success-500)", bg: "var(--color-success-tint-12)", icon: <CheckCircle2 className="w-3 h-3" /> },
    warn: { color: "var(--color-warning-500)", bg: "var(--color-warning-tint-12)", icon: <AlertTriangle className="w-3 h-3" /> },
    off: { color: "var(--color-text-muted)", bg: "var(--color-bg-hover)", icon: <XCircle className="w-3 h-3" /> },
  }[state];
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-sm)] text-[10px] font-medium" style={{ color: map.color, backgroundColor: map.bg }}>
      {map.icon}{label}
    </span>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: "var(--color-text-muted)" }}>{label}</span>
      <span className="font-mono" style={{ color: "var(--color-text-primary)" }}>{value}</span>
    </div>
  );
}

export function LogArea({ content, loading: isLoading, pushSuccess }: {
  content: string;
  loading: boolean;
  pushSuccess: (msg: string, type?: "success" | "error") => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    if (!content) return;
    navigator.clipboard.writeText(content);
    pushSuccess(t("server.logs.copied"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className="mt-1 rounded-[var(--radius-md)] overflow-hidden relative"
      style={{ border: "1px solid var(--color-border)", backgroundColor: "var(--color-bg-primary)" }}
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--color-text-muted)" }} />
        </div>
      ) : (
        <>
          {content && (
            <button
              onClick={handleCopy}
              className="absolute top-1.5 right-1.5 p-1 rounded-[var(--radius-sm)] transition-colors z-10"
              style={{ backgroundColor: "var(--color-bg-hover)" }}
              title={t("server.logs.copy")}
            >
              {copied
                ? <CheckCircle2 className="w-3 h-3" style={{ color: "var(--color-success-500)" }} />
                : <Copy className="w-3 h-3" style={{ color: "var(--color-text-muted)" }} />}
            </button>
          )}
          <pre
            className="p-2 pr-7 text-[10px] font-mono max-h-48 whitespace-pre-wrap scroll-overlay"
            style={{ color: "var(--color-text-muted)", overflowY: "auto" }}
          >
            {content || "\u2014"}
          </pre>
        </>
      )}
    </div>
  );
}

export function LabeledInput({ label, value, onChange, placeholder, inputMode, maxLength }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputMode?: "text" | "numeric" | "decimal" | "tel" | "search" | "email" | "url" | "none";
  maxLength?: number;
}) {
  const charCount = maxLength ? [...value].length : undefined;
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>{label}</span>
        {maxLength != null && (
          <span
            className="text-[9px] tabular-nums"
            style={{ color: charCount! > maxLength ? "var(--color-danger-500)" : "var(--color-text-muted)" }}
          >
            {charCount}/{maxLength}
          </span>
        )}
      </div>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        className="text-[11px]"
      />
    </div>
  );
}
