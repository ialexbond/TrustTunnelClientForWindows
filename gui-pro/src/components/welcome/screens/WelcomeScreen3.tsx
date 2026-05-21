import { Rocket } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Phase 18 — Welcome Screen 3 («Поехали!»).
 *
 * Icon container: `--color-status-connected` background (success exit-state,
 * D-DECISION-UI-1.1) + белая Rocket иконка 32px. Heading `text-display-sm`,
 * description `text-body` secondary.
 *
 * Кнопка «Начать» — primary accent (Button primary остаётся accent — 10%
 * accent rule preserved). Success-themed только icon container; CTA продолжает
 * accent flow.
 */
export function WelcomeScreen3() {
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
        }}
        aria-hidden="true"
      >
        <Rocket size={32} className="text-white" />
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
    </div>
  );
}
