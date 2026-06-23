import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, Trash2, Copy, Check, Search, ScrollText, X } from "lucide-react";
import { Button } from "../shared/ui/Button";
import { Card, CardHeader } from "../shared/ui/Card";
import { Select } from "../shared/ui/Select";
import { useSnackBar } from "../shared/ui/SnackBarContext";
import type { LogEntry } from "../shared/types";

interface LogPanelProps {
  logs: LogEntry[];
  onClear: () => void;
  isConnected?: boolean;
  sidecarLogLevel?: string;
  onSidecarLogLevelChange?: (level: string) => void;
}

const LOG_LEVELS = ["all", "error", "warn", "info", "debug", "trace"] as const;

const LEVEL_COLOR: Record<string, string> = {
  error: "var(--color-danger-500)",
  warn: "var(--color-warning-500)",
  info: "var(--color-success-500)",
  debug: "var(--color-accent-400)",
  trace: "var(--color-text-muted)",
};

// T-30: how close to the bottom (in px) the user must be for the view to still be
// considered "stuck to the bottom". A small slack absorbs sub-pixel rounding and the
// height of a single just-appended line, so normal tailing keeps following while a
// deliberate scroll-up (well past this) stops the auto-follow.
const STICK_TO_BOTTOM_THRESHOLD_PX = 24;

function isAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_TO_BOTTOM_THRESHOLD_PX;
}

function LogPanel({ logs, onClear, isConnected }: LogPanelProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  // T-30: track whether the view is currently pinned to the bottom. New log lines
  // only force-scroll while this is true; once the user scrolls up to read history a
  // new line must NOT yank the view back down. Starts true so the very first batch
  // tails as before. A ref (not state) so the effect reads the latest value without
  // re-subscribing and without an extra render per scroll event.
  const stickToBottomRef = useRef(true);
  const [copied, setCopied] = useState(false);
  const [levelFilter, setLevelFilter] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const pushSuccess = useSnackBar();

  const levelOptions = useMemo(
    () =>
      LOG_LEVELS.map((lvl) => ({
        value: lvl,
        label: lvl === "all" ? t("logs_panel.filter_all") : lvl.toUpperCase(),
      })),
    [t],
  );

  const filteredLogs = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return logs.filter((log) => {
      if (levelFilter !== "all") {
        const hierarchy = ["trace", "debug", "info", "warn", "error"];
        const filterIdx = hierarchy.indexOf(levelFilter);
        const logIdx = hierarchy.indexOf(log.level);
        if (logIdx < filterIdx) return false;
      }
      if (q && !log.message.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [logs, levelFilter, searchQuery]);

  const isFiltered = levelFilter !== "all" || searchQuery !== "";

  // T-30: stick-to-bottom ONLY when the user is already at (or near) the bottom.
  // Previously this unconditionally scrolled to the bottom on every new line, so a
  // user scrolled up to read history was yanked back down by each incoming line and
  // could never read older entries (UAT). Now we follow only while pinned.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filteredLogs]);

  // T-30: re-evaluate the pin on every user scroll. Scrolling up away from the bottom
  // releases the pin (new lines stop pulling the view down); scrolling back to the
  // bottom re-arms it (tailing resumes). The pin lives in a ref so this handler does
  // not trigger a render on every scroll tick.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      stickToBottomRef.current = isAtBottom(el);
    }
  }, []);

  const handleCopy = useCallback(() => {
    const text = filteredLogs
      .map((l) => `${l.timestamp} [${l.level.toUpperCase()}] ${l.message}`)
      .join("\n");
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      pushSuccess(t("logs.copied", "Логи скопированы"));
    });
  }, [filteredLogs, pushSuccess, t]);

  const emptyMessage = logs.length === 0
    ? (isConnected ? t("logs_panel.no_logs_yet") : t("logs_panel.logs_appear_on_connect"))
    : t("logs_panel.no_matching");

  return (
    <Card padding="none" className="flex-1 flex flex-col min-h-0 h-full">
      {/* Header */}
      <div className="px-4 pt-4">
        <CardHeader
          title={t("sections.logs")}
          icon={<Terminal className="w-4 h-4" />}
          action={
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                icon={copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                onClick={handleCopy}
                disabled={filteredLogs.length === 0}
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
          }
        />
      </div>

      {/* Filter bar */}
      <div className="px-4 pb-3 flex items-center gap-3">
        {/* F10: widened from w-[96px] so the ERROR option + selected checkmark +
            scrollbar fit without truncating the label. */}
        <div className="shrink-0 w-[120px]">
          <Select
            options={levelOptions}
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            fullWidth
          />
        </div>
        {/* Search with badge and clear */}
        <div className="flex-1 relative">
          <span
            className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: "var(--color-text-muted)" }}
          >
            <Search className="w-3.5 h-3.5" />
          </span>
          <input
            className="w-full rounded-[var(--radius-lg)] pl-9 pr-20 h-8 text-xs transition-colors outline-none focus-visible:shadow-[var(--focus-ring)] placeholder:opacity-40"
            style={{
              backgroundColor: "var(--color-input-bg)",
              border: "1px solid var(--color-input-border)",
              color: "var(--color-text-primary)",
            }}
            placeholder={t("logs_panel.search_placeholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="p-0.5 rounded transition-colors hover:bg-[var(--color-bg-hover)]"
                style={{ color: "var(--color-text-muted)" }}
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            <span
              className="text-xs px-1.5 py-0.5 rounded-full"
              style={{
                backgroundColor: "var(--color-bg-hover)",
                color: "var(--color-text-muted)",
              }}
            >
              {isFiltered ? `${filteredLogs.length}/${logs.length}` : logs.length}
            </span>
          </div>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t" style={{ borderColor: "var(--color-border)" }} />

      {/* Log entries */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto font-mono text-xs min-h-0 px-4 py-2 space-y-0.5 scroll-visible"
      >
        {filteredLogs.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center h-full gap-2"
            style={{ color: "var(--color-text-muted)" }}
          >
            <ScrollText className="w-8 h-8 opacity-40" />
            <p className="text-xs">{emptyMessage}</p>
          </div>
        ) : (
          filteredLogs.map((log, i) => (
            <div
              key={i}
              className="flex gap-2 px-2 py-0.5 rounded transition-colors hover:bg-[var(--color-bg-hover)]"
            >
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
    </Card>
  );
}

export default LogPanel;
