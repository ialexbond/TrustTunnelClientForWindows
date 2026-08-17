/* eslint-disable react-refresh/only-export-components -- imperative hook is co-located with rendering component by design (Phase 15.1 D-4.3 imperative API for SaveFlow Modal). */
import { useState, useCallback, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Modal } from "../../../shared/ui/Modal";
import { Button } from "../../../shared/ui/Button";
import type { ConfigFileName } from "./types";

/**
 * Phase 15.1 D-4.3 + D-4.4 — Save flow custom Modal с rich diff content.
 *
 * Pattern parity с NavigateAwayGuard (Task 2.5): imperative hook returns
 *   - confirmSave(diffRows, hasDisruptHigh): Promise<boolean>
 *   - SaveFlowDialogElement: ReactNode (mount внутри parent JSX)
 *
 * Modal lifecycle owned by Modal primitive (T-03 invariant: НЕ early return null;
 * isOpen передаётся as-is; 200ms exit-animation сохраняется).
 *
 * Resolves Promise<true> on Apply; Promise<false> on Cancel / overlay close.
 */
export interface DiffRow {
  /** "listen_protocols.http2.max_concurrent_streams" — joined path key. */
  pathKey: string;
  fileName: ConfigFileName;
  before: unknown;
  after: unknown;
}

export interface SaveFlowDialogProps {
  isOpen: boolean;
  diffRows: DiffRow[];
  hasDisruptHighField: boolean;
  onApply: () => void;
  onCancel: () => void;
}

/**
 * Pure render component — visible UI of save-flow Modal.
 * Owns NO state; composed by useSaveFlowDialog hook OR can be rendered standalone в Storybook.
 */
export function SaveFlowDialog({
  isOpen,
  diffRows,
  hasDisruptHighField,
  onApply,
  onCancel,
}: SaveFlowDialogProps) {
  const { t } = useTranslation();

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={t("server.config.confirm_save_title")}
      size="lg"
    >
      <div className="flex flex-col gap-4">
        <p className="text-body text-[var(--color-text-secondary)]">
          {hasDisruptHighField
            ? t("server.config.confirm_save_disrupt_desc")
            : t("server.config.confirm_save_desc")}
        </p>

        {/* Diff table — D-4.3 [Файл / Поле / Было / Стало] */}
        <div className="overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
          <table className="w-full text-left">
            <thead className="bg-[var(--color-bg-elevated)]">
              <tr>
                <th className="px-3 py-2 text-caption font-medium text-[var(--color-text-secondary)]">
                  {t("server.config.diff_col_file")}
                </th>
                <th className="px-3 py-2 text-caption font-medium text-[var(--color-text-secondary)]">
                  {t("server.config.diff_col_field")}
                </th>
                <th className="px-3 py-2 text-caption font-medium text-[var(--color-text-secondary)]">
                  {t("server.config.diff_col_before")}
                </th>
                <th className="px-3 py-2 text-caption font-medium text-[var(--color-text-secondary)]">
                  {t("server.config.diff_col_after")}
                </th>
              </tr>
            </thead>
            <tbody>
              {diffRows.map((row) => (
                <tr
                  key={row.pathKey}
                  className="border-t border-[var(--color-border)]"
                >
                  <td className="px-3 py-2 text-mono-sm text-[var(--color-text-secondary)]">
                    {row.fileName}.toml
                  </td>
                  <td className="px-3 py-2 text-mono-sm text-[var(--color-text-secondary)]">
                    {row.pathKey}
                  </td>
                  <td className="px-3 py-2 text-mono-sm text-[var(--color-text-muted)]">
                    {String(row.before ?? "—")}
                  </td>
                  <td className="px-3 py-2 text-mono-sm text-[var(--color-text-primary)]">
                    {String(row.after ?? "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Disrupt warning footer (D-4.4) */}
        {hasDisruptHighField && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-status-connecting-bg)] border border-[var(--color-warning-fg)] px-4 py-2"
          >
            <AlertTriangle
              size={16}
              className="text-[var(--color-warning-fg)] shrink-0"
              aria-hidden="true"
            />
            <span className="text-body-sm text-[var(--color-warning-fg)]">
              {t("server.config.disrupt_warning")}
            </span>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onCancel}>
            {t("buttons.cancel", { defaultValue: "Отмена" })}
          </Button>
          <Button variant="primary" onClick={onApply}>
            {t("server.config.confirm_apply", {
              defaultValue: "Применить изменения",
            })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Imperative hook wrapping SaveFlowDialog.
 *
 * Usage:
 *   const { confirmSave, SaveFlowDialogElement } = useSaveFlowDialog();
 *   const ok = await confirmSave(diffRows, hasDisruptHighField);
 *   if (!ok) return;
 *   await saveAll();
 *   // Render <SaveFlowDialogElement /> inside parent JSX (Modal mounts here).
 */
export function useSaveFlowDialog() {
  const [state, setState] = useState<{
    isOpen: boolean;
    diffRows: DiffRow[];
    hasDisruptHighField: boolean;
  }>({ isOpen: false, diffRows: [], hasDisruptHighField: false });
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);

  const confirmSave = useCallback(
    (
      diffRows: DiffRow[],
      hasDisruptHighField: boolean,
    ): Promise<boolean> => {
      return new Promise<boolean>((resolve) => {
        resolveRef.current = resolve;
        setState({ isOpen: true, diffRows, hasDisruptHighField });
      });
    },
    [],
  );

  const handleApply = useCallback(() => {
    if (resolveRef.current) {
      resolveRef.current(true);
      resolveRef.current = null;
    }
    setState((s) => ({ ...s, isOpen: false }));
  }, []);

  const handleCancel = useCallback(() => {
    if (resolveRef.current) {
      resolveRef.current(false);
      resolveRef.current = null;
    }
    setState((s) => ({ ...s, isOpen: false }));
  }, []);

  const SaveFlowDialogElement = (): ReactNode => (
    <SaveFlowDialog
      isOpen={state.isOpen}
      diffRows={state.diffRows}
      hasDisruptHighField={state.hasDisruptHighField}
      onApply={handleApply}
      onCancel={handleCancel}
    />
  );

  return { confirmSave, SaveFlowDialogElement };
}
