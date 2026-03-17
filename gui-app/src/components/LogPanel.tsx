import { useRef, useEffect } from "react";
import { Terminal, Trash2 } from "lucide-react";
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
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className={`glass-card p-5 flex flex-col min-h-0 ${fullWidth ? "" : "lg:col-span-2"}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-indigo-400" />
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">
            Логи
          </h2>
          <span className="text-[10px] bg-white/5 px-2 py-0.5 rounded-full text-gray-500">
            {logs.length}
          </span>
        </div>
        <button
          onClick={onClear}
          className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-gray-500 hover:text-gray-300"
          title="Очистить логи"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto font-mono text-xs space-y-0.5 min-h-0
                   scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
      >
        {logs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-600">
            Логи появятся после подключения...
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
