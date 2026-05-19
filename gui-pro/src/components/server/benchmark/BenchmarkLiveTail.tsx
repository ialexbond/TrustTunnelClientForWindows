/**
 * BenchmarkLiveTail — live scrolling terminal-like view of benchmark stdout.
 *
 * - Subscribes to benchmark-stdout-chunk Tauri event, maintains rolling buffer (25 lines max).
 * - Auto-scrolls to bottom on new chunk.
 * - Pause/Resume button: when paused, new chunks still queue but viewport stays fixed.
 * - Uses colorizeLogLine from LogsViewerModal for ANSI coloring.
 * - Fixed height ~200px, overflow-y auto, font-mono text-mono-sm.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Button } from "../../../shared/ui/Button";
import { colorizeLogLine } from "../LogsViewerModal";

// eslint-disable-next-line no-control-regex
const ANSI_STRIP_RE = /\x1b\[[0-9;]*[mGKJHF]/g;

const MAX_LINES = 25;

interface BenchmarkLiveTailProps {
  /** Whether the benchmark is currently running (controls event subscription). */
  active: boolean;
}

export function BenchmarkLiveTail({ active }: BenchmarkLiveTailProps) {
  const { t } = useTranslation();
  const [lines, setLines] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<string[]>([]);

  // Keep pausedRef in sync without causing re-render in listener closure
  useEffect(() => {
    pausedRef.current = paused;
    // On resume, flush pending lines
    if (!paused && pendingRef.current.length > 0) {
      setLines((prev) => {
        const next = [...prev, ...pendingRef.current];
        pendingRef.current = [];
        return next.slice(-MAX_LINES);
      });
    }
  }, [paused]);

  // Subscribe to benchmark-stdout-chunk events (race-safe)
  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    listen<string>("benchmark-stdout-chunk", (event) => {
      const chunk = event.payload.replace(ANSI_STRIP_RE, "").trim();
      if (!chunk) return;

      if (pausedRef.current) {
        // Queue while paused
        pendingRef.current.push(chunk);
        if (pendingRef.current.length > MAX_LINES * 2) {
          pendingRef.current = pendingRef.current.slice(-MAX_LINES);
        }
      } else {
        setLines((prev) => {
          const next = [...prev, chunk];
          return next.slice(-MAX_LINES);
        });
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Auto-scroll to bottom when lines change and not paused
  useEffect(() => {
    if (paused) return;
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines, paused]);

  const handleTogglePause = useCallback(() => {
    setPaused((p) => !p);
  }, []);

  if (!active) return null;

  return (
    <div className="flex flex-col gap-2">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-body-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>
          {t("server.utilities.benchmark.tail.title")}
        </span>
        <Button
          variant="ghost"
          onClick={handleTogglePause}
          aria-label={paused ? t("server.utilities.benchmark.tail.resume") : t("server.utilities.benchmark.tail.pause")}
        >
          <span className="text-caption">
            {paused ? t("server.utilities.benchmark.tail.resume") : t("server.utilities.benchmark.tail.pause")}
          </span>
        </Button>
      </div>

      {/* Scrollable terminal */}
      <div
        ref={scrollRef}
        className="rounded-[var(--radius-sm)] overflow-y-auto"
        style={{
          height: 200,
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          padding: "8px 12px",
        }}
      >
        {lines.length === 0 ? (
          <span className="text-mono-sm" style={{ color: "var(--color-text-muted)" }}>
            ...
          </span>
        ) : (
          lines.map((line, i) => (
            <div
              key={i}
              className="text-mono-sm"
              style={{ ...colorizeLogLine(line), lineHeight: 1.5 }}
            >
              {line || " "}
            </div>
          ))
        )}
        {paused && (
          <div
            className="text-caption mt-1"
            style={{ color: "var(--color-warning-500)" }}
          >
            [{t("server.utilities.benchmark.tail.pause")}]
          </div>
        )}
      </div>
    </div>
  );
}
