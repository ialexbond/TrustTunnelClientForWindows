import { Shield } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Phase 18 — Welcome Screen 1 («Добро пожаловать»).
 *
 * Icon container: `--color-accent-500` background (brand-stable midpoint,
 * identical в dark/light), белая Shield иконка 32px внутри 64×64 rounded-2xl
 * с `--shadow-lg`. Heading использует semantic `text-display-sm` (32 / bold /
 * sans / tight). Description — `text-body` с `--color-text-secondary`,
 * `max-w-md` для читаемого line-length.
 *
 * Heading получает `id="welcome-heading"` — overlay container ссылается на
 * него через `aria-labelledby` (WAI-ARIA dialog accessibility).
 */
export function WelcomeScreen1() {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-col items-center w-full gap-6"
      data-testid="welcome-tour-screen-1"
    >
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center"
        style={{
          backgroundColor: "var(--color-accent-500)",
          boxShadow: "var(--shadow-lg)",
        }}
        aria-hidden="true"
      >
        <Shield size={32} className="text-white" />
      </div>
      <div className="flex flex-col items-center gap-2 text-center">
        <h1
          id="welcome-heading"
          className="text-display-sm"
          style={{ color: "var(--color-text-primary)" }}
        >
          {t("app.welcome.screen1.heading")}
        </h1>
        <p
          className="text-body max-w-md"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {t("app.welcome.screen1.description")}
        </p>
      </div>
    </div>
  );
}
