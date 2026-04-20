import { createContext, useContext, useCallback, useState, type ReactNode } from "react";
import { SnackBar } from "./SnackBar";
import type { SnackMessage } from "../hooks/useSuccessQueue";

type PushFn = (msg: string, type?: "success" | "error") => void;

const Ctx = createContext<PushFn | null>(null);

export function SnackBarProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<SnackMessage[]>([]);

  const push = useCallback<PushFn>((msg, type = "success") => {
    setQueue(prev => [...prev, { text: msg, type }]);
  }, []);

  const shift = useCallback(() => {
    setQueue(prev => prev.slice(1));
  }, []);

  return (
    <Ctx.Provider value={push}>
      {children}
      <SnackBar messages={queue} onShown={shift} />
    </Ctx.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSnackBar(): PushFn {
  const push = useContext(Ctx);
  if (!push) throw new Error("useSnackBar must be used within SnackBarProvider");
  return push;
}
