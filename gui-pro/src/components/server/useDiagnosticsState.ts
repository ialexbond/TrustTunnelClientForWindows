import { useState } from "react";

/**
 * Domain hook for diagnostics UI state (read-only).
 * Section calls invoke("run_server_diagnostics", ...) via its own handler.
 */
export function useDiagnosticsState() {
  const [diagResult, setDiagResult] = useState<string | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [diagLoading, setDiagLoading] = useState(false);

  return {
    diagResult,
    setDiagResult,
    showDiag,
    setShowDiag,
    diagLoading,
    setDiagLoading,
  };
}

export type DiagnosticsState = ReturnType<typeof useDiagnosticsState>;
