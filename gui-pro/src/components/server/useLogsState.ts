import { useState } from "react";

/**
 * Domain hook for server logs UI state (read-only).
 * Section calls invoke("server_read_logs", ...) via its own handler and
 * pushes the result into setServerLogs.
 */
export function useLogsState() {
  const [serverLogs, setServerLogs] = useState("");
  const [showLogs, setShowLogs] = useState(false);
  const [logsLoading, setLogsLoading] = useState(false);

  return {
    serverLogs,
    setServerLogs,
    showLogs,
    setShowLogs,
    logsLoading,
    setLogsLoading,
  };
}

export type LogsState = ReturnType<typeof useLogsState>;
