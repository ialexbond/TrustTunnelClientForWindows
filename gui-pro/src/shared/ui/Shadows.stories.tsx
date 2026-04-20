import type { Meta, StoryObj } from "@storybook/react";

/**
 * Shadows — interactive showcase of elevation system (5 tokens + focus ring).
 *
 * Co-located with `src/docs/Shadows.mdx` (canonical docs reference).
 * Both share title "Foundations/Shadows" — MDX = Docs tab, these stories = sibling entries.
 *
 * See also: `memory/v3/design-system/shadows.md`.
 */

const meta = {
  title: "Foundations/Shadows",
  // autodocs removed — Shadows.mdx (linked via <Meta of={}>) provides the Docs tab.
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Interactive showcase: scale visualization, elevation tiers by component, focus ring, do's and don'ts. " +
          "For canonical reference — see the Docs tab (Shadows.mdx).",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// ──────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────

const surface = "var(--color-bg-surface)";
const border = "var(--color-border)";
const muted = "var(--color-text-muted)";
const primary = "var(--color-text-primary)";
const accent = "var(--color-accent-interactive)";

const shadowTokens = [
  { name: "--shadow-xs", label: "xs", role: "Flat-plus (pill indicator)" },
  { name: "--shadow-sm", label: "sm", role: "Flat (card, panel)" },
  { name: "--shadow-md", label: "md", role: "Raised (dropdown, tooltip)" },
  { name: "--shadow-lg", label: "lg", role: "Floating (modal, snackbar)" },
  { name: "--shadow-xl", label: "xl", role: "Deep (heavy modal)" },
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
          "5 elevation levels side-by-side. Высота элемента определяется level'ом — xs almost flush, xl полностью оторван от surface.",
      },
    },
  },
  render: () => (
    <div className="flex flex-wrap gap-8" style={{ color: primary, padding: "var(--space-6)" }}>
      {shadowTokens.map(({ name, label, role }) => (
        <div key={name} className="flex flex-col items-center gap-3" style={{ minWidth: 160 }}>
          <div
            style={{
              width: 140,
              height: 90,
              backgroundColor: surface,
              border: `1px solid ${border}`,
              borderRadius: 8,
              boxShadow: `var(${name})`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span className="text-sm font-mono" style={{ color: muted }}>{label}</span>
          </div>
          <div className="text-center">
            <code className="text-xs font-mono">{name}</code>
            <div className="text-xs mt-1" style={{ color: muted }}>{role}</div>
          </div>
        </div>
      ))}
    </div>
  ),
};

// ──────────────────────────────────────────────
// Story 2 — Elevation tiers by component
// ──────────────────────────────────────────────

export const ElevationTiers: Story = {
  name: "2. Elevation tiers",
  parameters: {
    docs: {
      description: {
        story:
          "Реальные UI-паттерны из codebase: какой shadow на каком компоненте, от flat (card) до deep (heavy modal).",
      },
    },
  },
  render: () => (
    <div className="flex flex-col gap-8" style={{ color: primary, maxWidth: 720, padding: "var(--space-6)" }}>
      {/* Tier 1: Flat-plus */}
      <div>
        <div className="text-xs mb-3" style={{ color: muted }}>
          <strong>Flat-plus (--shadow-xs):</strong> active tab pill — едва видимая тень, намекает на elevation без отрыва от surface.
        </div>
        <div className="flex gap-2 p-2 rounded-[var(--radius-md)]" style={{ background: "var(--color-bg-elevated)", border: `1px solid ${border}` }}>
          <button className="px-3 py-2 text-sm" style={{ color: muted }}>Overview</button>
          <button
            className="px-3 py-2 text-sm rounded-[var(--radius-sm)]"
            style={{ background: surface, color: primary, boxShadow: "var(--shadow-xs)" }}
          >
            Users
          </button>
          <button className="px-3 py-2 text-sm" style={{ color: muted }}>Settings</button>
        </div>
      </div>

      {/* Tier 2: Flat (card) */}
      <div>
        <div className="text-xs mb-3" style={{ color: muted }}>
          <strong>Flat (--shadow-sm):</strong> Card primitive — subtle lift для content blocks.
        </div>
        <div
          className="p-4 rounded-[var(--radius-lg)]"
          style={{ background: surface, border: `1px solid ${border}`, boxShadow: "var(--shadow-sm)" }}
        >
          <h3 className="text-title-sm mb-1">Card title</h3>
          <p className="text-body-sm" style={{ color: muted }}>Card content with --shadow-sm.</p>
        </div>
      </div>

      {/* Tier 3: Raised (dropdown) */}
      <div>
        <div className="text-xs mb-3" style={{ color: muted }}>
          <strong>Raised (--shadow-md):</strong> dropdowns / tooltips — видимый отрыв от underlying content.
        </div>
        <div style={{ position: "relative", height: 60 }}>
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              padding: 12,
              background: surface,
              border: `1px solid ${border}`,
              borderRadius: 8,
              boxShadow: "var(--shadow-md)",
              minWidth: 200,
            }}
          >
            <div className="text-sm">Dropdown menu item</div>
            <div className="text-sm" style={{ color: muted }}>Dropdown menu item</div>
          </div>
        </div>
      </div>

      {/* Tier 4: Floating (modal) */}
      <div>
        <div className="text-xs mb-3" style={{ color: muted }}>
          <strong>Floating (--shadow-lg):</strong> modals / snackbars — clear separation от page content.
        </div>
        <div
          className="p-5 rounded-[var(--radius-lg)]"
          style={{ background: surface, border: `1px solid ${border}`, boxShadow: "var(--shadow-lg)" }}
        >
          <h3 className="text-title mb-2">Modal dialog</h3>
          <p className="text-body" style={{ color: muted }}>Floating above page content with --shadow-lg.</p>
        </div>
      </div>

      {/* Tier 5: Deep (heavy modal) */}
      <div>
        <div className="text-xs mb-3" style={{ color: muted }}>
          <strong>Deep (--shadow-xl):</strong> heavy modals — максимальное разделение, user fully focused on dialog.
        </div>
        <div
          className="p-6 rounded-[var(--radius-xl)]"
          style={{ background: surface, border: `1px solid ${border}`, boxShadow: "var(--shadow-xl)" }}
        >
          <h3 className="text-title mb-2">Heavy modal (ImportConfigModal pattern)</h3>
          <p className="text-body" style={{ color: muted }}>--shadow-xl: 16px 40px, deepest elevation level.</p>
        </div>
      </div>
    </div>
  ),
};

