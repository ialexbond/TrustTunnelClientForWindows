import { useContext } from "react";
import { ConfirmDialogContext, type ConfirmFn } from "./ConfirmDialogProvider";

/**
 * Imperative confirm() hook.
 * Returns a function: `const ok = await confirm({ title, message, variant })`.
 * Must be used inside a {@link ConfirmDialogProvider}; throws otherwise.
 */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmDialogContext);
  if (!ctx) {
    throw new Error(
      "useConfirm must be used within ConfirmDialogProvider",
    );
  }
  return ctx;
}
