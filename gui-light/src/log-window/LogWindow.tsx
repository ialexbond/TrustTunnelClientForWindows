import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import type { LogEntry } from "../shared/types";
import { useLogWindowSource } from "./useLogWindowSource";

// Dev-only aggregated log viewer (T-14).
//
// Replaces the F12 DevTools need (F12 stays disabled per D-11): it surfaces the
// SAME already-sanitized `vpn-log` stream that the main window's Log panel uses
// (frontend + Rust backend + sidecar all funnel through it), in a separate
// window, with level filtering, search, copy-to-clipboard and export-to-file.
//
// This window is only ever created by the `#[cfg(feature = "devtools")]`-gated
// `open_log_window` Rust command, so it is provably absent from a public build.
// D-29: the only log source is the sanitized `vpn-log` channel (see
// useLogWindowSource / LOG_WINDOW_SOURCE_EVENT) — no raw channel is opened.

const LOG_LEVELS = ["all", "error", "warn", "info", "debug", "trace"] as const;

// Level hierarchy for the "show this level and above" filter (matches LogPanel).
const LEVEL_HIERARCHY = ["trace", "debug", "info", "warn", "error"] as const;

const LEVEL_COLOR: Record<string, string> = {
  error: "var(--color-danger-500)",
  warn: "var(--color-warning-500)",
  info: "var(--color-success-500)",
  debug: "var(--color-accent-400)",
  trace: "var(--color-text-muted)",
};

function formatBuffer(entries: LogEntry[]): string {
  return entries
    .map((l) => `${l.timestamp} [${l.level.toUpperCase()}] ${l.message}`)
    .join("\n");
}

export function LogWindow() {
  const { logs, clear } = useLogWindowSource();
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return logs.filter((log) => {
      if (levelFilter !== "all") {
        const filterIdx = LEVEL_HIERARCHY.indexOf(
          levelFilter as (typeof LEVEL_HIERARCHY)[number],
        );
        const logIdx = LEVEL_HIERARCHY.indexOf(
          log.level as (typeof LEVEL_HIERARCHY)[number],
        );
        if (logIdx < filterIdx) return false;
      }
      if (q && !log.message.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [logs, levelFilter, search]);

  // Auto-scroll to the newest line as logs stream in.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered]);

  // Copy the VISIBLE (filtered) buffer to the clipboard. Same buffer the
  // viewer renders — no separate/raw source (D-29).
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(formatBuffer(filtered)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [filtered]);

  // Export the VISIBLE (filtered) buffer to a .log file via an in-webview Blob
  // download. Uses the SAME formatBuffer(filtered) source as copy — the export
  // adds no extra/raw source (D-29). A Blob+anchor download avoids pulling in a
  // new fs plugin dependency (Package Legitimacy Gate: no new packages).
  const handleExport = useCallback(() => {
    const blob = new Blob([formatBuffer(filtered)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.download = `trusttunnel-logs-${stamp}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered]);

  return (
    <div
      className="flex flex-col h-screen"
      style={{ backgroundColor: "var(--color-bg-base)", color: "var(--color-text-primary)" }}
    >
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 px-3 py-2 shrink-0"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <select
          aria-label="Уровень логов"
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value)}
          className="h-7 rounded text-xs px-2 outline-none"
          style={{
            backgroundColor: "var(--color-input-bg)",
            border: "1px solid var(--color-input-border)",
            color: "var(--color-text-primary)",
          }}
        >
          {LOG_LEVELS.map((lvl) => (
            <option key={lvl} value={lvl}>
              {lvl === "all" ? "Все" : lvl.toUpperCase()}
            </option>
          ))}
        </select>

        <input
          aria-label="Поиск по логам"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск..."
          className="flex-1 h-7 rounded text-xs px-2 outline-none"
          style={{
            backgroundColor: "var(--color-input-bg)",
            border: "1px solid var(--color-input-border)",
            color: "var(--color-text-primary)",
          }}
        />

        <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
          {filtered.length}/{logs.length}
        </span>

        <button
          type="button"
          onClick={handleCopy}
          disabled={filtered.length === 0}
          className="h-7 px-2.5 rounded text-xs disabled:opacity-50"
          style={{ backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-primary)" }}
        >
          {copied ? "Скопировано" : "Копировать"}
        </button>
        <button
          type="button"
          onClick={handleExport}
          disabled={filtered.length === 0}
          className="h-7 px-2.5 rounded text-xs disabled:opacity-50"
          style={{ backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-primary)" }}
        >
          Экспорт
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={logs.length === 0}
          className="h-7 px-2.5 rounded text-xs disabled:opacity-50"
          style={{ backgroundColor: "var(--color-bg-hover)", color: "var(--color-text-primary)" }}
        >
          Очистить
        </button>
      </div>

      {/* Log lines — `select-text` so the user can manually select/copy a slice */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto font-mono text-xs px-3 py-2 space-y-0.5 select-text"
      >
        {filtered.length === 0 ? (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: "var(--color-text-muted)" }}
          >
            Логи появятся здесь
          </div>
        ) : (
          filtered.map((log, i) => (
            <div key={i} className="flex gap-2">
              <span className="shrink-0" style={{ color: "var(--color-text-muted)" }}>
                {log.timestamp}
              </span>
              <span
                className="shrink-0 w-12 text-right"
                style={{ color: LEVEL_COLOR[log.level] ?? "var(--color-text-muted)" }}
              >
                {log.level.toUpperCase()}
              </span>
              <span className="break-all" style={{ color: "var(--color-text-secondary)" }}>
                {log.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default LogWindow;
