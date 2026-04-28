import { useState, useCallback, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../../../shared/ui/Modal";
import { Button } from "../../../shared/ui/Button";

/**
 * Phase 15.1 D-14.1 — Triple-choice navigate-away guard.
 *
 * Returns Promise<NavigationChoice> when user attempts to leave with unsaved changes.
 * Modal lifecycle owned by Modal primitive (T-03 invariant — НЕ early return null).
 *
 * Usage:
 *   const { confirmNavigateAway, NavigateAwayGuardElement } = useNavigateAwayGuard();
 *   const choice = await confirmNavigateAway();
 *   switch (choice) {
 *     case "save":    await config.saveAll(); navigate(...); break;
 *     case "discard": config.discardAll();    navigate(...); break;
 *     case "stay":    return; // user remains on current tab
 *   }
 *   // Render <NavigateAwayGuardElement /> inside parent JSX (Modal mounts here).
 *
 * Buttons in displayed order: Stay (ghost) / Discard&Leave (secondary) / Save&Leave (primary).
 */
export type NavigationChoice = "save" | "discard" | "stay";

export function useNavigateAwayGuard() {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const resolveRef = useRef<((choice: NavigationChoice) => void) | null>(null);

  const confirmNavigateAway = useCallback((): Promise<NavigationChoice> => {
    return new Promise<NavigationChoice>((resolve) => {
      resolveRef.current = resolve;
      setIsOpen(true);
    });
  }, []);

  const handleChoice = useCallback((choice: NavigationChoice) => {
    if (resolveRef.current) {
      resolveRef.current(choice);
      resolveRef.current = null;
    }
    setIsOpen(false);
  }, []);

  // Render — owns Modal lifecycle (T-03: pass isOpen as-is, never early return null).
  const NavigateAwayGuardElement = (): ReactNode => (
    <Modal
      isOpen={isOpen}
      onClose={() => handleChoice("stay")}
      title={t("server.config.unsaved_title")}
    >
      <p className="text-body text-[var(--color-text-secondary)] mb-4">
        {t("server.config.unsaved_desc")}
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => handleChoice("stay")}>
          {t("server.config.stay")}
        </Button>
        <Button variant="secondary" onClick={() => handleChoice("discard")}>
          {t("server.config.discard_and_leave")}
        </Button>
        <Button variant="primary" onClick={() => handleChoice("save")}>
          {t("server.config.save_and_leave")}
        </Button>
      </div>
    </Modal>
  );

  return { confirmNavigateAway, NavigateAwayGuardElement };
}
