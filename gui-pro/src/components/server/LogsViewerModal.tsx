import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import {
  RefreshCw,
  Copy,
  Check,
  Download,
  Search,
} from "lucide-react";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";
import { Input } from "../../shared/ui/Input";
import { Skeleton } from "../../shared/ui/Skeleton";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";
// ─── Module helpers ───────────────────────────────────────────────────────────

function safeHostName(host: string): string {
  return host.replace(/[^a-z0-9]/gi, "_");
}

function tsForFile(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * colorizeLogLine — автоматическая подсветка строк лога.
 *
 * Поддерживаемые уровни:
 *   — error / err] / fatal / panic → --color-danger-500 (красный)
 *   — warn / warning             → --color-warning-500 (жёлтый)
 *   — всё остальное              → --color-text-muted
 *
 * Перенесено из LogsSection.tsx verbatim (D-2.2 — colorizeLogLine preserved).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function colorizeLogLine(line: string): { color: string } {
  const lower = line.toLowerCase();
  if (
    lower.includes("error") ||
    lower.includes("err]") ||
    lower.includes("fatal") ||
    lower.includes("panic")
  )
    return { color: "var(--color-danger-500)" };
  if (lower.includes("warn") || lower.includes("warning"))
    return { color: "var(--color-warning-500)" };
  return { color: "var(--color-text-muted)" };
}

/**
 * renderHighlighted — wrap occurrences of `query` (case-insensitive) inside
 * `line` in a <mark> span tinted with --color-warning-tint-25, preserving the
 * surrounding text. Caller decides whether to call this (when query non-empty).
 */
