import { AlertTriangle, X } from "lucide-react";

interface ErrorBannerProps {
  message: string;
  onDismiss?: () => void;
  variant?: "error" | "warning" | "info";
}

const variantConfig = {
  error: {
    bg: "rgba(239, 68, 68, 0.1)",
    border: "rgba(239, 68, 68, 0.2)",
    text: "var(--color-danger-400)",
    icon: "var(--color-danger-400)",
  },
  warning: {
    bg: "rgba(245, 158, 11, 0.1)",
    border: "rgba(245, 158, 11, 0.2)",
    text: "var(--color-warning-400)",
    icon: "var(--color-warning-400)",
  },
  info: {
    bg: "rgba(99, 102, 241, 0.1)",
    border: "rgba(99, 102, 241, 0.2)",
    text: "var(--color-accent-400)",
    icon: "var(--color-accent-400)",
  },
};

export function ErrorBanner({ message, onDismiss, variant = "error" }: ErrorBannerProps) {
  const config = variantConfig[variant];

  return (
    <div
      className="flex items-start gap-2.5 px-3 py-2.5 rounded-[var(--radius-lg)] text-[13px] leading-relaxed"
      style={{
        backgroundColor: config.bg,
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: config.border,
        color: config.text,
      }}
    >
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: config.icon }} />
      <span className="flex-1 break-words">{message}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="shrink-0 p-0.5 rounded transition-opacity hover:opacity-70"
          style={{ color: config.text }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
