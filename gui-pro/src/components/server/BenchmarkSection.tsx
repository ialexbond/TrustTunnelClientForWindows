/**
 * BenchmarkSection — Card preview for the Server Benchmark feature.
 *
 * Shows empty state or last-run summary, and triggers BenchmarkModal.
 *
 * Design: mirrors SecuritySection.tsx Card pattern (Phase 16).
 * T-03 invariant: BenchmarkModal is always rendered (never conditional), isOpen passed as-is.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity } from "lucide-react";
import { Card } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { loadLast } from "./benchmark/history";
import { BenchmarkModal } from "./BenchmarkModal";

/** Formats ISO timestamp as "HH:MM DD.MM.YYYY" */
function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

export interface BenchmarkSectionProps {
  sshParams: {
    host: string;
    port: number;
    user: string;
    password: string;
    keyPath?: string;
    keyData?: string;
  };
}

export function BenchmarkSection({ sshParams }: BenchmarkSectionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  // Synchronous read from localStorage — no suspense needed
  const lastRun = loadLast(sshParams.host) ?? undefined;

  return (
    <>
      <Card data-testid="benchmark-section-card">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <Activity
              className="w-5 h-5 shrink-0"
              style={{ color: "var(--color-accent-interactive)" }}
              aria-hidden="true"
            />
            <div className="flex-1 min-w-0">
              <h3 className="text-subtitle">
                {t("server.utilities.benchmark.card.title")}
              </h3>
              <p
                className="text-caption"
                style={{ color: "var(--color-text-muted)" }}
              >
                {lastRun
                  ? t("server.utilities.benchmark.card.last_run", {
                      time: formatTime(lastRun.timestamp),
                    })
                  : t("server.utilities.benchmark.card.empty")}
              </p>
            </div>
          </div>
          <Button
            variant={lastRun ? "secondary" : "primary"}
            size="sm"
            onClick={() => setOpen(true)}
          >
            {lastRun
              ? t("server.utilities.benchmark.button.open_results")
              : t("server.utilities.benchmark.button.check_quality")}
          </Button>
        </div>
      </Card>

      {/* T-03: Modal is always in the tree — never conditional before <Modal> */}
      <BenchmarkModal
        isOpen={open}
        onClose={() => setOpen(false)}
        sshParams={sshParams}
      />
    </>
  );
}
