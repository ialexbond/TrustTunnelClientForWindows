import { useTranslation } from "react-i18next";

/**
 * Phase 18 — Welcome Screen 1 («Добро пожаловать»).
 *
 * Branding: theme-swapped shield SVG (только-dark / только-light) + wordmark
 * «TrustTunnel» в Outfit display face — mirror pattern of AboutPanel logo
 * block. Полный канонический брендинг продукта в первом welcome-touch'е.
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
      <div className="flex items-center justify-center gap-4">
        <img
          src="/logo/shield-dark.svg"
          alt=""
          width={88}
          height={88}
          className="only-dark shrink-0"
          draggable={false}
          aria-hidden="true"
        />
        <img
          src="/logo/shield-light.svg"
          alt=""
          width={88}
          height={88}
          className="only-light shrink-0"
          draggable={false}
          aria-hidden="true"
        />
        <div
          className="font-bold tracking-wide leading-none"
          style={{
            fontFamily: "var(--font-family-display)",
            fontSize: "44px",
          }}
          aria-hidden="true"
        >
          <span style={{ color: "var(--color-text-primary)" }}>Trust</span>
          <span style={{ color: "var(--color-accent-interactive)" }}>Tunnel</span>
        </div>
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
