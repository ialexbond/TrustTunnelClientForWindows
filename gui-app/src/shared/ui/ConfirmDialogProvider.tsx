import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * Options for a single imperative confirm() call.
 * Matches the existing ConfirmDialog props surface so callers can
 * migrate from inline <ConfirmDialog/> with minimal friction.
 */
export interface ConfirmOptions {
  title: string;
  message: string;
  variant?: "danger" | "warning";
  confirmText?: string;
  cancelText?: string;
}

/** Internal queue item: options plus the promise resolver. */
interface PendingRequest extends ConfirmOptions {
  resolve: (value: boolean) => void;
}

/**
 * Context value: a single imperative function that returns a Promise<boolean>.
 * `true` = user confirmed, `false` = user cancelled / provider unmounted.
 */
export type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

export const ConfirmDialogContext = createContext<ConfirmFn | null>(null);

/**
 * Root-level provider that renders the single <ConfirmDialog/> instance
 * for the whole application and exposes an imperative `confirm()` via
 * {@link ConfirmDialogContext}.
 *
 * Behavior:
 * - FIFO queue — while a dialog is open, subsequent confirm() calls wait
 *   in `queueRef` and display one after another.
 * - Cancel defaults to `false` (backdrop, Escape, "Cancel" button).
 * - On Provider unmount, every pending and currently-shown request is
 *   resolved with `false` so no `await confirm()` hangs forever.
 */
export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<PendingRequest | null>(null);
  const currentRef = useRef<PendingRequest | null>(null);
  const queueRef = useRef<PendingRequest[]>([]);

  // Keep ref in sync so the unmount cleanup sees the latest value.
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  const pump = useCallback(() => {
    const next = queueRef.current.shift() ?? null;
    currentRef.current = next;
    setCurrent(next);
  }, []);

  // WR-01 fix: use currentRef for the "is a dialog open?" check instead of
  // mutating queueRef inside a setState updater. Under React.StrictMode the
  // updater runs twice in DEV, which would have pushed the same request
  // into the queue twice. Now the queue is mutated exactly once per call.
  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        const req: PendingRequest = { ...opts, resolve };
        if (currentRef.current) {
          queueRef.current.push(req);
        } else {
          currentRef.current = req;
          setCurrent(req);
        }
      }),
    [],
  );

  // WR-02 fix: read and clear currentRef atomically before resolving.
  // Guards against double-click races where two rapid clicks on the same
  // rendered dialog would both see `current` via closure and call resolve
  // twice (Promise.resolve is idempotent, but the pattern was fragile and
  // blocked any future side-effect addition inside resolve).
  const handleConfirm = useCallback(() => {
    const req = currentRef.current;
    if (!req) return;
    currentRef.current = null;
    req.resolve(true);
    pump();
  }, [pump]);

  const handleCancel = useCallback(() => {
    const req = currentRef.current;
    if (!req) return;
    currentRef.current = null;
    req.resolve(false);
    pump();
  }, [pump]);

  // Unmount cleanup: resolve everything pending so no await hangs.
  // We read through refs so we see the latest state/queue at unmount time.
  useEffect(() => {
    return () => {
      currentRef.current?.resolve(false);
      const queue = queueRef.current;
      for (const req of queue) req.resolve(false);
      queueRef.current = [];
      currentRef.current = null;
    };
  }, []);

  return (
    <ConfirmDialogContext.Provider value={confirm}>
      {children}
      {current && (
        <ConfirmDialog
          isOpen={true}
          title={current.title}
          message={current.message}
          variant={current.variant}
          confirmLabel={current.confirmText}
          cancelLabel={current.cancelText}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </ConfirmDialogContext.Provider>
  );
}
