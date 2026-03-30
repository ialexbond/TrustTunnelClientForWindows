import { useState, useCallback } from "react";

export type SnackMessage = { text: string; type?: "success" | "error" };

export function useSuccessQueue() {
  const [successQueue, setSuccessQueue] = useState<SnackMessage[]>([]);
  const pushSuccess = useCallback((msg: string, type: "success" | "error" = "success") => {
    setSuccessQueue(prev => [...prev, { text: msg, type }]);
  }, []);
  const shiftSuccess = useCallback(() => {
    setSuccessQueue(prev => prev.slice(1));
  }, []);
  return { successQueue, pushSuccess, shiftSuccess };
}
