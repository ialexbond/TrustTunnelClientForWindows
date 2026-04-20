import type { Meta, StoryObj } from "@storybook/react";

/**
 * Typography — interactive showcase of v2 typography system (Phase 14.2).
 *
 * Co-located with `src/docs/Typography.mdx` (canonical docs reference).
 * Both share title "Foundations/Typography" — MDX renders as Docs tab,
 * these stories render as sibling entries in the same Storybook section.
 *
 * See also: `memory/v3/design-system/typography.md`.
 */

const meta = {
  title: "Foundations/Typography",
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Interactive showcase: sizes, weights, line-heights, letter-spacing, font families, semantic classes, Cyrillic readability. " +
          "For canonical reference — see the Docs tab (Typography.mdx).",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// ──────────────────────────────────────────────
// Shared constants
// ──────────────────────────────────────────────

const SAMPLE_RU = "Быстрая коричневая лиса перепрыгивает через ленивую собаку";
const SAMPLE_EN = "The quick brown fox jumps over the lazy dog";
const SAMPLE_MIX = "Быстрая коричневая лиса / The quick brown fox";

// ──────────────────────────────────────────────
// Story 1 — Size Scale (10 шагов)
// ──────────────────────────────────────────────

export const SizeScale: Story = {
  name: "1. Size scale",
  parameters: {
    docs: {
      description: {
        story:
          "10 размеров от 12px (caption) до 48px (wordmark). UI scale — шаг 2 (12→14→16→18→20→22→24). Display scale — шаг 8 (32→40→48). Всё чётное. Минимум 12px (floor для кириллицы на Win11 HiDPI).",
      },
    },
  },
  render: () => {
    const sizes = [
      { tailwind: "text-xs", size: "12px", token: "caption", role: "meta, version, timestamp" },
      { tailwind: "text-sm", size: "14px", token: "body-sm", role: "helper, secondary body" },
      { tailwind: "text-base", size: "16px", token: "body", role: "default body ⭐" },
      { tailwind: "text-lg", size: "18px", token: "body-lg", role: "emphasis, subtitle" },
      { tailwind: "text-xl", size: "20px", token: "title-sm", role: "card titles" },
      { tailwind: "text-2xl", size: "24px", token: "title-lg", role: "page headings" },
      { tailwind: "text-3xl", size: "32px", token: "display-sm", role: "wizard hero" },
      { tailwind: "text-4xl", size: "40px", token: "display", role: "splash, critical" },
      { tailwind: "text-5xl", size: "48px", token: "display-lg", role: "wordmark only" },
    ];

    return (
      <div className="flex flex-col gap-6" style={{ color: "var(--color-text-primary)" }}>
        {sizes.map(({ tailwind, size, token, role }) => (
          <div key={tailwind} className="flex flex-col gap-1 border-l-2 pl-4" style={{ borderColor: "var(--color-border)" }}>
            <div className="flex items-center gap-3 text-xs" style={{ color: "var(--color-text-secondary)" }}>
              <code className="font-mono">{tailwind}</code>
              <span>·</span>
              <span>{size}</span>
              <span>·</span>
              <code className="font-mono">--font-size-{token}</code>
              <span>·</span>
              <span style={{ color: "var(--color-text-muted)" }}>{role}</span>
            </div>
            <div className={tailwind}>{SAMPLE_MIX}</div>
          </div>
        ))}
      </div>
    );
  },
};

// ──────────────────────────────────────────────
// Story 2 — Weight Comparison
// ──────────────────────────────────────────────

export const WeightComparison: Story = {
  name: "2. Weight comparison",
  parameters: {
    docs: {
      description: {
        story:
          "Четыре веса: Regular (400) для body · Medium (500) для buttons/labels/subtitle · Semibold (600) для headings · Bold (700) только для display/wordmark.",
      },
    },
  },
  render: () => {
    const weights = [
      { tailwind: "font-normal", value: 400, role: "body, paragraph, description" },
      { tailwind: "font-medium", value: 500, role: "buttons, labels, subtitle, chips, active tab" },
      { tailwind: "font-semibold", value: 600, role: "headings, card/section titles" },
      { tailwind: "font-bold", value: 700, role: "display, wordmark, hero only" },
    ];

    return (
      <div className="flex flex-col gap-6" style={{ color: "var(--color-text-primary)" }}>
        {weights.map(({ tailwind, value, role }) => (
          <div key={tailwind} className="flex flex-col gap-1 border-l-2 pl-4" style={{ borderColor: "var(--color-border)" }}>
            <div className="flex items-center gap-3 text-xs" style={{ color: "var(--color-text-secondary)" }}>
              <code className="font-mono">{tailwind}</code>
              <span>·</span>
              <span>{value}</span>
              <span>·</span>
              <span style={{ color: "var(--color-text-muted)" }}>{role}</span>
            </div>
            <div className={`text-lg ${tailwind}`}>{SAMPLE_MIX}</div>
          </div>
        ))}
      </div>
    );
  },
};

// ──────────────────────────────────────────────
// Story 3 — Line Heights
// ──────────────────────────────────────────────

export const LineHeights: Story = {
  name: "3. Line heights",
  parameters: {
    docs: {
      description: {
        story:
          "Четыре line-height: tight (1.2) для display · snug (1.35) для titles · normal (1.5) для body default · relaxed (1.625) для long-form (changelog, release notes).",
      },
    },
  },
  render: () => {
    const paragraph =
      "TrustTunnel — VPN-клиент для Windows с поддержкой TLS 1.3 и quantum-resistant хэндшейка. " +
      "Protocol wraps traffic in HTTPS-like envelope через CDN. Работает в регионах с DPI. " +
      "Configuration через SSH к серверу — вставляешь deeplink, подключаешься без CLI.";

    const heights = [
      { tailwind: "leading-tight", ratio: 1.2, role: "display 32px+" },
      { tailwind: "leading-snug", ratio: 1.35, role: "titles 18-24px" },
      { tailwind: "leading-normal", ratio: 1.5, role: "body 14-16px (default)" },
      { tailwind: "leading-relaxed", ratio: 1.625, role: "long-form, changelog, release notes" },
    ];

    return (
      <div className="flex flex-col gap-8" style={{ color: "var(--color-text-primary)" }}>
        {heights.map(({ tailwind, ratio, role }) => (
          <div key={tailwind} className="flex flex-col gap-2 border-l-2 pl-4" style={{ borderColor: "var(--color-border)" }}>
            <div className="flex items-center gap-3 text-xs" style={{ color: "var(--color-text-secondary)" }}>
              <code className="font-mono">{tailwind}</code>
              <span>·</span>
              <span>{ratio}</span>
              <span>·</span>
              <span style={{ color: "var(--color-text-muted)" }}>{role}</span>
            </div>
            <p className={`text-base ${tailwind}`} style={{ maxWidth: 600 }}>
              {paragraph}
            </p>
          </div>
        ))}
      </div>
    );
  },
};

// ──────────────────────────────────────────────
// Story 4 — Letter Spacing
// ──────────────────────────────────────────────

export const LetterSpacing: Story = {
  name: "4. Letter spacing",
  parameters: {
    docs: {
      description: {
        story:
          "Три tracking: tight (-0.01em) для display (автоматически в .text-display-*), normal (0) для body, wide (0.02em) для buttons (автоматически в .text-button) + UPPERCASE.",
      },
    },
  },
  render: () => {
    const variants = [
      { tailwind: "tracking-tight", value: "-0.01em", role: "display 32px+ — уплотняет крупный текст", sample: "TRUSTTUNNEL" },
      { tailwind: "tracking-normal", value: "0", role: "body default", sample: "Обычный параграф" },
      { tailwind: "tracking-wide", value: "0.02em", role: "buttons, UPPERCASE badges, keyboard shortcuts", sample: "ПОДКЛЮЧИТЬСЯ" },
    ];

    return (
      <div className="flex flex-col gap-8" style={{ color: "var(--color-text-primary)" }}>
        {variants.map(({ tailwind, value, role, sample }) => (
          <div key={tailwind} className="flex flex-col gap-2 border-l-2 pl-4" style={{ borderColor: "var(--color-border)" }}>
            <div className="flex items-center gap-3 text-xs" style={{ color: "var(--color-text-secondary)" }}>
              <code className="font-mono">{tailwind}</code>
              <span>·</span>
              <span>{value}</span>
              <span>·</span>
              <span style={{ color: "var(--color-text-muted)" }}>{role}</span>
            </div>
            <div className={`text-3xl font-bold ${tailwind}`}>{sample}</div>
          </div>
        ))}
      </div>
    );
  },
};

// ──────────────────────────────────────────────
// Story 5 — Font Families
// ──────────────────────────────────────────────

export const FontFamilies: Story = {
  name: "5. Font families",
  parameters: {
    docs: {
      description: {
        story:
          "Три шрифта: Geist Sans (весь UI по умолчанию) · Geist Mono (technical data — IP, SHA, hex, tabular numbers) · Outfit (ТОЛЬКО wordmark «TrustTunnel»). Все поддерживают кириллицу.",
      },
    },
  },
  render: () => {
    const families = [
      {
        tailwind: "font-sans",
        name: "Geist Sans",
        role: "весь UI text",
        sample: "TrustTunnel · 192.168.1.1 · Быстрая лиса",
      },
      {
        tailwind: "font-mono",
        name: "Geist Mono",
        role: "technical data: IP, hex, logs, tabular numbers",
        sample: "TrustTunnel · 192.168.1.1 · Быстрая лиса",
      },
      {
        tailwind: "font-display",
        name: "Outfit",
        role: "wordmark «TrustTunnel» only",
        sample: "TrustTunnel",
      },
    ];

    return (
      <div className="flex flex-col gap-8" style={{ color: "var(--color-text-primary)" }}>
        {families.map(({ tailwind, name, role, sample }) => (
          <div key={tailwind} className="flex flex-col gap-2 border-l-2 pl-4" style={{ borderColor: "var(--color-border)" }}>
            <div className="flex items-center gap-3 text-xs" style={{ color: "var(--color-text-secondary)" }}>
              <code className="font-mono">{tailwind}</code>
              <span>·</span>
              <span style={{ color: "var(--color-text-muted)" }}>{name} — {role}</span>
            </div>
            <div className={`text-2xl ${tailwind}`}>{sample}</div>
          </div>
        ))}

        <div className="border-t pt-6 mt-4" style={{ borderColor: "var(--color-border)" }}>
          <div className="text-xs mb-3" style={{ color: "var(--color-text-muted)" }}>
            Side-by-side: «Ваш IP: 192.168.1.1» — label sans, value mono
          </div>
          <div className="flex items-baseline gap-2 text-lg">
            <span>Ваш IP:</span>
            <span className="font-mono">192.168.1.1</span>
          </div>
        </div>
      </div>
    );
  },
};

// ──────────────────────────────────────────────
// Story 6 — Semantic Composition
// ──────────────────────────────────────────────

export const SemanticComposition: Story = {
  name: "6. Semantic composition",
  parameters: {
    docs: {
      description: {
        story:
          "Mini-card демонстрация semantic composite classes применённых атомарно — prefer эти классы вместо ручных комбинаций text-lg+font-semibold+leading-snug.",
      },
    },
  },
  render: () => (
    <div className="flex flex-col gap-8" style={{ color: "var(--color-text-primary)", maxWidth: 700 }}>
      {/* Example 1: user card */}
      <div
        className="flex flex-col gap-2 p-4 rounded-[var(--radius-lg)]"
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
        }}
      >
        <span className="text-caption" style={{ color: "var(--color-text-muted)" }}>
          User · ID 42 · активен 5 мин
        </span>
        <h3 className="text-title-sm">Пользователь Alice</h3>
        <p className="text-body" style={{ color: "var(--color-text-secondary)" }}>
          Подключен через корпоративный VPN с TLS 1.3 и quantum-resistant хендшейком.
        </p>
        <div className="flex items-center gap-2 mt-2">
          <code className="text-mono-sm" style={{ color: "var(--color-text-muted)" }}>
            8a:bc:12:de:34:f5:67:89:ab:cd:ef
          </code>
        </div>
        <div className="flex items-center gap-2 mt-3">
          <button
            className="text-button px-4 py-2 rounded-[var(--radius-md)]"
            style={{
              background: "var(--color-accent-interactive)",
              color: "#fff",
            }}
          >
            Подключить
          </button>
          <button
            className="text-button px-4 py-2 rounded-[var(--radius-md)]"
            style={{
              background: "transparent",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-primary)",
            }}
          >
            Отмена
          </button>
        </div>
      </div>

      {/* Example 2: stat card */}
      <div
        className="flex flex-col gap-2 p-4 rounded-[var(--radius-lg)]"
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
        }}
      >
        <span className="text-caption" style={{ color: "var(--color-text-muted)" }}>
          Ping
        </span>
        <div className="flex items-baseline gap-1">
          <span className="text-title-lg font-mono" style={{ color: "var(--color-success-400)" }}>
            42
          </span>
          <span className="text-body font-mono" style={{ color: "var(--color-text-muted)" }}>
            ms
          </span>
        </div>
      </div>

      {/* Example 3: modal heading */}
      <div
        className="flex flex-col gap-3 p-5 rounded-[var(--radius-lg)]"
        style={{
          background: "var(--color-bg-surface)",
          border: "1px solid var(--color-border)",
        }}
      >
        <h2 className="text-title">Подключение к серверу</h2>
        <p className="text-body" style={{ color: "var(--color-text-secondary)" }}>
          Введите deeplink или данные SSH для добавления нового сервера в клиент.
        </p>
        <p className="text-caption" style={{ color: "var(--color-text-muted)" }}>
          Обновлено 5 минут назад
        </p>
      </div>
    </div>
  ),
};

