import { Rocket } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../shared/ui/Button";

export interface WelcomeScreen3Props {
  /** Triggered кликом «Начать» внутри слайда — handler в WelcomeTour mark
   *  completed и просит parent navigate на connection tab. */
  onStart: () => void;
}

/**
 * Phase 18 — Welcome Screen 3 («Поехали!»).
 *
 * Icon container: `--color-status-connected` background (success exit-state,
 * D-DECISION-UI-1.1) + белая Rocket иконка 32px. Heading `text-display-sm`,
 * description `text-body` secondary.
 *
 * Кнопка «Начать» — primary accent (Button primary остаётся accent — 10%
 * accent rule preserved). Кнопка живёт ВНУТРИ слайда (между description и
 * dot indicator), чтобы layout не «прыгал» при переходе S2 → S3.
 */
export function WelcomeScreen3({ onStart }: WelcomeScreen3Props) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-col items-center w-full gap-6"
      data-testid="welcome-tour-screen-3"
    >
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center"
        style={{
          backgroundColor: "var(--color-status-connected)",
          boxShadow: "var(--shadow-lg)",
          // A-3: glyph drawn via currentColor inherits the theme-scoped
          // on-accent token, replacing hardcoded white.
          color: "var(--color-on-accent)",
        }}
        aria-hidden="true"
      >
        <Rocket size={32} />
      </div>
      <div className="flex flex-col items-center gap-2 text-center">
        <h1
          id="welcome-heading"
          className="text-display-sm"
          style={{ color: "var(--color-text-primary)" }}
        >
          {t("app.welcome.screen3.heading")}
        </h1>
        <p
          className="text-body max-w-md"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {t("app.welcome.screen3.description")}
        </p>
      </div>
      <Button
        variant="primary"
        size="md"
        onClick={onStart}
        data-testid="welcome-tour-start"
      >
        {t("app.welcome.start")}
      </Button>
    </div>
  );
}
