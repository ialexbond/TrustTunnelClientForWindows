import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  Stethoscope,
  ChevronUp,
  Loader2,
} from "lucide-react";
import { Card, CardHeader } from "../../shared/ui/Card";
import { Button } from "../../shared/ui/Button";
import { formatError } from "../../shared/utils/formatError";
import type { ServerState } from "./useServerState";

interface Props {
  state: ServerState;
}

export function DiagnosticsSection({ state }: Props) {
  const { t } = useTranslation();
  const {
    diagResult,
    setDiagResult,
    showDiag,
    setShowDiag,
    diagLoading,
    setDiagLoading,
    sshParams,
  } = state;

  const handleRunDiag = async () => {
    setShowDiag(true);
    setDiagLoading(true);
    setDiagResult(null);
    try {
      const result = await invoke<string>("diagnose_server", sshParams);
      setDiagResult(result);
    } catch (e) {
      setDiagResult(t("server.diagnostics.error", { error: formatError(e) }));
    } finally {
      setDiagLoading(false);
    }
  };

  const handleCollapse = () => {
    setShowDiag(false);
    setDiagResult(null);
  };

  return (
    <Card>
      <CardHeader
        title={t("server.diagnostics.title")}
        icon={<Stethoscope className="w-3.5 h-3.5" />}
      />

      <div className="flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon={<Stethoscope className="w-3.5 h-3.5" />}
          loading={diagLoading}
          onClick={handleRunDiag}
        >
          {showDiag && diagResult
            ? t("server.diagnostics.rerun")
            : t("server.diagnostics.run")}
        </Button>
        {showDiag && diagResult && (
          <Button
            variant="secondary"
            size="sm"
            icon={<ChevronUp className="w-3.5 h-3.5" />}
            onClick={handleCollapse}
          >
            {t("server.diagnostics.collapse")}
          </Button>
        )}
      </div>

      {/* Collapsible diagnostics output with smooth animation */}
      <div
        className="overflow-hidden transition-all duration-300 ease-in-out"
        style={{
          maxHeight: showDiag ? "240px" : "0px",
          opacity: showDiag ? 1 : 0,
          marginTop: showDiag ? "8px" : "0px",
        }}
      >
        <div className="rounded-[var(--radius-md)] overflow-hidden" style={{ border: "1px solid var(--color-border)" }}>
        <pre
          className="p-3 text-[10px] leading-relaxed overflow-auto max-h-48 whitespace-pre-wrap font-mono"
          style={{
            backgroundColor: "var(--color-bg-primary)",
            color: "var(--color-text-muted)",
            paddingRight: "1rem",
          }}
        >
          {diagLoading ? (
            <span
              className="flex items-center gap-2"
              style={{ color: "var(--color-text-muted)" }}
            >
              <Loader2 className="w-3 h-3 animate-spin inline" />
              {t("server.diagnostics.running")}
            </span>
          ) : diagResult ? (
            diagResult
          ) : (
            <span style={{ color: "var(--color-text-muted)" }}>
              {t("server.diagnostics.no_data")}
            </span>
          )}
        </pre>
        </div>
      </div>
    </Card>
  );
}
