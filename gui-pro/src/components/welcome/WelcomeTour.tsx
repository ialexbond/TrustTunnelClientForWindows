import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
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
 * Mount mechanism: full-screen overlay `fixed inset-0`, перекрывает TitleBar +
 * TabNavigation полностью (UI-SPEC §Mount). Background — solid
 * `--color-bg-primary`, без transparency — это первый экран нового пользователя.
 *
 * 3 экрана с **200ms crossfade** через opacity + visibility (D-DECISION-UI-1.4,
 * pattern из App.tsx tabpanel:213-216). НЕ slide left/right — tooling tone, не
 * marketing. Все 3 screens render simultaneously, only one visible — visibility:
 * hidden prevents focus traps на скрытых.
 *
 * Skip / Back / Next / Start:
 * - S1: «Далее» (primary) + «Пропустить» (ghost под) — REQ-18-ONBOARDING-02
 * - S2: «Назад» (secondary) + «Далее» (primary) + «Пропустить»
 * - S3: «Назад» + «Начать» (primary) + «Пропустить»
 *
 * Skip везде (D-1.4) → `complete(); onComplete();`. Start (S3) → то же самое.
 *
 * ARIA: `role="dialog"` `aria-modal="true"` `aria-labelledby="welcome-heading"`.
 * Каждый screen объявляет `<h1 id="welcome-heading">` — браузер видит активный
 * heading через visibility:visible.
 *
 * Escape **НЕ** закрывает overlay (D-DECISION-UI-1.2). Skip — единственный
 * explicit exit path. Listener вообще не attached.
 */
export function WelcomeTour({ onComplete }: WelcomeTourProps) {
  const { t } = useTranslation();
  const { complete } = useWelcomeTour();
  const [currentStep, setCurrentStep] = useState<0 | 1 | 2>(0);

  const handleFinish = useCallback(() => {
    complete();
    onComplete();
  }, [complete, onComplete]);

  // Skip и Start ведут в один и тот же exit-path (D-1.4): отметить completed
  // и unmount overlay.
  const handleSkip = handleFinish;
  const handleStart = handleFinish;

  const handleBack = useCallback(() => {
    setCurrentStep((step) => (step > 0 ? ((step - 1) as 0 | 1) : step));
  }, []);

  const handleNext = useCallback(() => {
    setCurrentStep((step) => (step < 2 ? ((step + 1) as 1 | 2) : step));
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="welcome-heading"
      data-testid="welcome-tour-overlay"
      className="fixed inset-0 flex flex-col items-center justify-center"
      style={{
        backgroundColor: "var(--color-bg-primary)",
        zIndex: "var(--z-modal)" as unknown as number,
      }}
    >
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

        <div className="flex flex-col items-center gap-3 w-full">
          <div className="flex items-center gap-3 w-full justify-center">
            {currentStep > 0 && (
              <Button
                variant="secondary"
                size="md"
                onClick={handleBack}
                data-testid="welcome-tour-back"
              >
                {t("app.welcome.back")}
              </Button>
            )}
            {currentStep < 2 ? (
              <Button
                variant="primary"
                size="md"
                onClick={handleNext}
                data-testid="welcome-tour-next"
              >
                {t("app.welcome.next")}
              </Button>
            ) : (
              <Button
                variant="primary"
                size="md"
                onClick={handleStart}
                data-testid="welcome-tour-start"
              >
                {t("app.welcome.start")}
              </Button>
            )}
          </div>
          <Button
            variant="ghost"
            size="md"
            onClick={handleSkip}
            data-testid="welcome-tour-skip"
          >
            {t("app.welcome.skip")}
          </Button>
        </div>
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