function renderHighlighted(line: string, query: string): React.ReactNode[] {
  const q = query.trim();
  if (!q) return [line];
  const lower = line.toLowerCase();
  const qLower = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let keyN = 0;
  while (i < line.length) {
    const idx = lower.indexOf(qLower, i);
    if (idx === -1) {
      parts.push(line.slice(i));
      break;
    }
    if (idx > i) parts.push(line.slice(i, idx));
    parts.push(
      <mark
        key={`hl-${keyN++}`}
        style={{
          background: "var(--color-warning-tint-25)",
          color: "inherit",
          borderRadius: 2,
          padding: "0 1px",
        }}
      >
        {line.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
  }
  return parts;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface SshParams {
  host: string;
  port: number;
  user: string;
  password: string;
  keyPath?: string;
  keyData?: string;
}

interface LogsViewerModalProps {
  isOpen: boolean;
  onClose: () => void;
  sshParams: SshParams;
  /** Optional pre-loaded buffer from parent (e.g. useServerState.serverLogs) */
  initialLogs?: string;
  /** Storybook escape hatch — force a specific visual state */
  _forceState?: "loading" | "empty" | "loaded" | "downloading" | "error";
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * LogsViewerModal — Phase 17 Plan 05 (D-2.4).
 *
 * Полноэкранный просмотрщик логов сервера:
 *   — Sticky search input (client-side substring filter, D-2.1)
 *   — Scrollable <pre> с auto-color (D-2.2)
 *   — Manual Refresh button (D-2.3, NO auto-polling)
 *   — Action row: Refresh / Copy / Download / Закрыть (sticky bottom)
 *   — Download via plugin-dialog save() + write_string_to_path (D-2.6)
 *
 * T-03 invariant:
 *   — НИКОГДА не делать `if (!isOpen) return null` перед <Modal>.
 *   — Cleanup через setTimeout(200) — после 200ms exit animation.
 *
 * D-29 invariant:
 *   — sshParams.password НИКОГДА не попадает в activityLog.
 *   — Полный контент serverLogs НИКОГДА не попадает в activityLog.
 *   — Логируем только metadata: host=, lines=, path=.
 */
export function LogsViewerModal({
  isOpen,
  onClose,
  sshParams,
  initialLogs,
  _forceState,
}: LogsViewerModalProps) {
  const { t } = useTranslation();
  const pushSnackBar = useSnackBar();
  const { log: activityLog } = useActivityLog();

  // ─── Local state ───────────────────────────────────────────────────────────
  const [logs, setLogs] = useState<string>(initialLogs ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const preRef = useRef<HTMLPreElement>(null);

  // Apply _forceState for Storybook
  const effectiveLoading = _forceState === "loading" ? true : loading;
  const effectiveDownloading = _forceState === "downloading" ? true : downloading;
  const effectiveError =
    _forceState === "error" ? "SSH connection failed" : error;
  const effectiveLogs =
    _forceState === "empty"
      ? ""
      : _forceState === "loaded" || _forceState === "downloading"
        ? (logs || initialLogs || "")
        : logs;

  // ─── Auto-load on first open (if no initial logs) ─────────────────────────
  // We intentionally only depend on isOpen to trigger the initial load.
  // logs/loading/error are read inside the effect as a guard, not as triggers.
  // handleRefresh is defined inline below (stable reference pattern not needed here).
  const hasInitialLogsRef = { current: !!logs };
  useEffect(() => {
    if (isOpen && !hasInitialLogsRef.current && !_forceState) {
      void handleRefresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // ─── T-03 cleanup (200ms delay, keeps buffer for next open) ───────────────
  useEffect(() => {
    if (isOpen) return;
    const timer = setTimeout(() => {
      setSearchQuery("");
      setCopied(false);
      setError(null);
      // Do NOT clear logs — keep buffer for next open
    }, 200);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // ─── Auto-scroll to bottom after load ─────────────────────────────────────
  useEffect(() => {
    if (logs && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [logs]);

  // ─── Filtered lines (client-side, D-2.1) ──────────────────────────────────
  const filteredLines = useMemo(() => {
    const source = effectiveLogs;
    if (!source) return [];
    if (!searchQuery.trim()) return source.split("\n");
    const q = searchQuery.toLowerCase();
    return source.split("\n").filter((line) => line.toLowerCase().includes(q));
  }, [effectiveLogs, searchQuery]);

  // ─── Handlers ─────────────────────────────────────────────────────────────

  const handleRefresh = async () => {
    setLoading(true);
    setError(null);
    // D-29: лог только metadata (host=), НЕ password и НЕ logs content
    activityLog("USER", `logs.refresh host=${sshParams.host}`);
    try {
      const result = await invoke<string>("server_get_logs", sshParams as unknown as Record<string, unknown>);
      setLogs(result);
      // D-29: лог только строки count, НЕ контент
      activityLog(
        "STATE",
        `logs.loaded host=${sshParams.host} lines=${result.split("\n").length}`,
      );
    } catch (e) {
      const msg = formatError(e);
      setError(msg);
      activityLog("ERROR", `logs.failed host=${sshParams.host} err=${msg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(logs);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // D-29: лог только host, НЕ содержимое logs
    activityLog("USER", `logs.copied host=${sshParams.host}`);
  };

  const handleDownload = async () => {
    setDownloading(true);
    // D-29: лог только host (filename may contain host, but not logs body)
    activityLog("USER", `logs.download_initiated host=${sshParams.host}`);
    try {
      const filename = `trusttunnel-logs-${safeHostName(sshParams.host)}-${tsForFile()}.txt`;
      const dest = await save({
        defaultPath: filename,
        filters: [{ name: "Plain Text", extensions: ["txt"] }],
      });
      if (!dest) {
        setDownloading(false);
        return; // user cancelled
      }
      await invoke("write_string_to_path", { content: logs, destination: dest });
      // D-29: лог только path (не содержимое)
      activityLog("STATE", `logs.downloaded host=${sshParams.host} path=${dest}`);
      pushSnackBar(t("server.logs.modal.download_success", { path: dest }));
    } catch (e) {
      const msg = formatError(e);
      activityLog("ERROR", `logs.download_failed err=${msg}`);
      pushSnackBar(msg, "error");
    } finally {
      setDownloading(false);
    }
  };

  // ─── Render (T-03: NEVER return null before <Modal>) ──────────────────────
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="lg">
      <div className="flex flex-col gap-3">
        {/* Title */}
        <h2 className="text-title mb-1">{t("server.logs.modal.title")}</h2>

        {/* Search input (no sticky — Modal content fits without internal sticking) */}
        <div className="pb-1">
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("server.logs.modal.search_placeholder")}
            icon={<Search className="w-3.5 h-3.5" />}
            clearable
            aria-label={t("server.logs.modal.search_placeholder")}
          />
          {searchQuery && (
            <p
              className="text-caption mt-1"
              style={{ color: "var(--color-text-muted)" }}
            >
              {t("server.logs.modal.match_count", { count: filteredLines.length })}
            </p>
          )}
          {/* Hint footer */}
          <p
            className="text-caption mt-1"
            style={{ color: "var(--color-text-muted)" }}
          >
            {t("server.logs.modal.hint_filter")}
          </p>
        </div>

        {/* Scrollable log area */}
        <div
          className="overflow-auto rounded-[var(--radius-md)]"
          style={{
            maxHeight: "60vh",
            border: "1px solid var(--color-border)",
            background: "var(--color-bg-primary)",
          }}
        >
          {effectiveLoading && (
            <div className="p-3 flex flex-col gap-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          )}
          {!effectiveLoading && effectiveError && (
            <p
              className="p-3 text-body-sm"
              style={{ color: "var(--color-status-error)" }}
            >
              {effectiveError}
            </p>
          )}
          {!effectiveLoading && !effectiveError && filteredLines.length === 0 && (
            <p
              className="p-3 text-caption"
              style={{ color: "var(--color-text-muted)" }}
            >
              {effectiveLogs
                ? t("server.logs.modal.no_matches")
                : t("server.logs.modal.no_data")}
            </p>
          )}
          {!effectiveLoading && !effectiveError && filteredLines.length > 0 && (
            <pre
              ref={preRef}
              className="text-mono-sm whitespace-pre-wrap p-3"
              data-testid="logs-pre"
            >
              {filteredLines.map((line, i) => (
                <span key={i} style={colorizeLogLine(line)}>
                  {searchQuery.trim() ? renderHighlighted(line, searchQuery) : line}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}
        </div>

        {/* Action row — spans full Modal width to maintain BOTH left and right
            vertical lines with the search input and log box above.
            UAT 2026-05-20: «кнопки должны быть по ширине этого блока». */}
        <div className="flex flex-wrap justify-between gap-2 mt-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            loading={effectiveLoading}
            onClick={() => void handleRefresh()}
          >
            {t("server.logs.modal.refresh")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={
              copied ? (
                <Check className="w-3.5 h-3.5" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )
            }
            disabled={!logs}
            onClick={() => void handleCopy()}
          >
            {copied ? t("server.logs.modal.copied") : t("server.logs.modal.copy")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Download className="w-3.5 h-3.5" />}
            loading={effectiveDownloading}
            disabled={!logs}
            onClick={() => void handleDownload()}
          >
            {t("server.logs.modal.download")}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("buttons.close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
