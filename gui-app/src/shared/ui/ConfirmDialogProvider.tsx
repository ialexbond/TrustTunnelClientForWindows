/* eslint-disable react-refresh/only-export-components -- Provider/Context co-located here intentionally; splitting hurts call-site ergonomics */
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
  /**
   * Optional async action invoked when the user clicks "Confirm".
   * While the returned promise is pending, the modal stays open with
   * a visible loading state (Cancel + backdrop disabled, Confirm shows
   * a spinner). Only when the promise resolves does the modal close.
   *
   * - On resolve: outer `confirm()` promise resolves with `true`.
   * - On reject: outer `confirm()` promise resolves with `false` and
   *   the modal closes. Caller is responsible for surfacing the error
   *   (SnackBar / actionResult).
   *
   * When omitted, the modal closes immediately on Confirm click
   * (existing behavior — backward compatible).
   */
  action?: () => Promise<void>;
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
  const [actionRunning, setActionRunning] = useState(false);
  // `displayed` is what actually renders in the Modal. It lags behind `current`
  // by 200ms on close so the exit animation can play with valid content (see
  // Modal primitive lifecycle contract in Modal.tsx JSDoc + known-issues #10).
  // When `current` goes null → isOpen=false triggers Modal's 200ms fade-out →
  // setTimeout 200ms clears `displayed` → ConfirmDialog unmounts cleanly.
  const [displayed, setDisplayed] = useState<PendingRequest | null>(null);
  const currentRef = useRef<PendingRequest | null>(null);
  const queueRef = useRef<PendingRequest[]>([]);

  // Keep ref in sync so the unmount cleanup sees the latest value.
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  // Sync `displayed` with `current`, but delay the clear by 200ms to allow
  // Modal exit animation to finish with still-valid title/message content.
  useEffect(() => {
    if (current) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate: `displayed` must lag `current` by 200ms on close so Modal exit animation has valid content; on open it must immediately adopt the new request
      setDisplayed(current);
      return;
    }
    // current === null — start the clear timer; Modal's own exit runs in parallel.
    const t = setTimeout(() => setDisplayed(null), 200);
    return () => clearTimeout(t);
  }, [current]);

  const pump = useCallback(() => {
    const next = queueRef.current.shift() ?? null;
    currentRef.current = next;
    setCurrent(next);
    setActionRunning(false);
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
  //
  // Async action support: when req.action is provided, await it with
  // visible loading state before resolving. Modal stays open for the
  // whole duration; closes only when action settles (resolve or reject).
  const handleConfirm = useCallback(async () => {
    const req = currentRef.current;
    if (!req) return;

    if (req.action) {
      // Guard against re-entry if the user somehow double-clicks — the
      // Confirm button is disabled while actionRunning but belt & suspenders.
      if (actionRunning) return;
      setActionRunning(true);
      try {
        await req.action();
        currentRef.current = null;
        req.resolve(true);
      } catch {
        // Action failed — close modal with false, caller handles error UI.
        currentRef.current = null;
        req.resolve(false);
      }
      pump();
      return;
    }

    // Legacy sync path — close immediately on confirm.
    currentRef.current = null;
    req.resolve(true);
    pump();
  }, [pump, actionRunning]);

  const handleCancel = useCallback(() => {
    // Cancel is ignored while the async action is in flight — the modal
    // stays open until the action settles (same semantics as a destructive
    // operation on a server: can't undo once SSH invocation fired).
    if (actionRunning) return;
    const req = currentRef.current;
    if (!req) return;
    currentRef.current = null;
    req.resolve(false);
    pump();
  }, [pump, actionRunning]);

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
      {/*
        ALWAYS render ConfirmDialog while `displayed` has content (lags `current`
        by 200ms on close). `isOpen` is driven by `current !== null` so Modal's
        exit animation plays for 200ms before displayed clears and tree unmounts.
        Parent MUST NOT return null early (see known-issues #10).
      */}
      {displayed && (
        <ConfirmDialog
          isOpen={current !== null}
          title={displayed.title}
          message={displayed.message}
          variant={displayed.variant}
          confirmLabel={displayed.confirmText}
          cancelLabel={displayed.cancelText}
          loading={actionRunning}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
    </ConfirmDialogContext.Provider>
  );
}
