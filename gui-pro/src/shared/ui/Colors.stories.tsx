import type { Meta, StoryObj } from "@storybook/react";

/**
 * Colors — interactive showcase of complete color system.
 *
 * Co-located with `src/docs/Colors.mdx` (canonical docs reference).
 * Both share title "Foundations/Colors" — MDX = Docs tab, these = sibling stories.
 *
 * See also: `memory/v3/design-system/colors.md`.
 */

const meta = {
  title: "Foundations/Colors",
  // autodocs removed — Colors.mdx (via <Meta of={}>) provides the Docs tab.
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Interactive showcase: accent scale, semantic layers (bg + text), status colors, tint system, contrast matrix, component palette, anti-patterns. " +
          "For canonical reference — see the Docs tab (Colors.mdx).",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

const accent = {
  50: "#f0f4f4", 100: "#d9e8e7", 200: "#b3d1cf", 300: "#80b3b0", 400: "#4d9490",
  500: "#2d7a76", 600: "#236260", 700: "#1a4a48", 800: "#123533", 900: "#0b2221",
};

const status = {
  success: { 400: "#34d399", 500: "#10b981", 600: "#059669" },
  warning: { 400: "#fbbf24", 500: "#f59e0b", 600: "#d97706" },
  danger:  { 400: "#f87171", 500: "#ef4444", 600: "#dc2626" },
  info:    { 400: "#60a5fa", 500: "#3b82f6", 600: "#2563eb" },
};

// Simple WCAG contrast ratio calculation (for display only — not production formula)
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function ratioBadge(r: number): { label: string; color: string } {
  if (r >= 7) return { label: "AAA", color: "var(--color-success-500)" };
  if (r >= 4.5) return { label: "AA", color: "var(--color-success-500)" };
  if (r >= 3) return { label: "AA-large", color: "var(--color-warning-500)" };
  return { label: "FAIL", color: "var(--color-danger-500)" };
}

const primary = "var(--color-text-primary)";
const secondary = "var(--color-text-secondary)";
const muted = "var(--color-text-muted)";
const surface = "var(--color-bg-surface)";
const border = "var(--color-border)";

// ──────────────────────────────────────────────
// Story 1 — Accent Scale
// ──────────────────────────────────────────────

export const AccentScale: Story = {
  name: "1. Accent scale (slate-teal)",
  parameters: {
    docs: {
      description: {
        story: "Brand signature — slate-teal, 10 steps 50→900. Semantic roles per step. Dark theme uses 400 interactive, light uses 600.",
      },
    },
  },
  render: () => {
    const roles: Record<number, string> = {
      50: "lightest · unused (reserve)",
      100: "pale · unused (reserve)",
      200: "sage · unused (reserve)",
      300: "dark hover state",
      400: "⭐ DARK interactive",
      500: "brand midpoint",
      600: "⭐ LIGHT interactive",
      700: "light hover state",
      800: "light active state",
      900: "darkest · unused (reserve)",
    };
    return (
      <div style={{ color: primary }}>
        <div className="text-xs mb-4" style={{ color: muted }}>
          Slate-teal — desaturated teal/sage. Professional, maritime, tech. Not indigo, not emerald.
        </div>
        <div className="flex flex-col gap-0" style={{ border: `1px solid ${border}`, borderRadius: 12, overflow: "hidden" }}>
          {Object.entries(accent).map(([step, hex]) => {
            const stepNum = parseInt(step);
            const fgColor = stepNum >= 500 ? "#fff" : "#0d0d0d";
            const whiteContrast = contrast("#ffffff", hex);
            const blackContrast = contrast("#000000", hex);
            return (
              <div
                key={step}
                className="flex items-center gap-4 px-4 py-3"
                style={{ background: hex, color: fgColor }}
              >
                <div style={{ minWidth: 48 }} className="font-mono text-sm font-semibold">{step}</div>
                <div style={{ minWidth: 80 }} className="font-mono text-sm">{hex}</div>
                <div className="flex-1 text-sm">{roles[stepNum]}</div>
                <div className="text-xs font-mono" style={{ opacity: 0.8 }}>
                  W: {whiteContrast.toFixed(2)}:1 · K: {blackContrast.toFixed(2)}:1
                </div>
              </div>
            );
          })}
        </div>
        <div className="text-xs mt-4" style={{ color: muted }}>
          <strong>W</strong> = white text contrast · <strong>K</strong> = black text contrast на данном background.
        </div>
      </div>
    );
  },
};

// ──────────────────────────────────────────────
// Story 2 — Semantic Layers (bg + text matrix)
// ──────────────────────────────────────────────

export const SemanticLayers: Story = {
  name: "2. Semantic layers",
  parameters: {
    docs: {
      description: {
        story: "Elevation system (6 bg layers) × text hierarchy (4 levels). WCAG ratios для каждой комбинации. Current theme determines actual colors.",
      },
    },
  },
  render: () => {
    const bgs = [
      { token: "bg-primary", use: "body shell" },
      { token: "bg-surface", use: "card, modal" },
      { token: "bg-elevated", use: "active tab, PRO badge" },
      { token: "bg-hover", use: "hover state" },
    ];
    const texts = [
      { token: "text-primary", use: "body" },
      { token: "text-secondary", use: "label" },
      { token: "text-muted", use: "caption, disabled" },
    ];
    return (
      <div style={{ color: primary }}>
        <div className="text-xs mb-4" style={{ color: muted }}>
          Живые tokens — отражают current theme. Переключай theme toolbar чтобы увидеть dark vs light parity.
        </div>
        {bgs.map((bg) => (
          <div
            key={bg.token}
            className="rounded-lg p-4 mb-3"
            style={{ background: `var(--color-${bg.token})`, border: `1px solid ${border}` }}
          >
            <div className="text-xs font-mono mb-2" style={{ color: secondary }}>
              {bg.token} · {bg.use}
            </div>
            <div className="flex flex-col gap-1">
              {texts.map((t) => (
                <div key={t.token} style={{ color: `var(--color-${t.token})` }}>
                  <code className="font-mono text-xs mr-2">{t.token}</code>
                  <span className="text-sm">Sample text — {t.use}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  },
};

// ──────────────────────────────────────────────
// Story 3 — Status Colors
// ──────────────────────────────────────────────

export const StatusColors: Story = {
  name: "3. Status colors",
  parameters: {
    docs: {
      description: {
        story:
          "4 категории × 3 tiers. Каждый tier имеет свой scope — где безопасно использовать. Contrast measured только на предназначенном background (cross-theme ratios не показаны — они не применяются в production).",
      },
    },
  },
  render: () => {
    const bgDark = "#0d0d0d";
    const bgLight = "#f9f9f7";

    // Per-tier scope rules — какой bg и какое использование
    const tierScope = {
      400: { bg: bgDark, bgLabel: "Dark bg", scope: "Dark UI — badges, icons, dots" },
      500: { bg: bgLight, bgLabel: "Light bg", scope: "Body text (safe both themes)" }, // show on light для conservative WCAG check
      600: { bg: bgLight, bgLabel: "Light bg", scope: "Light UI ≥18pt — large badges, icons" },
    };

    return (
      <div style={{ color: primary }}>
        {/* ── WCAG legend ── */}
        <div
          className="rounded-lg p-4 mb-6"
          style={{ background: "var(--color-status-info-bg)", border: `1px solid var(--color-status-info-border)` }}
        >
          <div className="text-sm font-semibold mb-2" style={{ color: "var(--color-status-info)" }}>
            📖 WCAG contrast levels — как читать badges ниже
          </div>
          <ul className="text-sm space-y-1" style={{ color: primary }}>
            <li>
              <strong style={{ color: "var(--color-success-500)" }}>✅ AAA (≥7:1)</strong> — premium readability, любой текст
            </li>
            <li>
              <strong style={{ color: "var(--color-success-500)" }}>✅ AA (≥4.5:1)</strong> — WCAG 2.1 <strong>body text standard</strong>. Long content, paragraphs, readable labels.
            </li>
            <li>
              <strong style={{ color: "var(--color-warning-500)" }}>⚠️ AA-large (≥3:1)</strong> — acceptable <strong>только для UI ≥18pt</strong> (large badges, status icons). <strong>НЕ body text.</strong>
            </li>
            <li>
              <strong style={{ color: "var(--color-danger-500)" }}>❌ FAIL (&lt;3:1)</strong> — недостаточный contrast, не использовать visibly.
            </li>
          </ul>
          <div className="text-xs mt-3" style={{ color: muted }}>
            <strong>Rule of thumb:</strong> если сомневаешься — используй <code className="font-mono">-500</code> midpoint. Safe AA на обоих themes.
          </div>
        </div>

        {/* ── Status categories ── */}
        {(Object.entries(status) as [keyof typeof status, Record<number, string>][]).map(([cat, tiers]) => (
          <div key={cat} className="mb-6">
            <div className="text-base font-semibold mb-3 capitalize" style={{ color: primary }}>{cat}</div>
            <div className="grid grid-cols-3 gap-3">
              {[400, 500, 600].map((tier) => {
                const hex = tiers[tier];
                const scope = tierScope[tier as 400 | 500 | 600];
                const ratio = contrast(hex, scope.bg);
                const badge = ratioBadge(ratio);
                // Second ratio — для tier 500 also show dark bg (body text is valid on both themes)
                const secondRatio = tier === 500 ? contrast(hex, bgDark) : null;
                const secondBadge = secondRatio !== null ? ratioBadge(secondRatio) : null;
                return (
                  <div
                    key={tier}
                    className="rounded-lg p-3"
                    style={{ background: surface, border: `1px solid ${border}` }}
                  >
                    {/* Color preview */}
                    <div
                      className="w-full h-14 rounded-md mb-3 flex items-center justify-center font-mono text-sm font-semibold"
                      style={{ background: hex, color: tier >= 500 ? "#fff" : "#0d0d0d" }}
                    >
                      -{tier}
                    </div>
                    {/* Hex */}
                    <code className="font-mono text-xs block" style={{ color: secondary }}>{hex}</code>
                    {/* Scope rule */}
                    <div className="text-xs mt-2 font-medium" style={{ color: primary }}>
                      {scope.scope}
                    </div>
                    {/* Primary ratio */}
                    <div className="text-xs mt-2 font-mono pt-2" style={{ color: muted, borderTop: `1px solid ${border}` }}>
                      on {scope.bgLabel}:{" "}
                      <span style={{ color: badge.color, fontWeight: 600 }}>
                        {ratio.toFixed(2)}:1
                      </span>{" "}
                      <span className="text-[10px]" style={{ color: badge.color }}>{badge.label}</span>
                    </div>
                    {/* Second ratio for 500 (midpoint — both themes) */}
                    {secondRatio !== null && secondBadge && (
                      <div className="text-xs font-mono" style={{ color: muted }}>
                        on Dark bg:{" "}
                        <span style={{ color: secondBadge.color, fontWeight: 600 }}>
                          {secondRatio.toFixed(2)}:1
                        </span>{" "}
                        <span className="text-[10px]" style={{ color: secondBadge.color }}>{secondBadge.label}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        {/* ── Footer — декларативное правило ── */}
        <div
          className="rounded-lg p-4 mt-8"
          style={{ background: "var(--color-bg-elevated)", border: `1px solid ${border}` }}
        >
          <div className="text-sm font-semibold mb-2" style={{ color: primary }}>
            💡 Tier selection — rule
          </div>
          <ul className="text-sm space-y-1" style={{ color: secondary }}>
            <li>
              <strong style={{ color: primary }}>-400</strong> → Dark theme UI: badges, icons, dots, chip labels
            </li>
            <li>
              <strong style={{ color: primary }}>-500</strong> ⭐ → <strong>Body text / readable content</strong> (safe default на обоих themes)
            </li>
            <li>
              <strong style={{ color: primary }}>-600</strong> → Light theme UI ≥18pt: large badges, status icons
            </li>
          </ul>
          <div className="text-xs mt-3" style={{ color: muted }}>
            Semantic tokens <code className="font-mono">--color-status-connected</code> / <code className="font-mono">-error</code> / <code className="font-mono">-connecting</code> / <code className="font-mono">-info</code> автоматически resolve к правильному tier per theme. Использовать их напрямую — не tier вручную.
          </div>
        </div>
      </div>
    );
  },
};

// ──────────────────────────────────────────────
// Story 4 — Tint System
// ──────────────────────────────────────────────

export const TintSystem: Story = {
  name: "4. Tint system",
  parameters: {
    docs: {
      description: {
        story: "Semi-transparent surfaces for status banners, accent fills, subtle highlights. Opacity ladders per color family.",
      },
    },
  },
  render: () => {
    const accentTints = [
      { opacity: "06", usage: "very subtle hover" },
      { opacity: "08", usage: "subtle hover" },
      { opacity: "10", usage: "PRO badge bg, link hover" },
      { opacity: "15", usage: "input focus ring (subtle)" },
      { opacity: "20", usage: "stronger hover" },
      { opacity: "30", usage: "reserved" },
      { opacity: "40", usage: "reserved" },
      { opacity: "50", usage: "reserved" },
    ];
    const statusSurfaces = [
      { bg: "status-connected-bg", border: "status-connected-border", label: "Success banner" },
      { bg: "status-connecting-bg", border: "status-connecting-border", label: "Warning banner" },
      { bg: "status-error-bg", border: "status-error-border", label: "Error banner" },
      { bg: "status-info-bg", border: "status-info-border", label: "Info banner" },
    ];
    return (
      <div style={{ color: primary }}>
        {/* Accent tints */}
        <div className="mb-6">
          <div className="text-sm font-semibold mb-3">Accent tints (slate-teal × opacity)</div>
          <div className="grid grid-cols-4 gap-3">
            {accentTints.map(({ opacity, usage }) => (
              <div key={opacity} className="rounded-lg overflow-hidden" style={{ border: `1px solid ${border}` }}>
                <div
                  className="w-full h-16 flex items-center justify-center text-sm font-mono"
                  style={{ background: `var(--color-accent-tint-${opacity})`, color: primary }}
                >
                  tint-{opacity}
                </div>
                <div className="p-2 text-xs" style={{ background: surface, color: muted }}>
                  {usage}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Status surface tints */}
        <div>
          <div className="text-sm font-semibold mb-3">Status surfaces (bg + border pairs)</div>
          <div className="flex flex-col gap-2">
            {statusSurfaces.map((s) => (
              <div
                key={s.bg}
                className="rounded-lg p-4"
                style={{
                  background: `var(--color-${s.bg})`,
                  border: `1px solid var(--color-${s.border})`,
                }}
              >
                <div className="text-sm font-semibold">{s.label}</div>
                <div className="text-xs font-mono mt-1" style={{ color: muted }}>
                  bg: {s.bg} · border: {s.border}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  },
};

// ──────────────────────────────────────────────
// Story 5 — Contrast Matrix
// ──────────────────────────────────────────────

export const ContrastMatrix: Story = {
  name: "5. Contrast matrix (WCAG)",
  parameters: {
    docs: {
      description: {
        story: "WCAG 2.1 AA compliance transparency. Все text-on-bg combinations с ratios + badges. Known issues flagged.",
      },
    },
  },
  render: () => {
    const dark = {
      "bg-primary": "#0d0d0d",
      "bg-surface": "#1c1c1c",
    };
    const light = {
      "bg-primary": "#f9f9f7",
      "bg-surface": "#f0f0ed",
    };
    const darkTexts = {
      "text-primary": "#f2f2f2",
      "text-secondary": "#9a9a9a",
      "text-muted": "#6e6e6e",
      "success-400": "#34d399",
      "warning-400": "#fbbf24",
      "danger-400": "#f87171",
      "accent-400": "#4d9490",
    };
    const lightTexts = {
      "text-primary": "#161616",
      "text-secondary": "#5a5a5a",
      "text-muted": "#666666",
      "success-600": "#059669",
      "warning-600": "#d97706",
      "danger-600": "#dc2626",
    };
    const Table = ({ theme, bgs, texts }: { theme: string; bgs: Record<string, string>; texts: Record<string, string> }) => (
      <div className="mb-6">
        <div className="text-sm font-semibold mb-2">{theme} theme</div>
        <table className="w-full text-xs" style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ color: muted, borderBottom: `1px solid ${border}` }}>
              <th className="text-left py-2 px-2 font-medium">Text / Color</th>
              {Object.keys(bgs).map((bg) => (
                <th key={bg} className="text-left py-2 px-2 font-medium">on {bg}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(texts).map(([tName, tHex]) => (
              <tr key={tName} style={{ borderBottom: `1px solid ${border}` }}>
                <td className="py-2 px-2 font-mono">{tName}</td>
                {Object.entries(bgs).map(([bgName, bgHex]) => {
                  const r = contrast(tHex, bgHex);
                  const b = ratioBadge(r);
                  return (
                    <td key={bgName} className="py-2 px-2 font-mono">
                      <span style={{ color: b.color }}>{r.toFixed(2)}:1</span>{" "}
                      <span className="text-[10px]" style={{ color: muted }}>{b.label}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
    return (
      <div style={{ color: primary }}>
        <div className="text-xs mb-4" style={{ color: muted }}>
          ✅ AAA (≥7:1) · ✅ AA (≥4.5:1) · ⚠️ AA-large (≥3:1 UI ≥18pt only) · ❌ FAIL (&lt;3:1).
        </div>
        <Table theme="Dark" bgs={dark} texts={darkTexts} />
        <Table theme="Light" bgs={light} texts={lightTexts} />
        <div className="text-xs mt-4 p-3 rounded-lg" style={{ background: "var(--color-status-connecting-bg)", border: `1px solid var(--color-status-connecting-border)`, color: "var(--color-status-connecting)" }}>
          ⚠️ <strong>Known issues:</strong> Dark <code className="font-mono">text-muted</code> (3.81:1 on bg-primary) — UI ≥18pt only.
          Light <code className="font-mono">success-600</code> / <code className="font-mono">warning-600</code> fail AA body text — use <code className="font-mono">-500</code> tier для body. Documented в Colors.mdx §Known limitations.
        </div>
      </div>
    );
  },
};

// ──────────────────────────────────────────────
// Story 6 — Component Palette
// ──────────────────────────────────────────────

export const ComponentPalette: Story = {
  name: "6. Component palette",
  parameters: {
    docs: {
      description: {
        story: "Реальные UI-паттерны с applied colors — Buttons, Inputs, Status, Badges, Cards, Tabs, Wordmark.",
      },
    },
  },
  render: () => (
    <div className="flex flex-col gap-8" style={{ color: primary, maxWidth: 720 }}>
      {/* Buttons */}
      <div>
        <div className="text-sm font-semibold mb-3">Buttons — variant × state</div>
        <div className="flex flex-wrap gap-2">
          <button className="px-4 py-2 rounded-md text-sm font-medium" style={{ background: "var(--color-accent-interactive)", color: "#fff" }}>Primary</button>
          <button className="px-4 py-2 rounded-md text-sm font-medium" style={{ background: "var(--color-bg-elevated)", color: primary, border: `1px solid ${border}` }}>Secondary</button>
          <button className="px-4 py-2 rounded-md text-sm font-medium" style={{ background: "var(--color-destructive)", color: "#fff" }}>Danger</button>
          <button className="px-4 py-2 rounded-md text-sm font-medium" style={{ background: "transparent", color: "var(--color-destructive)", border: `1px solid var(--color-destructive)` }}>Danger Outline</button>
          <button className="px-4 py-2 rounded-md text-sm font-medium" style={{ background: "transparent", color: secondary }}>Ghost</button>
        </div>
      </div>

      {/* Input */}
      <div>
        <div className="text-sm font-semibold mb-3">Input — bg / border / focus / helper</div>
        <div className="flex flex-col gap-2 max-w-sm">
          <label className="text-xs font-medium" style={{ color: secondary }}>Label (text-secondary)</label>
          <input
            type="text"
            placeholder="Placeholder (text-muted)"
            className="rounded-md p-3 text-sm"
            style={{ background: "var(--color-input-bg)", border: `1px solid var(--color-input-border)`, color: primary }}
          />
          <span className="text-xs" style={{ color: muted }}>Helper text (text-muted)</span>
          <span className="text-xs" style={{ color: "var(--color-danger-500)" }}>Error: invalid format (danger-500)</span>
        </div>
      </div>

      {/* Badges / Status */}
      <div>
        <div className="text-sm font-semibold mb-3">Status badges (theme-aware semantic)</div>
        <div className="flex flex-wrap gap-2">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium uppercase" style={{ background: "var(--color-status-connected-bg)", color: "var(--color-status-connected)", border: `1px solid var(--color-status-connected-border)` }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--color-status-connected)" }} />
            Connected
          </span>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium uppercase" style={{ background: "var(--color-status-connecting-bg)", color: "var(--color-status-connecting)", border: `1px solid var(--color-status-connecting-border)` }}>
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: "var(--color-status-connecting)" }} />
            Connecting
          </span>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium uppercase" style={{ background: "var(--color-status-error-bg)", color: "var(--color-status-error)", border: `1px solid var(--color-status-error-border)` }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--color-status-error)" }} />
            Error
          </span>
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium uppercase" style={{ background: "var(--color-bg-elevated)", color: secondary, border: `1px solid ${border}` }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: muted }} />
            Disconnected
          </span>
        </div>
      </div>

      {/* Card */}
      <div>
        <div className="text-sm font-semibold mb-3">Card — surface + hierarchy</div>
        <div className="rounded-lg p-5" style={{ background: surface, border: `1px solid ${border}`, boxShadow: "var(--shadow-sm)" }}>
          <div className="text-xs mb-1" style={{ color: muted }}>Caption (text-muted)</div>
          <h3 className="text-title-sm mb-2" style={{ color: primary }}>Card title (text-primary)</h3>
          <p className="text-body-sm" style={{ color: secondary }}>
            Card body text в text-secondary. Neutral контент, читается без attention.
          </p>
        </div>
      </div>

      {/* Wordmark */}
      <div>
        <div className="text-sm font-semibold mb-3">Wordmark — brand split (Trust neutral + Tunnel accent)</div>
        <div className="text-2xl font-semibold">
          <span style={{ color: primary }}>Trust</span>
          <span style={{ color: "var(--color-accent-interactive)" }}>Tunnel</span>
        </div>
        <div className="text-xs mt-2" style={{ color: muted }}>
          «Trust» = neutral для professional feel · «Tunnel» = accent for brand recognition
        </div>
      </div>
    </div>
  ),
};

// ──────────────────────────────────────────────
// Story 7 — Don'ts
// ──────────────────────────────────────────────

export const DontsShowcase: Story = {
  name: "7. Don'ts — anti-patterns",
  parameters: {
    docs: {
      description: {
        story: "Side-by-side comparisons — bad vs good. Hardcoded hex, Tailwind native, accent misuse, status tier mismatches.",
      },
    },
  },
  render: () => {
    const Pair = ({ title, bad, good, badClass, goodClass }: { title: string; bad: string; good: string; badClass: string; goodClass: string }) => (
      <div className="mb-6">
        <div className="text-xs font-semibold mb-2" style={{ color: primary }}>{title}</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-xs mb-1" style={{ color: "var(--color-danger-500)" }}>❌ Don't</div>
            <div className={`rounded-lg p-3 text-sm ${badClass}`}>{bad}</div>
          </div>
          <div>
            <div className="text-xs mb-1" style={{ color: "var(--color-success-500)" }}>✅ Do</div>
            <div className={`rounded-lg p-3 text-sm ${goodClass}`}>{good}</div>
          </div>
        </div>
      </div>
    );
    return (
      <div style={{ color: primary }}>
        <div className="text-xs mb-6" style={{ color: muted }}>
          Common color anti-patterns — hardcoded hex, Tailwind native, 10%-rule violations.
        </div>

        <Pair
          title="1. Hardcoded hex vs token"
          bad="color: '#ef4444'"
          good="color: var(--color-danger-500)"
          badClass=""
          goodClass=""
        />

        <Pair
          title="2. Tailwind native vs bracket token"
          bad='className="text-red-500 bg-blue-400"'
          good='className="text-[var(--color-danger-500)] bg-[var(--color-accent-interactive)]"'
          badClass=""
          goodClass=""
        />

        <Pair
          title="3. 10% rule — accent как decoration vs interactive"
          bad="Параграф с большим блоком accent текста для «подсвечивания»"
          good="Accent только в interactive: button / link / active tab"
          badClass=""
          goodClass=""
        />

        <Pair
          title="4. Status tier — body text светлого theme"
          bad="text-[var(--color-success-600)] (3.57:1 on light bg — FAIL AA)"
          good="text-[var(--color-success-500)] (higher contrast, safe both themes)"
          badClass=""
          goodClass=""
        />

        <Pair
          title="5. Custom rgba vs tint token"
          bad="background: rgba(16, 185, 129, 0.08)"
          good="background: var(--color-status-connected-bg)"
          badClass=""
          goodClass=""
        />

        <div className="mt-8 p-4 rounded-lg" style={{ background: "var(--color-status-info-bg)", border: `1px solid var(--color-status-info-border)` }}>
          <div className="text-sm font-semibold mb-2" style={{ color: "var(--color-status-info)" }}>
            💡 Canonical reference
          </div>
          <div className="text-sm" style={{ color: primary }}>
            Все rules, decision tree, component mapping — в <strong>Colors.mdx</strong> (Docs tab) и{" "}
            <code className="font-mono text-xs">memory/v3/design-system/colors.md</code>.
          </div>
        </div>
      </div>
    );
  },
};
