import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { useWelcomeTour } from "../../shared/hooks/useWelcomeTour";
import { WelcomeScreen1 } from "./screens/WelcomeScreen1";
import { WelcomeScreen2 } from "./screens/WelcomeScreen2";
import { WelcomeScreen3 } from "./screens/WelcomeScreen3";
import { WelcomeDotIndicator } from "./WelcomeDotIndicator";

/** Intent contract: parent узнаёт КАК тур был закрыт чтобы решить навигацию. */
export type WelcomeTourCompleteIntent = "skip" | "start";

export interface WelcomeTourProps {
  /**
   * Вызывается когда тур завершён или пропущен. Hook `useWelcomeTour.complete()`
   * уже отметит флаг в localStorage — callback нужен parent'у для триггера
   * re-render (unmount overlay) И для conditional navigate.
   *
   * Intent:
   * - `'skip'` → user закрыл через X corner — остаёмся где были
   * - `'start'` → user нажал «Начать» на S3 — parent navigates на connection
   */
  onComplete: (intent: WelcomeTourCompleteIntent) => void;
}

/**
 * Phase 18 — Welcome Tour overlay (3 screens, REQ-18-ONBOARDING-01..03).
 *
 * Mount mechanism: overlay `fixed top-[32px] inset-x-0 bottom-0` — оставляет
 * 32px TitleBar видимым (drag region + window controls). Mirror pattern с
 * Setup Wizard (post-UAT 2026-05-20 v2). Background — solid `--color-bg-primary`.
 *
 * Все 3 screens render simultaneously, видна только active через
 * opacity+visibility 200ms crossfade. ScreenSlot имеет фиксированный
 * minHeight 360px — layout не «прыгает» при переходе S2 → S3 (Start кнопка
 * живёт внутри Screen 3 контейнера).
 *
 * Navigation:
 * - **X corner close** (top-right) → `onComplete('skip')` — mark completed,
 *   parent остаётся на текущей вкладке.
 * - **Стрелочки слева/справа посередине** (Instagram-carousel pattern):
 *   S1 только правая · S2 обе · S3 только левая.
 * - **«Начать» внутри Screen 3** → `onComplete('start')` — mark completed,
 *   parent navigates на connection вкладку.
 *
 * ARIA: `role="dialog"` `aria-modal="true"` `aria-labelledby="welcome-heading"`.
 * Escape **НЕ** закрывает overlay (D-DECISION-UI-1.2).
 */
export function WelcomeTour({ onComplete }: WelcomeTourProps) {
  const { t } = useTranslation();
  const { complete } = useWelcomeTour();
  const [currentStep, setCurrentStep] = useState<0 | 1 | 2>(0);

  const handleClose = useCallback(() => {
    complete();
    onComplete("skip");
  }, [complete, onComplete]);

  const handleStart = useCallback(() => {
    complete();
    onComplete("start");
  }, [complete, onComplete]);

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

      <div className="max-w-[480px] w-full mx-auto px-6 flex-1 flex flex-col items-center justify-center">
        {/* Horizontal slide carousel — все 3 slot'а live в DOM. Active
            slot transform: translateX(0), off-screen left = translateX(-100%),
            right = translateX(+100%). overflow:hidden на parent скрывает
            off-screen контент. transition 300ms cubic-bezier даёт smooth
            push-pull slide эффект (Instagram-style). */}
        <div
          className="w-full relative"
          style={{ minHeight: 360, overflow: "hidden" }}
        >
          <ScreenSlot offset={0 - currentStep}>
            <WelcomeScreen1 />
          </ScreenSlot>
          <ScreenSlot offset={1 - currentStep}>
            <WelcomeScreen2 />
          </ScreenSlot>
          <ScreenSlot offset={2 - currentStep}>
            <WelcomeScreen3 onStart={handleStart} />
          </ScreenSlot>
        </div>
      </div>

      {/* Dot indicator зафиксирован в нижней части overlay'я (вне flex
          contentaaa). bottom=80px = ~16px над линией где была бы верхняя
          грань нижней TabNavigation (64px), чтобы визуально совпадало с
          edge tab bar'а независимо от высоты content area. */}
      <div className="absolute inset-x-0 flex justify-center" style={{ bottom: 80 }}>
        <WelcomeDotIndicator currentStep={currentStep} />
      </div>
    </div>
  );
}

function ScreenSlot({
  offset,
  children,
}: {
  /** offset = (slotIndex - currentStep). 0 = active (centered), <0 = left
   *  off-screen, >0 = right off-screen. Width transition 300ms. */
  offset: number;
  children: React.ReactNode;
}) {
  const active = offset === 0;
  return (
    <div
      aria-hidden={!active}
      className="absolute inset-0 flex items-center justify-center"
      style={{
        transform: `translateX(${offset * 100}%)`,
        transition: "transform 300ms cubic-bezier(0.4, 0, 0.2, 1)",
        pointerEvents: active ? "auto" : "none",
      }}
    >
      {children}
    </div>
  );
}
