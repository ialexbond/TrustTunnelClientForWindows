import { useTranslation } from "react-i18next";

/**
 * Phase 18 — Welcome Screen 1 («Добро пожаловать»).
 *
 * Branding: theme-swapped shield SVG по центру (только-dark / только-light).
 * H1 содержит colored «TrustTunnel» wordmark (slate-teal accent) + PRO бейдж
 * inline — primary brand touch на первом welcome-экране. Без отдельного
 * wordmark block над heading'ом.
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
      <img
        src="/logo/shield-dark.svg"
        alt=""
        width={96}
        height={96}
        className="only-dark shrink-0"
        draggable={false}
        aria-hidden="true"
      />
      <img
        src="/logo/shield-light.svg"
        alt=""
        width={96}
        height={96}
        className="only-light shrink-0"
        draggable={false}
        aria-hidden="true"
      />
      <div className="flex flex-col items-center gap-2 text-center">
        <h1
          id="welcome-heading"
          className="text-display-sm flex items-center gap-2 flex-wrap justify-center"
          style={{ color: "var(--color-text-primary)" }}
        >
          <span>{t("app.welcome.screen1.heading_prefix")}</span>
          <span className="inline-flex items-start gap-1.5">
            <span style={{ fontFamily: "var(--font-family-display)" }}>
              <span style={{ color: "var(--color-text-primary)" }}>Trust</span>
              <span style={{ color: "var(--color-accent-interactive)" }}>Tunnel</span>
            </span>
            <span
              className="text-[11px] font-bold px-2 pt-[4px] pb-[3px] rounded-[var(--radius-sm)] leading-none mt-1"
              style={{
                backgroundColor: "var(--color-accent-tint-10)",
                color: "var(--color-accent-interactive)",
              }}
            >
              PRO
            </span>
          </span>
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
