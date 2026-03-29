import { Loader2 } from "lucide-react";
import { Tooltip } from "./Tooltip";

interface IconButtonProps {
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  color?: string;
  children: React.ReactNode;
}

export function IconButton({ tooltip, onClick, disabled, loading, color, children }: IconButtonProps) {
  return (
    <Tooltip text={tooltip}>
      <button
        onClick={onClick}
        disabled={disabled || loading}
        className="p-1 rounded transition-colors hover:opacity-70 disabled:opacity-30 disabled:cursor-not-allowed"
        style={{ color: color || "var(--color-text-muted)" }}
      >
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : children}
      </button>
    </Tooltip>
  );
}