// ──────────────────────────────────────────────
// Story 7 — Cyrillic vs Latin
// ──────────────────────────────────────────────

export const CyrillicVsLatin: Story = {
  name: "7. Cyrillic vs Latin",
  parameters: {
    docs: {
      description: {
        story:
          "Side-by-side RU и EN на разных размерах. Проверка читаемости кириллицы на body sizes (12-18px). Русский визуально шире английского на ~15% — длинные слова («Переподключиться») требуют больше пространства.",
      },
    },
  },
  render: () => {
    const sizes: Array<{ tailwind: string; size: string; label: string }> = [
      { tailwind: "text-xs", size: "12px", label: "caption" },
      { tailwind: "text-sm", size: "14px", label: "body-sm" },
      { tailwind: "text-base", size: "16px", label: "body" },
      { tailwind: "text-lg", size: "18px", label: "body-lg" },
      { tailwind: "text-xl", size: "20px", label: "title-sm" },
    ];

    const ruWords = ["Переподключиться", "Синхронизация", "Деинсталлировать", "Сертификат"];
    const enWords = ["Reconnect", "Sync", "Uninstall", "Certificate"];

    return (
      <div className="flex flex-col gap-6" style={{ color: "var(--color-text-primary)" }}>
        <div className="grid grid-cols-3 gap-4 text-xs pb-2 border-b" style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>
          <span>Tailwind class</span>
          <span>RU (кириллица)</span>
          <span>EN (latin)</span>
        </div>

        {sizes.map(({ tailwind, size, label }) => (
          <div key={tailwind} className="grid grid-cols-3 gap-4 items-baseline">
            <div className="flex flex-col">
              <code className="text-xs font-mono" style={{ color: "var(--color-text-secondary)" }}>
                {tailwind}
              </code>
              <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                {size} · {label}
              </span>
            </div>
            <div className={tailwind}>{SAMPLE_RU}</div>
            <div className={tailwind}>{SAMPLE_EN}</div>
          </div>
        ))}

        {/* Common UI labels side-by-side */}
        <div className="mt-8 pt-6 border-t" style={{ borderColor: "var(--color-border)" }}>
          <div className="text-xs mb-3" style={{ color: "var(--color-text-muted)" }}>
            UI labels — длинные RU слова на caption (12px) и body-sm (14px):
          </div>
          <table className="w-full text-sm" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)", color: "var(--color-text-muted)" }}>
                <th className="text-left py-2 text-xs font-medium">RU (caption 12)</th>
                <th className="text-left py-2 text-xs font-medium">EN (caption 12)</th>
                <th className="text-left py-2 text-xs font-medium">RU (body-sm 14)</th>
                <th className="text-left py-2 text-xs font-medium">EN (body-sm 14)</th>
              </tr>
            </thead>
            <tbody>
              {ruWords.map((ru, i) => (
                <tr key={ru} style={{ borderBottom: "1px solid var(--color-border)" }}>
                  <td className="py-2 text-xs">{ru}</td>
                  <td className="py-2 text-xs">{enWords[i]}</td>
                  <td className="py-2 text-sm">{ru}</td>
                  <td className="py-2 text-sm">{enWords[i]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  },
};
