import type { Meta, StoryObj } from "@storybook/react";

/**
 * Spacing — interactive showcase of 4px-base spacing scale (8 tokens).
 *
 * Co-located with `src/docs/Spacing.mdx` (canonical docs reference).
 * Both share title "Foundations/Spacing" — MDX renders as Docs tab,
 * these stories render as sibling entries.
 *
 * See also: `memory/v3/design-system/spacing.md`.
 */

const meta = {
  title: "Foundations/Spacing",
  // autodocs removed — Spacing.mdx (linked via <Meta of={}>) provides the Docs tab.
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Interactive showcase: scale visualization, common layouts (cards / forms / modals), nesting patterns, edge cases. " +
          "For canonical reference — see the Docs tab (Spacing.mdx).",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// ──────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────

const accent = "var(--color-accent-interactive)";
const surface = "var(--color-bg-surface)";
const border = "var(--color-border)";
const muted = "var(--color-text-muted)";
const primary = "var(--color-text-primary)";

const spacingTokens = [
  { token: "--space-1", value: 4, px: "4px", tailwind: "p-1" },
  { token: "--space-2", value: 8, px: "8px", tailwind: "p-2" },
  { token: "--space-3", value: 12, px: "12px", tailwind: "p-3 ⭐" },
  { token: "--space-4", value: 16, px: "16px", tailwind: "p-4" },
  { token: "--space-5", value: 20, px: "20px", tailwind: "p-5" },
  { token: "--space-6", value: 24, px: "24px", tailwind: "p-6" },
  { token: "--space-7", value: 32, px: "32px", tailwind: "p-[var(--space-7)]" },
  { token: "--space-8", value: 40, px: "40px", tailwind: "p-[var(--space-8)]" },
];

// ──────────────────────────────────────────────
// Story 1 — Scale visualization
// ──────────────────────────────────────────────

export const ScaleViz: Story = {
  name: "1. Scale visualization",
  parameters: {
    docs: {
      description: {
        story:
          "8 spacings side-by-side. Ширина цветного блока = value. 4/8/12/16/20/24/32/40 — все кратны 4.",
      },
    },
  },
  render: () => (
    <div className="flex flex-col gap-2" style={{ color: primary }}>
      {spacingTokens.map(({ token, value, px, tailwind }) => (
        <div key={token} className="flex items-center gap-4 py-2" style={{ borderBottom: `1px solid ${border}` }}>
          <div
            style={{
              width: value,
              height: 24,
              background: accent,
              borderRadius: 2,
              flexShrink: 0,
            }}
          />
          <code className="text-xs font-mono" style={{ minWidth: 120 }}>{token}</code>
          <span className="text-sm font-mono" style={{ minWidth: 48, color: muted }}>{px}</span>
          <code className="text-xs font-mono" style={{ color: muted }}>{tailwind}</code>
        </div>
      ))}
    </div>
  ),
};

// ──────────────────────────────────────────────
// Story 2 — Common UI layouts
// ──────────────────────────────────────────────

export const CommonLayouts: Story = {
  name: "2. Common layouts",
  parameters: {
    docs: {
      description: {
        story:
          "Реальные UI-паттерны из codebase: Input, Button, Card, Form, Modal — с актуальными spacing tokens.",
      },
    },
  },
  render: () => (
    <div className="flex flex-col gap-[var(--space-6)]" style={{ color: primary, maxWidth: 640 }}>
      {/* Input — padding 12px horizontal, 12px vertical */}
      <div>
        <div className="text-xs mb-2" style={{ color: muted }}>
          <strong>Input</strong> — px-3 py-3 (12/12) · space-3 ⭐ dominant
        </div>
        <input
          type="text"
          placeholder="Input with --space-3 padding"
          className="w-full rounded-[var(--radius-md)]"
          style={{
            padding: "var(--space-3)",
            background: "var(--color-input-bg)",
            border: `1px solid var(--color-input-border)`,
            color: primary,
          }}
        />
      </div>

      {/* FormField group — gap 16px between fields */}
      <div>
        <div className="text-xs mb-2" style={{ color: muted }}>
          <strong>FormField group</strong> — gap-4 (16px / space-4) между fields
        </div>
        <div className="flex flex-col gap-4">
          <input type="text" placeholder="Field 1" className="rounded-[var(--radius-md)] p-3" style={{ background: "var(--color-input-bg)", border: `1px solid var(--color-input-border)`, color: primary }} />
          <input type="text" placeholder="Field 2" className="rounded-[var(--radius-md)] p-3" style={{ background: "var(--color-input-bg)", border: `1px solid var(--color-input-border)`, color: primary }} />
          <input type="text" placeholder="Field 3" className="rounded-[var(--radius-md)] p-3" style={{ background: "var(--color-input-bg)", border: `1px solid var(--color-input-border)`, color: primary }} />
        </div>
      </div>

      {/* Button group — gap-2 (8px) */}
      <div>
        <div className="text-xs mb-2" style={{ color: muted }}>
          <strong>Button row</strong> — gap-2 (8px / space-2) между actions
        </div>
        <div className="flex gap-2">
          <button className="px-4 py-2 rounded-[var(--radius-md)] text-sm" style={{ background: accent, color: "#fff" }}>Primary</button>
          <button className="px-4 py-2 rounded-[var(--radius-md)] text-sm" style={{ background: surface, color: primary, border: `1px solid ${border}` }}>Secondary</button>
          <button className="px-4 py-2 rounded-[var(--radius-md)] text-sm" style={{ background: "transparent", color: primary, border: `1px solid ${border}` }}>Cancel</button>
        </div>
      </div>

      {/* Card — padding 20px (space-5) */}
      <div>
        <div className="text-xs mb-2" style={{ color: muted }}>
          <strong>Card</strong> — p-5 (20px / space-5) default padding
        </div>
        <div
          className="rounded-[var(--radius-lg)]"
          style={{ padding: "var(--space-5)", background: surface, border: `1px solid ${border}` }}
        >
          <h3 className="text-title-sm mb-2">Card title</h3>
          <p className="text-body-sm" style={{ color: muted }}>
            Card content — 20px padding всех сторон. Typical для dashboard stats, info blocks.
          </p>
        </div>
      </div>

      {/* Modal — padding 24px (space-6) */}
      <div>
        <div className="text-xs mb-2" style={{ color: muted }}>
          <strong>Modal</strong> — p-6 (24px / space-6) heavier padding, dialogs breathe
        </div>
        <div
          className="rounded-[var(--radius-lg)]"
          style={{ padding: "var(--space-6)", background: surface, border: `1px solid ${border}` }}
        >
          <h3 className="text-title mb-4">Подтвердить действие</h3>
          <p className="text-body mb-4" style={{ color: "var(--color-text-secondary)" }}>
            Эта операция необратима. Продолжить?
          </p>
          <div className="flex justify-end gap-2">
            <button className="px-4 py-2 rounded-[var(--radius-md)] text-sm" style={{ background: "transparent", color: primary, border: `1px solid ${border}` }}>Отмена</button>
            <button className="px-4 py-2 rounded-[var(--radius-md)] text-sm" style={{ background: "var(--color-destructive)", color: "#fff" }}>Удалить</button>
          </div>
        </div>
      </div>
    </div>
  ),
};

// ──────────────────────────────────────────────
// Story 3 — Nesting patterns
// ──────────────────────────────────────────────

export const NestingPatterns: Story = {
  name: "3. Nesting",
  parameters: {
    docs: {
      description: {
        story:
          "Как spacing комбинируется когда контейнеры вложены: outer Modal → inner Sections → Form fields.",
      },
    },
  },
  render: () => (
    <div style={{ color: primary, maxWidth: 560 }}>
      <div className="text-xs mb-3" style={{ color: muted }}>
        <strong>Nesting:</strong> Modal (p-6 / 24) → Sections (gap-4 / 16) → Inputs (p-3 / 12)
      </div>
      <div
        className="rounded-[var(--radius-lg)]"
        style={{ padding: "var(--space-6)", background: surface, border: `1px solid ${border}` }}
      >
        <h2 className="text-title mb-4">Настройки сервера</h2>
        <div className="flex flex-col gap-4">
          {/* Section 1 */}
          <section>
            <h3 className="text-body-sm font-medium mb-2" style={{ color: "var(--color-text-secondary)" }}>
              SSH connection
            </h3>
            <div className="flex flex-col gap-2">
              <input placeholder="Host" className="rounded-[var(--radius-md)] p-3 text-sm" style={{ background: "var(--color-input-bg)", border: `1px solid var(--color-input-border)`, color: primary }} />
              <input placeholder="Port" className="rounded-[var(--radius-md)] p-3 text-sm" style={{ background: "var(--color-input-bg)", border: `1px solid var(--color-input-border)`, color: primary }} />
            </div>
          </section>
          {/* Section 2 */}
          <section>
            <h3 className="text-body-sm font-medium mb-2" style={{ color: "var(--color-text-secondary)" }}>
              Credentials
            </h3>
            <div className="flex flex-col gap-2">
              <input placeholder="Username" className="rounded-[var(--radius-md)] p-3 text-sm" style={{ background: "var(--color-input-bg)", border: `1px solid var(--color-input-border)`, color: primary }} />
              <input placeholder="Password" type="password" className="rounded-[var(--radius-md)] p-3 text-sm" style={{ background: "var(--color-input-bg)", border: `1px solid var(--color-input-border)`, color: primary }} />
            </div>
          </section>
        </div>
      </div>
    </div>
  ),
};

// ──────────────────────────────────────────────
// Story 4 — Edge cases
// ──────────────────────────────────────────────

export const EdgeCases: Story = {
  name: "4. Edge cases",
  parameters: {
    docs: {
      description: {
        story:
          "Легитимные отклонения от 4px grid: TitleBar PRO badge optical trim, Sidebar widths, OS chrome. Задокументированы как exceptions в MDX §Exceptions.",
      },
    },
  },
  render: () => (
    <div className="flex flex-col gap-6" style={{ color: primary, maxWidth: 680 }}>
      {/* TitleBar PRO badge */}
      <div>
        <div className="text-xs mb-2" style={{ color: muted }}>
          <strong>TitleBar PRO badge</strong> — pt-[3px]/pb-[2px] (optical vertical trim в 32px bar)
        </div>
        <div
          className="flex items-center gap-2 rounded-[var(--radius-md)]"
          style={{ padding: "8px 16px", background: surface, border: `1px solid ${border}` }}
        >
          <span className="text-sm font-semibold">TrustTunnel</span>
          <span
            className="text-xs font-bold px-1.5 pt-[3px] pb-[2px] rounded-[var(--radius-sm)] leading-none"
            style={{
              background: "var(--color-accent-tint-10)",
              color: accent,
            }}
          >
            PRO
          </span>
        </div>
        <div className="text-xs mt-2" style={{ color: muted }}>
          Reason: true-center alignment с cap-height 12px font в 32px bar требует ~0.5px visual offset. Невозможно через 4px grid.
        </div>
      </div>

      {/* Touch target */}
      <div>
        <div className="text-xs mb-2" style={{ color: muted }}>
          <strong>Touch / click target min</strong> — 32px (`h-8`, `w-8` — matches `--space-7`)
        </div>
        <div className="flex items-center gap-2">
          <button
            className="h-8 w-8 rounded-[var(--radius-md)] flex items-center justify-center"
            style={{ background: surface, border: `1px solid ${border}`, color: primary }}
          >
            ✕
          </button>
          <span className="text-xs" style={{ color: muted }}>32×32 — минимум для accessibility (WCAG 2.1)</span>
        </div>
      </div>

      {/* Card with space-5 */}
      <div>
        <div className="text-xs mb-2" style={{ color: muted }}>
          <strong>Card «space-5» (20px)</strong> — between p-4 (16 tight) and p-6 (24 generous).
        </div>
        <div
          className="rounded-[var(--radius-lg)]"
          style={{ padding: "var(--space-5)", background: surface, border: `1px solid ${border}` }}
        >
          <p className="text-body">Card с 20px padding (--space-5). Оптимальный default для dashboard / stat cards.</p>
        </div>
      </div>

      {/* Bracket notation demo */}
      <div>
        <div className="text-xs mb-2" style={{ color: muted }}>
          <strong>32px padding через bracket notation</strong> — `p-[var(--space-7)]` вместо `p-7` (Tailwind `p-7` = 28px, collision!).
        </div>
        <div
          className="rounded-[var(--radius-lg)] text-center"
          style={{ padding: "var(--space-7)", background: surface, border: `1px solid ${border}` }}
        >
          <span className="text-body" style={{ color: muted }}>
            32px padding — EmptyState / PanelErrorBoundary pattern
          </span>
        </div>
      </div>
    </div>
  ),
};