// ──────────────────────────────────────────────
// Story 3 — Focus ring
// ──────────────────────────────────────────────

export const FocusRing: Story = {
  name: "3. Focus ring",
  parameters: {
    docs: {
      description: {
        story:
          "Double-ring pattern — внутреннее 2px bg-primary (creates gap) + внешнее 4px accent (visible on any surface). Применяется через focus-visible:shadow-[var(--focus-ring)].",
      },
    },
  },
  render: () => (
    <div className="flex flex-col gap-6" style={{ color: primary, padding: "var(--space-6)" }}>
      <div>
        <div className="text-xs mb-2" style={{ color: muted }}>
          Simulated focused button (tab focus-visible):
        </div>
        <button
          className="px-4 py-2 rounded-[var(--radius-md)] text-button"
          style={{
            background: accent,
            color: "#fff",
            boxShadow: "var(--focus-ring)",
          }}
        >
          Focused button
        </button>
      </div>

      <div>
        <div className="text-xs mb-2" style={{ color: muted }}>
          Focused input:
        </div>
        <input
          type="text"
          placeholder="Input с focus ring"
          className="w-full max-w-sm rounded-[var(--radius-md)] p-3"
          style={{
            background: "var(--color-input-bg)",
            border: `1px solid var(--color-input-border)`,
            color: primary,
            boxShadow: "var(--focus-ring)",
          }}
        />
      </div>

      <div className="text-xs" style={{ color: muted, marginTop: 8 }}>
        <strong>Value:</strong> <code className="font-mono">0 0 0 2px var(--color-bg-primary), 0 0 0 4px var(--color-accent-interactive)</code>
        <br />
        Inner ring matches background (creates gap) → outer ring is accent → works on any surface.
      </div>
    </div>
  ),
};

