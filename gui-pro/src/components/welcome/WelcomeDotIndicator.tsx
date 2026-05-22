import { Fragment } from "react";

interface WelcomeDotIndicatorProps {
  /** Индекс активного шага: 0, 1 или 2 (3-step welcome tour). */
  currentStep: 0 | 1 | 2;
}

/**
 * Phase 18 — Welcome dot indicator (D-DECISION-UI-1.3).
 *
 * 3 dot'а (8×8px) с двумя connector-линиями 32×2px между ними.
 * Active dot — `--color-accent-interactive`, inactive — `--color-border`.
 * Active prefix (т.е. connector ПЕРЕД активным dot'ом) тоже подсвечивается
 * accent — даёт «прошедший путь» metaphor.
 *
 * НЕ numbered (отличает от `wizard/StepBar.tsx`) — короткий 3-step tour,
 * numbered добавил бы визуальный шум. Pattern из UI-SPEC §Step Indicator.
 *
 * Accessibility: `aria-label="Шаг N из 3"` на container. Dot элементы
 * decorative — focus не нужен.
 */
export function WelcomeDotIndicator({ currentStep }: WelcomeDotIndicatorProps) {
  return (
    <div
      role="group"
      aria-label={`Шаг ${currentStep + 1} из 3`}
      className="flex items-center gap-2"
      data-testid="welcome-dot-indicator"
    >
      {[0, 1, 2].map((i) => {
        const isActive = i === currentStep;
        const isPast = i < currentStep;
        const dotColor =
          isActive || isPast
            ? "var(--color-accent-interactive)"
            : "var(--color-border)";
        const connectorColor =
          i <= currentStep
            ? "var(--color-accent-interactive)"
            : "var(--color-border)";
        return (
          <Fragment key={i}>
            {i > 0 && (
              <div
                aria-hidden="true"
                style={{
                  width: 32,
                  height: 2,
                  backgroundColor: connectorColor,
                  transition: "background-color var(--transition-fast)",
                }}
              />
            )}
            <div
              aria-hidden="true"
              data-testid={`welcome-dot-${i}`}
              data-active={isActive ? "true" : "false"}
              style={{
                width: isActive ? 24 : 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: dotColor,
                transition:
                  "width 300ms cubic-bezier(0.4, 0, 0.2, 1), background-color 300ms ease",
              }}
            />
          </Fragment>
        );
      })}
    </div>
  );
}
