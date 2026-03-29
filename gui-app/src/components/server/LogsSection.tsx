import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  ScrollText,
  Copy,
  Check,
  ChevronUp,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { formatError } from "../../shared/utils/formatError";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

function colorizeLogLine(line: string): { color: string } {
  const lower = line.toLowerCase();
  if (lower.includes("error") || lower.includes("err]") || lower.includes("fatal") || lower.includes("panic"))
    return { color: "var(--color-danger-500)" };
  if (lower.includes("warn") || lower.includes("warning"))
    return { color: "var(--color-warning-500)" };
  return { color: "var(--color-text-muted)" };
}

export function LogsSection({ state }: Props) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const {
    serverLogs,
    setServerLogs,
    showLogs,
    setShowLogs,
    logsLoading,
    setLogsLoading,
    sshParams,
    setActionResult,
  } = state;

  const logsEndRef = useRef<HTMLPreElement>(null);

  // Auto-scroll to bottom when logs loaded
  useEffect(() => {
    if (showLogs && serverLogs && logsEndRef.current) {
      logsEndRef.current.scrollTop = logsEndRef.current.scrollHeight;
    }
  }, [showLogs, serverLogs]);

  const handleLoadLogs = async () => {
    setShowLogs(true);
    setLogsLoading(true);
    try {
      const logs = await invoke<string>("server_get_logs", sshParams);
      setServerLogs(logs);
    } catch (e) {
      setServerLogs(t("server.logs.error", { error: formatError(e) }));
    } finally {
      setLogsLoading(false);
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(serverLogs);
    state.pushSuccess(t("server.logs.copied"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCollapse = () => {
    setShowLogs(false);
    setServerLogs("");
  };

  return (
    <Card>
      <CardHeader
        title={t("server.logs.title")}
        icon={<ScrollText className="w-3.5 h-3.5" />}
      />

      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<ScrollText className="w-3.5 h-3.5" />}
          loading={logsLoading}
          onClick={handleLoadLogs}
        >
          {showLogs ? t("server.logs.refresh") : t("server.logs.load")}
        </Button>
        {showLogs && serverLogs && (
          <>
            <Button variant="secondary" size="sm" icon={copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} onClick={handleCopy}>
              {t("server.logs.copy")}
            </Button>
            <Button variant="secondary" size="sm" icon={<ChevronUp className="w-3.5 h-3.5" />} onClick={handleCollapse}>
              {t("server.logs.collapse")}
            </Button>
          </>
        )}
      </div>

      <div
        className="overflow-hidden transition-all duration-300 ease-in-out"
        style={{ maxHeight: showLogs ? "240px" : "0px", opacity: showLogs ? 1 : 0, marginTop: showLogs ? "8px" : "0px" }}
      >
        <div className="rounded-[var(--radius-md)] overflow-hidden" style={{ border: "1px solid var(--color-border)" }}>
        <pre
          ref={logsEndRef}
          className="p-3 text-[10px] leading-relaxed overflow-auto max-h-48 whitespace-pre-wrap font-mono"
          style={{
            backgroundColor: "var(--color-bg-primary)",
            paddingRight: "1rem",
          }}
        >
          {logsLoading ? (
            <span style={{ color: "var(--color-text-muted)" }}>{t("server.logs.loading")}</span>
          ) : serverLogs ? (
            serverLogs.split("\n").map((line, i) => (
              <span key={i} style={colorizeLogLine(line)}>{line}{"\n"}</span>
            ))
          ) : (
            <span style={{ color: "var(--color-text-muted)" }}>{t("server.logs.no_data")}</span>
          )}
        </pre>
        </div>
      </div>
    </Card>
  );
}