// ──────────────────────────────────────────────
// Story 4 — Don't (glow anti-patterns)
// ──────────────────────────────────────────────

export const DontGlow: Story = {
  name: "4. Don't — glow effects",
  parameters: {
    docs: {
      description: {
        story:
          "Anti-patterns — colored glow shadows. Противоречат минималистичной философии, создают визуальный шум. Всё удалено в Phase 14.x cleanup.",
      },
    },
  },
  render: () => (
    <div className="flex flex-col gap-8" style={{ color: primary, padding: "var(--space-6)" }}>
      <div className="text-xs" style={{ color: muted, marginBottom: 8 }}>
        ❌ <strong>Don't:</strong> colored / tinted shadows (glow). ✅ <strong>Do:</strong> --shadow-* (elevation) or none.
      </div>

      {/* Comparison: accent glow vs clean shadow */}
      <div className="grid grid-cols-2 gap-8">
        {/* BAD */}
        <div>
          <div className="text-xs mb-3" style={{ color: "var(--color-danger-500)" }}>❌ Accent glow (removed)</div>
          <div
            className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{
              backgroundColor: "var(--color-accent-500)",
              boxShadow: "0 8px 32px var(--color-accent-tint-30), 0 0 64px var(--color-accent-tint-15)",
            }}
          >
            <span style={{ color: "#fff", fontWeight: 600 }}>👆</span>
          </div>
          <div className="text-xs mt-3 font-mono" style={{ color: muted }}>
            0 8px 32px accent-tint-30,<br />0 0 64px accent-tint-15
          </div>
        </div>
        {/* GOOD */}
        <div>
          <div className="text-xs mb-3" style={{ color: "var(--color-success-500)" }}>✅ Clean shadow-lg</div>
          <div
            className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{
              backgroundColor: "var(--color-accent-500)",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <span style={{ color: "#fff", fontWeight: 600 }}>👍</span>
          </div>
          <div className="text-xs mt-3 font-mono" style={{ color: muted }}>
            var(--shadow-lg)
          </div>
        </div>
      </div>

      {/* Comparison: success glow vs clean shadow */}
      <div className="grid grid-cols-2 gap-8">
        <div>
          <div className="text-xs mb-3" style={{ color: "var(--color-danger-500)" }}>❌ Success glow (removed)</div>
          <div
            className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{
              backgroundColor: "var(--color-success-500)",
              boxShadow: "0 8px 24px var(--color-success-tint-25)",
            }}
          >
            <span style={{ color: "#fff" }}>✓</span>
          </div>
          <div className="text-xs mt-3 font-mono" style={{ color: muted }}>
            0 8px 24px success-tint-25
          </div>
        </div>
        <div>
          <div className="text-xs mb-3" style={{ color: "var(--color-success-500)" }}>✅ Clean shadow-lg</div>
          <div
            className="mx-auto w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{
              backgroundColor: "var(--color-success-500)",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <span style={{ color: "#fff" }}>✓</span>
          </div>
          <div className="text-xs mt-3 font-mono" style={{ color: muted }}>
            var(--shadow-lg)
          </div>
        </div>
      </div>

      <div className="text-xs" style={{ color: muted, marginTop: 16 }}>
        <strong>Почему clean лучше:</strong>
        <ul className="mt-2 space-y-1 list-disc pl-5">
          <li>Consistent — все elevated elements выглядят одинаково (modal, icon, card).</li>
          <li>Minimalist — нет color-dependent visual noise.</li>
          <li>Theme-agnostic — работает в dark и light identically (tint varies, shadow-lg doesn't).</li>
          <li>Performance — single simple shadow vs 2-layer complex.</li>
        </ul>
      </div>
    </div>
  ),
};
