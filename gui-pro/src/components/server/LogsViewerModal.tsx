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
 *   — error / err] / fatal / panic → --color-danger-fg (красный)
 *   — warn / warning             → --color-warning-fg (жёлтый)
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
    return { color: "var(--color-danger-fg)" };
  if (lower.includes("warn") || lower.includes("warning"))
    return { color: "var(--color-warning-fg)" };
  return { color: "var(--color-text-muted)" };
}

type LogSeverity = "error" | "warn" | "info";

/**
 * classifyLogSeverity — derive a severity level from a log line (F13).
 *
 * Returns the LEVEL only — the renderer picks the matching left-bar token. This
 * replaces whole-line colouring (owner section 6.3 «calmer default»): instead of
 * tinting all the text, the row gets a left colour-bar by severity and the text
 * stays in the normal tone. Mirrors colorizeLogLine's classification rules so the
 * two stay in lock-step; colorizeLogLine remains exported for other importers.
 */
function classifyLogSeverity(line: string): LogSeverity {
  const lower = line.toLowerCase();
  if (
    lower.includes("error") ||
    lower.includes("err]") ||
    lower.includes("fatal") ||
    lower.includes("panic")
  )
    return "error";
  if (lower.includes("warn") || lower.includes("warning")) return "warn";
  return "info";
}

/**
 * severityBarColor — map a severity level to the left-bar colour token. Info
 * lines get a transparent bar so only error/warn draw attention (calmer default).
 */
function severityBarColor(severity: LogSeverity): string {
  if (severity === "error") return "var(--color-danger-fg)";
  if (severity === "warn") return "var(--color-warning-fg)";
  return "transparent";
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
  /**
   * Fired ONLY on a real successful fetch (E-9 + E-20 fix). Carries the freshly
   * fetched logs text + the fetch-success time so the card can render a real
   * preview and a real «Последнее обновление» timestamp. Previously the modal
   * fetched into its own state and never reported back, so the card preview was
   * permanently empty (E-9) and the card fabricated a "now" timestamp on every
   * close regardless of fetch outcome (E-20).
   *
   * D-29: the `text` carries the logs body only between the modal and the card
   * UI — the card must never forward it to the activity-log channel.
   */
  onLogsFetched?: (text: string, timestamp: Date) => void;
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
  onLogsFetched,
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

  // Retargeted to the scroll container div (the <pre> was removed in favour of a
  // per-line render, F13). Auto-scroll-to-bottom now drives this wrapper.
  const scrollRef = useRef<HTMLDivElement>(null);

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
  // WR-02: read the guard honestly at effect time. The previous
  // `const hasInitialLogsRef = { current: !!logs }` was a plain object literal
  // recreated every render (NOT a useRef), so the *Ref naming was misleading —
  // it was just the current render's !!logs snapshot. We now inline the same
  // checks (logs is seeded from initialLogs ?? "", so !logs already covers the
  // initial-logs case; initialLogs is checked explicitly for clarity). Deps
  // stay [isOpen] on purpose: the parent toggles isOpen per open, so the load
  // fires once on the open edge when the buffer is empty.
  useEffect(() => {
    if (isOpen && !logs && !initialLogs && !_forceState) {
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
  // Retargeted to the scroll container (the <pre> ref was removed when lines
  // became per-row divs, F13).
  useEffect(() => {
    if (logs && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  // ─── Filtered lines (client-side, D-2.1) ──────────────────────────────────
  // Empty lines are dropped so the per-line render (F13) shows one row per real
  // entry — a trailing newline must not produce a blank trailing row.
  const filteredLines = useMemo(() => {
    const source = effectiveLogs;
    if (!source) return [];
    const lines = source.split("\n").filter((line) => line.trim().length > 0);
    if (!searchQuery.trim()) return lines;
    const q = searchQuery.toLowerCase();
    return lines.filter((line) => line.toLowerCase().includes(q));
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
      // E-9 + E-20: report the REAL fetched text + the REAL fetch-success time up
      // to the card so its preview and «Последнее обновление» reflect actual data.
      // Fired ONLY here (success path) — a rejected fetch never reaches this line,
      // so the card never fabricates a timestamp (E-20). D-29: body stays in UI.
      onLogsFetched?.(result, new Date());
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
    <Modal isOpen={isOpen} onClose={onClose} size="lg" showCloseButton>
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

        {/* Scrollable log area.
            scroll-visible restores a thin themed scrollbar — the wrapper would
            otherwise inherit the global scrollbar-hidden rule and hide the
            horizontal bar that long no-wrap lines now need (F13). */}
        <div
          ref={scrollRef}
          className="overflow-auto rounded-[var(--radius-md)] scroll-visible"
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
            // One entry equals one line (F13). whitespace-pre (NOT pre-wrap) keeps
            // long lines on a single row; the wrapper's horizontal scrollbar lets
            // the user pan sideways instead of reading an unreadable wrapped block.
            // data-testid kept as logs-pre for the existing content assertions.
            <div
              className="text-mono-sm whitespace-pre p-3"
              data-testid="logs-pre"
            >
              {filteredLines.map((line, i) => {
                const severity = classifyLogSeverity(line);
                return (
                  <div
                    key={i}
                    data-testid="log-line"
                    data-severity={severity}
                    // Severity is a left colour-bar, not a whole-line tint — the
                    // text stays in the normal tone for a calmer default (owner
                    // section 6.3 / F13). Info lines get a transparent bar.
                    style={{
                      borderLeft: `2px solid ${severityBarColor(severity)}`,
                      paddingLeft: "var(--space-2)",
                      color: "var(--color-text-primary)",
                    }}
                  >
                    {searchQuery.trim()
                      ? renderHighlighted(line, searchQuery)
                      : line || " "}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Action row — Refresh / Copy / Download are utility actions. Per the
            GROUP standard (R2-F02b, 09-35, owner decision #4) they CLUSTER right
            with an even gap (justify-end), not spread edge-to-edge: unequal label
            widths under justify-between produced uneven gaps. The redundant
            labeled «Закрыть» button was dropped (F18) — the Modal's corner X
            (showCloseButton) is the single close affordance now. */}
        <div className="flex flex-wrap justify-end gap-2 mt-2">
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
        </div>
      </div>
    </Modal>
  );
}
