import { Globe, Monitor, Server, ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * Phase 18 — Welcome Screen 2 («Как это работает»).
 *
 * Hero icon: Globe внутри `--color-accent-500` 64×64 rounded-2xl
 * `--shadow-lg`. Heading `text-display-sm`, description `text-body`
 * secondary.
 *
 * 3-block diagram (PC ↔ VPS ↔ Internet) под heading:
 * каждый блок 64×64 (`w-16 h-16`) `rounded-lg` `--color-bg-surface`
 * с border-1px `--color-border`. Lucide icon 20px центрирован, label
 * под — `text-caption` `--color-text-muted`. Стрелки между блоками —
 * `<ArrowRight size={16}>` muted, с label-caption под стрелкой.
 * НЕ animate on mount (минимизируем визуальный шум).
 */
export function WelcomeScreen2() {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-col items-center w-full gap-6"
      data-testid="welcome-tour-screen-2"
    >
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center"
        style={{
          backgroundColor: "var(--color-accent-500)",
          boxShadow: "var(--shadow-lg)",
          // A-3: glyph drawn via currentColor inherits the theme-scoped
          // on-accent token, replacing hardcoded white (≈3.53:1 on dark teal).
          color: "var(--color-on-accent)",
        }}
        aria-hidden="true"
      >
        <Globe size={32} />
      </div>
      <div className="flex flex-col items-center gap-2 text-center">
        <h1
          id="welcome-heading"
          className="text-display-sm"
          style={{ color: "var(--color-text-primary)" }}
        >
          {t("app.welcome.screen2.heading")}
        </h1>
        <p
          className="text-body max-w-md"
          style={{ color: "var(--color-text-secondary)" }}
        >
          {t("app.welcome.screen2.description")}
        </p>
      </div>
      {/* 3-block diagram PC ↔ VPS ↔ Internet. */}
      <div
        className="flex items-center gap-3 mt-2"
        role="img"
        aria-label={t("app.welcome.screen2.description")}
      >
        {/* UAT-F02: icons are size-20 (was 24) so each 64×64 block + arrows fit the 432px onboarding width. */}
        <DiagramBlock
          icon={<Monitor size={20} />}
          label={t("app.welcome.screen2.block_pc")}
        />
        <DiagramArrow label={t("app.welcome.screen2.arrow_encrypted")} />
        <DiagramBlock
          icon={<Server size={20} />}
          label={t("app.welcome.screen2.block_vps")}
        />
        <DiagramArrow label={t("app.welcome.screen2.arrow_secure")} />
        <DiagramBlock
          icon={<Globe size={20} />}
          label={t("app.welcome.screen2.block_internet")}
        />
      </div>
    </div>
  );
}

function DiagramBlock({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div
        // UAT-F02: 64×64 (was 80×80) keeps the 3-block PC↔VPS↔Internet row inside the 432px width.
        className="w-16 h-16 rounded-lg flex items-center justify-center"
        style={{
          backgroundColor: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text-secondary)",
        }}
      >
        {icon}
      </div>
      <span
        className="text-caption"
        style={{ color: "var(--color-text-muted)" }}
      >
        {label}
      </span>
    </div>
  );
}

function DiagramArrow({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <ArrowRight
        size={16}
        style={{ color: "var(--color-text-muted)" }}
        aria-hidden="true"
      />
      <span
        className="text-caption max-w-[80px] text-center leading-tight"
        style={{ color: "var(--color-text-muted)" }}
      >
        {label}
      </span>
    </div>
  );
}
