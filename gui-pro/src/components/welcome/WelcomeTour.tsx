import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "../../shared/ui/Button";
import { useWelcomeTour } from "../../shared/hooks/useWelcomeTour";
import { WelcomeScreen1 } from "./screens/WelcomeScreen1";
import { WelcomeScreen2 } from "./screens/WelcomeScreen2";
import { WelcomeScreen3 } from "./screens/WelcomeScreen3";
import { WelcomeDotIndicator } from "./WelcomeDotIndicator";

export interface WelcomeTourProps {
  /**
   * Вызывается когда тур завершён или пропущен. Hook `useWelcomeTour.complete()`
   * уже отметит флаг в localStorage — callback нужен parent'у для триггера
   * re-render (unmount overlay).
   */
  onComplete: () => void;
}

/**
 * Phase 18 — Welcome Tour overlay (3 screens, REQ-18-ONBOARDING-01..03).
 *
 * Mount mechanism: overlay `fixed top-[32px] inset-x-0 bottom-0` — оставляет
 * 32px TitleBar видимым (drag region + window controls). Mirror pattern с
 * Setup Wizard (post-UAT 2026-05-20 v2). Background — solid `--color-bg-primary`.
 *
 * 3 экрана с **200ms crossfade** через opacity + visibility (D-DECISION-UI-1.4,
 * pattern из App.tsx tabpanel:213-216). НЕ slide left/right — tooling tone, не
 * marketing. Все 3 screens render simultaneously, only one visible.
 *
 * Navigation:
 * - **X corner close** (top-right) — везде, mark completed + unmount.
 * - **Стрелочки слева/справа посередине** (Instagram-carousel pattern):
 *   - S1: только правая (вперёд)
 *   - S2: обе
 *   - S3: только левая (назад) + «Начать» в footer
 *
 * ARIA: `role="dialog"` `aria-modal="true"` `aria-labelledby="welcome-heading"`.
 * Escape **НЕ** закрывает overlay (D-DECISION-UI-1.2).
 */
export function WelcomeTour({ onComplete }: WelcomeTourProps) {
  const { t } = useTranslation();
  const { complete } = useWelcomeTour();
  const [currentStep, setCurrentStep] = useState<0 | 1 | 2>(0);

  const handleFinish = useCallback(() => {
    complete();
    onComplete();
  }, [complete, onComplete]);

  // Close (X) и Start ведут в один и тот же exit-path (D-1.4): отметить
  // completed и unmount overlay.
  const handleClose = handleFinish;
  const handleStart = handleFinish;

  const handleBack = useCallback(() => {
    setCurrentStep((step) => (step > 0 ? ((step - 1) as 0 | 1) : step));
  }, []);

  const handleNext = useCallback(() => {
    setCurrentStep((step) => (step < 2 ? ((step + 1) as 1 | 2) : step));
  }, []);

  const canGoBack = currentStep > 0;
  const canGoNext = currentStep < 2;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-heading"
      data-testid="welcome-tour-overlay"
      className="fixed inset-x-0 bottom-0 flex flex-col items-center justify-center"
      style={{
        top: 32,
        backgroundColor: "var(--color-bg-primary)",
        zIndex: "var(--z-modal)" as unknown as number,
      }}
    >
      {/* Close (X) — top-right corner. Mark completed → unmount. */}
      <button
        type="button"
        onClick={handleClose}
        aria-label={t("app.welcome.close_aria")}
        data-testid="welcome-tour-close"
        className="absolute top-3 right-3 w-9 h-9 rounded-full flex items-center justify-center transition-colors hover:opacity-100"
        style={{
          color: "var(--color-text-muted)",
          backgroundColor: "transparent",
        }}
      >
        <X size={20} />
      </button>

      {/* Left arrow — Instagram-style floating navigation. Скрыт на S1. */}
      {canGoBack && (
        <button
          type="button"
          onClick={handleBack}
          aria-label={t("app.welcome.back")}
          data-testid="welcome-tour-arrow-left"
          className="absolute left-6 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full flex items-center justify-center transition-all hover:scale-110"
          style={{
            backgroundColor: "var(--color-bg-elevated)",
            color: "var(--color-text-primary)",
            boxShadow: "var(--shadow-md)",
            border: "1px solid var(--color-border)",
          }}
        >
          <ChevronLeft size={22} />
        </button>
      )}

      {/* Right arrow — Instagram-style floating navigation. Скрыт на S3. */}
      {canGoNext && (
        <button
          type="button"
          onClick={handleNext}
          aria-label={t("app.welcome.next")}
          data-testid="welcome-tour-arrow-right"
          className="absolute right-6 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full flex items-center justify-center transition-all hover:scale-110"
          style={{
            backgroundColor: "var(--color-bg-elevated)",
            color: "var(--color-text-primary)",
            boxShadow: "var(--shadow-md)",
            border: "1px solid var(--color-border)",
          }}
        >
          <ChevronRight size={22} />
        </button>
      )}

      <div className="max-w-[480px] w-full mx-auto px-6 flex-1 flex flex-col items-center justify-center gap-6">
        {/* Crossfade container — все 3 screens render simultaneously,
            видна только active. Visibility:hidden prevents focus traps. */}
        <div
          className="flex-1 w-full flex items-center justify-center relative"
          style={{ minHeight: 280 }}
        >
          <ScreenSlot visible={currentStep === 0}>
            <WelcomeScreen1 />
          </ScreenSlot>
          <ScreenSlot visible={currentStep === 1}>
            <WelcomeScreen2 />
          </ScreenSlot>
          <ScreenSlot visible={currentStep === 2}>
            <WelcomeScreen3 />
          </ScreenSlot>
        </div>

        <WelcomeDotIndicator currentStep={currentStep} />

        {/* Footer: «Начать» только на S3. S1/S2 footer пустой — navigation
            идёт через side-arrows + X corner. */}
        {currentStep === 2 && (
          <div className="flex items-center justify-center w-full">
            <Button
              variant="primary"
              size="md"
              onClick={handleStart}
              data-testid="welcome-tour-start"
            >
              {t("app.welcome.start")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function ScreenSlot({
  visible,
  children,
}: {
  visible: boolean;
  children: React.ReactNode;
}) {
  // Все слоты absolute-позиционированы поверх друг друга, opacity управляет
  // видимостью. 200ms transition matches Modal primitive timing.
  return (
    <div
      aria-hidden={!visible}
      className="absolute inset-0 flex items-center justify-center"
      style={{
        opacity: visible ? 1 : 0,
        visibility: visible ? "visible" : "hidden",
        transition: "opacity 200ms",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}
