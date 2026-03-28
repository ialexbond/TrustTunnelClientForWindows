import { useState, useCallback } from "react";

export function useSuccessQueue() {
  const [successQueue, setSuccessQueue] = useState<string[]>([]);
  const pushSuccess = useCallback((msg: string) => {
    setSuccessQueue(prev => [...prev, msg]);
  }, []);
  const shiftSuccess = useCallback(() => {
    setSuccessQueue(prev => prev.slice(1));
  }, []);
  return { successQueue, pushSuccess, shiftSuccess };
}
