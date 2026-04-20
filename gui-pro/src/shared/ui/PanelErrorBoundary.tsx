import React from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, RefreshCw, Home, Download } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "../lib/cn";
import { Button } from "./Button";

interface State {
  hasError: boolean;
  error: string;
}

interface Props {
  children: React.ReactNode;
  panelName?: string;
  onNavigateHome?: () => void;
}

class PanelErrorBoundaryInner extends React.Component<
  Props & { t: (key: string, opts?: Record<string, string>) => string; onNavigateHome?: () => void },
  State
> {
  constructor(
    props: Props & {
      t: (key: string, opts?: Record<string, string>) => string;
      onNavigateHome?: () => void;
    },
  ) {
    super(props);
    this.state = { hasError: false, error: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(
      `[ErrorBoundary:${this.props.panelName || "unknown"}]`,
      error,
      import.meta.env.DEV ? info.componentStack : "",
    );
  }

  render() {
    if (this.state.hasError) {
      const { t, panelName } = this.props;
      return (
        <div
          className={cn(
            "flex-1 flex flex-col items-center justify-center p-[var(--space-7)] gap-[var(--space-4)]",
            "bg-[var(--color-bg-surface)]",
          )}
          style={{ color: "var(--color-text-secondary)" }}
        >
          <AlertTriangle className="w-10 h-10 text-[var(--color-danger-400)]" />
          <p className="text-sm text-center">
            {t("errors.panelCrash", { panel: panelName || "?" })}
          </p>
          <pre className="text-xs opacity-60 max-w-md overflow-auto whitespace-pre-wrap">
            {this.state.error}
          </pre>
          <div className="flex gap-[var(--space-2)]">
            <Button
              variant="secondary"
              size="md"
              icon={<RefreshCw className="w-4 h-4" />}
              onClick={() => this.setState({ hasError: false, error: "" })}
            >
              {t("errors.retry")}
            </Button>
            <Button
              variant="ghost"
              size="md"
              icon={<Download className="w-4 h-4" />}
              onClick={() => {
                invoke("open_logs_folder").catch((e) =>
                  console.error("open_logs_folder failed:", e)
                );
              }}
            >
              {t("errors.download_logs")}
            </Button>
            {this.props.onNavigateHome && (
              <Button
                variant="ghost"
                size="md"
                icon={<Home className="w-4 h-4" />}
                onClick={() => {
                  this.setState({ hasError: false, error: "" });
                  this.props.onNavigateHome?.();
                }}
              >
                {t("errors.go_home")}
              </Button>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function PanelErrorBoundary({ children, panelName, onNavigateHome }: Props) {
  const { t } = useTranslation();
  return (
    <PanelErrorBoundaryInner t={t} panelName={panelName} onNavigateHome={onNavigateHome}>
      {children}
    </PanelErrorBoundaryInner>
  );
}
