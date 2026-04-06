import React from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";

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
  constructor(props: Props & { t: (key: string, opts?: Record<string, string>) => string; onNavigateHome?: () => void }) {
    super(props);
    this.state = { hasError: false, error: "" };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error: error.message };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.panelName || "unknown"}]`, error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      const { t, panelName } = this.props;
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 gap-4"
          style={{ color: "var(--color-text-secondary)" }}>
          <AlertTriangle className="w-10 h-10 text-red-500" />
          <p className="text-sm text-center">
            {t("errors.panelCrash", { panel: panelName || "?" })}
          </p>
          <pre className="text-xs opacity-60 max-w-md overflow-auto whitespace-pre-wrap">
            {this.state.error}
          </pre>
          <div className="flex gap-2">
            <button
              onClick={() => this.setState({ hasError: false, error: "" })}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm"
              style={{
                background: "var(--color-bg-tertiary)",
                color: "var(--color-text-primary)",
                border: "1px solid var(--color-border)",
                cursor: "pointer",
              }}
            >
              <RefreshCw className="w-4 h-4" />
              {t("errors.retry")}
            </button>
            {this.props.onNavigateHome && (
              <button
                onClick={() => {
                  this.setState({ hasError: false, error: "" });
                  this.props.onNavigateHome?.();
                }}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm"
                style={{
                  background: "var(--color-bg-tertiary)",
                  color: "var(--color-text-muted)",
                  border: "1px solid var(--color-border)",
                  cursor: "pointer",
                }}
              >
                <Home className="w-4 h-4" />
                {t("errors.go_home", { defaultValue: "На главную" })}
              </button>
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
