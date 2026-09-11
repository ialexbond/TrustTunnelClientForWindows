import { useTranslation } from "react-i18next";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";

interface MigrationOfferDialogProps {
  isOpen: boolean;
  /** «Перенести» — adopt the previous version's data. */
  onAccept: () => void;
  /** «Не переносить» — record the refusal and start empty. */
  onDecline: () => void;
  /**
   * Both buttons disabled while the answer is being carried out. DISABLED, never hidden and never
   * replaced with a different control — the standing rule for an operation in flight. The
   * window does switch to its own indicator immediately after, so in practice this covers only the
   * frame between the click and that switch; it exists so a double-click cannot answer twice.
   */
  busy?: boolean;
}

/**
 * The migration offer — «Нашли прошлую версию».
 *
 * **Why this is an application surface and not an installer page.** Phase 31's D-01 chose a narrow
 * fork of Tauri's NSIS template so the offer could be drawn over the installer's directory screen.
 * The owner reversed that in phase 32 (plan 32-08, task 1): the fork buys one rare user — someone
 * who once installed to a non-default directory — and charges a manual three-way merge of a file we
 * did not write on every Tauri upgrade, with drift that leaves the build green. Drawn here instead,
 * the same question comes out in the product's own design system rather than as a system dialog.
 *
 * **The text is fixed by D-09 and is not to be improved.** A heading and one question, because the
 * question already names the cost of declining — «не перенести свои серверы, пароли и настройки»
 * means being left without them. The line «Если не переносить — программа запустится пустой» was
 * cut by the owner for exactly that reason. The dictated justification «чтобы работал автозапуск»
 * stays out because it does not follow: autostart is bought by the per-machine install location plus
 * the logon task and happens identically whether this is accepted or declined.
 *
 * **The buttons are an action pair, never «Да/Нет» and never «ОК/Отмена».** «Отмена» would be a lie:
 * nothing is cancelled either way, the application starts regardless, and only the data differs.
 *
 * **There is no third way out.** No close button, no backdrop dismissal, no Escape — a dismissal
 * would be an unrecorded answer, and the adoption behind this dialog defaults to adopting when no
 * answer is recorded. So a stray Escape would silently mean «Перенести», which is a decision the
 * user did not make.
 */
export function MigrationOfferDialog({
  isOpen,
  onAccept,
  onDecline,
  busy = false,
}: MigrationOfferDialogProps) {
  const { t } = useTranslation();

  return (
    <Modal
      isOpen={isOpen}
      // No onClose, and both dismissal routes off — see the third-way-out note above.
      closeOnBackdrop={false}
      closeOnEscape={false}
      size="sm"
      role="dialog"
      ariaModal
      ariaLabelledby="migration-offer-heading"
    >
      <div className="space-y-[var(--space-4)]">
        <h2
          id="migration-offer-heading"
          className="text-base font-semibold text-left"
          style={{ color: "var(--color-text-primary)" }}
        >
          {t("migration.offer.heading")}
        </h2>
        <p className="text-sm text-left leading-relaxed text-[var(--color-text-secondary)]">
          {t("migration.offer.question")}
        </p>
        {/* Two real actions, so neither is styled as a dismissal: secondary carries as much weight
            as a genuine choice needs, and the recommended one is primary. `flex-wrap` because the
            English labels are longer and a button never wraps its own label (Button.tsx enforces
            `whitespace-nowrap` on purpose) — with no wrap here a narrow window would push the pair
            out of the card instead of onto a second row, which is the overflow-below-the-rounded-
            edge failure the specification records happening three times without a build ever
            failing. */}
        <div className="flex flex-wrap gap-[var(--space-3)] items-center justify-end">
          <Button variant="secondary" size="sm" onClick={onDecline} disabled={busy}>
            {t("migration.offer.decline")}
          </Button>
          <Button variant="primary" size="sm" onClick={onAccept} disabled={busy}>
            {t("migration.offer.accept")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
