import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, Trash2, Copy, Check } from "lucide-react";
import { Button } from "../shared/ui/Button";
import type { LogEntry } from "../App";

interface LogPanelProps {
  logs: LogEntry[];
  onClear: () => void;
  fullWidth?: boolean;
}

const LEVEL_COLORS: Record<string, string> = {
  error: "text-red-400",
  warn: "text-amber-400",
  info: "text-emerald-400",
  debug: "text-blue-400",
  trace: "text-gray-500",
};

function LogPanel({ logs, onClear, fullWidth }: LogPanelProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const handleCopy = useCallback(() => {
    const text = logs
      .map((l) => `${l.timestamp} [${l.level.toUpperCase()}] ${l.message}`)
      .join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [logs]);

  return (
    <div className={`glass-card p-5 flex flex-col min-h-0 ${fullWidth ? "" : "lg:col-span-2"}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4" style={{ color: "var(--color-accent-400)" }} />
          <h2 className="text-sm font-semibold" style={{ color: "var(--color-text-primary)" }}>
            {t("sections.logs")}
          </h2>
          <span
            className="text-[10px] px-2 py-0.5 rounded-full"
            style={{ backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-muted)" }}
          >
            {logs.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            icon={copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            onClick={handleCopy}
            disabled={logs.length === 0}
          >
            {t("buttons.copy_logs")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Trash2 className="w-3.5 h-3.5" />}
            onClick={onClear}
            disabled={logs.length === 0}
          >
            {t("buttons.clear_logs")}
          </Button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto font-mono text-xs space-y-0.5 min-h-0
                   scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
      >
        {logs.length === 0 ? (
          <div className="flex items-center justify-center h-full" style={{ color: "var(--color-text-muted)" }}>
            {t("messages.logs_appear_on_connect")}
          </div>
        ) : (
          logs.map((log, i) => (
            <div key={i} className="flex gap-2 px-2 py-0.5 hover:bg-white/5 rounded">
              <span className="text-gray-600 shrink-0">{log.timestamp}</span>
              <span
                className={`shrink-0 w-12 text-right ${LEVEL_COLORS[log.level] ?? "text-gray-400"}`}
              >
                {log.level.toUpperCase()}
              </span>
              <span className="text-gray-300 break-all">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default LogPanel;
