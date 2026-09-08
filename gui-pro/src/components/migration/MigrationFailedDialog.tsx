import { useTranslation } from "react-i18next";
import { Modal } from "../../shared/ui/Modal";
import { Button } from "../../shared/ui/Button";

interface MigrationFailedDialogProps {
  isOpen: boolean;
  /** «Продолжить» — the person has read it; start the application. */
  onContinue: () => void;
}

/**
 * The adoption was accepted and could not be carried out — «Не удалось перенести данные».
 *
 * **Why this screen exists at all.** The backend was changed to report a failed adoption as an
 * error instead of as a success word, and the window then caught that error and started as if
 * nothing had happened. That put the person whose servers, passwords and settings did NOT move in
 * front of exactly the screen the person whose move succeeded sees — the same silence, moved one
 * layer up. Reporting the failure to a log the user never opens is not reporting it.
 *
 * **What the copy may claim, and what it may not.** It says the previous folder still holds the
 * data and that nothing was lost, because that is what the backend guarantees: the legacy root is
 * never written to, and every file this run copied is taken back out again on the failure path. It
 * does NOT say the move will succeed next time, and it does not name a cause — the cause is an io
 * error that reaches `app.log`, and a path or a device name on this screen would be both useless
 * to the reader and a channel for something that must not cross (passwords never reach a log or a
 * window).
 *
 * **One action, and the application starts behind it.** A failed migration is not a reason to
 * strand somebody with no application: the data is intact where it always was, and the product is
 * usable — it simply reads the new, empty folder. So the single button is «Продолжить», not
 * «Повторить»: a retry button would have to re-run the adoption from inside a window that is about
 * to mount the application against the old answer, whereas the next launch retries by itself,
 * which is what the text asks for.
 *
 * **There is no dismissal route** — no close button, no backdrop, no Escape — for the same reason
 * the offer has none: this is the only place the failure is ever stated, and a stray keypress that
 * hid it would put the reader back in the silence this screen was added to end.
 */
export function MigrationFailedDialog({ isOpen, onContinue }: MigrationFailedDialogProps) {
  const { t } = useTranslation();

  return (
    <Modal
      isOpen={isOpen}
      closeOnBackdrop={false}
      closeOnEscape={false}
      size="sm"
      // `dialog`, matching the offer it replaces on screen: `Modal` deliberately exposes that one
      // role, and widening a shared primitive's prop union for one caller is how a design system
      // grows synonyms nobody can keep straight.
      role="dialog"
      ariaModal
      ariaLabelledby="migration-failed-heading"
    >
      <div className="space-y-[var(--space-4)]">
        <h2
          id="migration-failed-heading"
          className="text-base font-semibold text-left"
          style={{ color: "var(--color-text-primary)" }}
        >
          {t("migration.failed.heading")}
        </h2>
        <p className="text-sm text-left leading-relaxed text-[var(--color-text-secondary)]">
          {t("migration.failed.body")}
        </p>
        {/* `flex-wrap` for the same reason the offer's pair carries it: a button never wraps its
            own label, so on a narrow window an unwrapped row would push the action out past the
            card's rounded bottom edge instead of onto a second line. */}
        <div className="flex flex-wrap gap-[var(--space-3)] items-center justify-end">
          <Button variant="primary" size="sm" onClick={onContinue}>
            {t("migration.failed.continue")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
