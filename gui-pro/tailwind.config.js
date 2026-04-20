import plugin from 'tailwindcss/plugin';

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      /*
       * Typography v2 — Phase 14.2 Typography Foundation (2026-04-20)
       * Canonical plan: .planning/typography-refactor.md
       *
       * Tailwind utilities map DIRECTLY to semantic tokens from tokens.css.
       * Legacy --font-size-xs/sm/md/lg/... aliases in tokens.css remain until
       * Phase 3 migration removes inline-style usages.
       *
       * Size remapping (visual change in Phase 2):
       *   text-xs   10px → 12px (caption)  [floor raised for Cyrillic readability]
       *   text-sm   12px → 14px (body-sm)
       *   text-base 14px → 16px (body)     [new body default — industry norm]
       *   text-lg   16px → 18px (body-lg)
       *   text-xl   20px (title-sm) — unchanged
       *   text-2xl  24px (title-lg) — unchanged
       *   text-3xl  32px (display-sm)
       *   text-4xl  40px (display)
       *   text-5xl  48px (display-lg)
       */
      fontFamily: {
        sans:    ["var(--font-family-sans)"],
        mono:    ["var(--font-family-mono)"],
        display: ["var(--font-family-display)"],
      },
      fontSize: {
        xs:    "var(--font-size-caption)",
        sm:    "var(--font-size-body-sm)",
        base:  "var(--font-size-body)",
        lg:    "var(--font-size-body-lg)",
        xl:    "var(--font-size-title-sm)",
        "2xl": "var(--font-size-title-lg)",
        "3xl": "var(--font-size-display-sm)",
        "4xl": "var(--font-size-display)",
        "5xl": "var(--font-size-display-lg)",
      },
      fontWeight: {
        normal:   "var(--font-weight-regular)",
        regular:  "var(--font-weight-regular)",
        medium:   "var(--font-weight-medium)",
        semibold: "var(--font-weight-semibold)",
        bold:     "var(--font-weight-bold)",
      },
      lineHeight: {
        tight:   "var(--line-height-tight)",
        snug:    "var(--line-height-snug)",
        normal:  "var(--line-height-normal)",
        relaxed: "var(--line-height-relaxed)",
      },
      letterSpacing: {
        tight:  "var(--tracking-tight)",
        normal: "var(--tracking-normal)",
        wide:   "var(--tracking-wide)",
      },
    },
  },
  plugins: [
    /*
     * Semantic typography plugin — Phase 14.2.
     *
     * Adds 14 composite classes. Each sets font-family + size + weight + line-height
     * atomically. Prefer these over manual combinations like
     *   <h2 className="text-lg font-semibold leading-snug">
     * use instead:
     *   <h2 className="text-title">
     *
     * Docs (Phase 5): memory/v3/design-system/typography.md
     * Decision tree: "какой класс для какого элемента" — см. там же.
     */
    plugin(function ({ addComponents }) {
      addComponents({
        // ── Caption / meta ────────────────────────────
        '.text-caption': {
          fontFamily: 'var(--font-family-sans)',
          fontSize: 'var(--font-size-caption)',
          fontWeight: 'var(--font-weight-medium)',
          lineHeight: 'var(--line-height-snug)',
        },

        // ── Body ──────────────────────────────────────
        '.text-body-sm': {
          fontFamily: 'var(--font-family-sans)',
          fontSize: 'var(--font-size-body-sm)',
          fontWeight: 'var(--font-weight-regular)',
          lineHeight: 'var(--line-height-normal)',
        },
        '.text-body': {
          fontFamily: 'var(--font-family-sans)',
          fontSize: 'var(--font-size-body)',
          fontWeight: 'var(--font-weight-regular)',
          lineHeight: 'var(--line-height-normal)',
        },
        '.text-body-lg': {
          fontFamily: 'var(--font-family-sans)',
          fontSize: 'var(--font-size-body-lg)',
          fontWeight: 'var(--font-weight-regular)',
          lineHeight: 'var(--line-height-normal)',
        },

        // ── Emphasis ──────────────────────────────────
        '.text-subtitle': {
          fontFamily: 'var(--font-family-sans)',
          fontSize: 'var(--font-size-body-lg)',
          fontWeight: 'var(--font-weight-medium)',
          lineHeight: 'var(--line-height-snug)',
        },
        '.text-button': {
          fontFamily: 'var(--font-family-sans)',
          fontSize: 'var(--font-size-body-sm)',
          fontWeight: 'var(--font-weight-medium)',
          lineHeight: '1',
          letterSpacing: 'var(--tracking-wide)',
        },

        // ── Titles ────────────────────────────────────
        '.text-title-sm': {
          fontFamily: 'var(--font-family-sans)',
          fontSize: 'var(--font-size-title-sm)',
          fontWeight: 'var(--font-weight-semibold)',
          lineHeight: 'var(--line-height-snug)',
        },
        '.text-title': {
          fontFamily: 'var(--font-family-sans)',
          fontSize: 'var(--font-size-title)',
          fontWeight: 'var(--font-weight-semibold)',
          lineHeight: 'var(--line-height-snug)',
        },
        '.text-title-lg': {
          fontFamily: 'var(--font-family-sans)',
          fontSize: 'var(--font-size-title-lg)',
          fontWeight: 'var(--font-weight-semibold)',
          lineHeight: 'var(--line-height-snug)',
        },

        // ── Display ───────────────────────────────────
        '.text-display-sm': {
          fontFamily: 'var(--font-family-sans)',
          fontSize: 'var(--font-size-display-sm)',
          fontWeight: 'var(--font-weight-bold)',
          lineHeight: 'var(--line-height-tight)',
          letterSpacing: 'var(--tracking-tight)',
        },
        '.text-display': {
          fontFamily: 'var(--font-family-sans)',
          fontSize: 'var(--font-size-display)',
          fontWeight: 'var(--font-weight-bold)',
          lineHeight: 'var(--line-height-tight)',
          letterSpacing: 'var(--tracking-tight)',
        },
        '.text-wordmark': {
          fontFamily: 'var(--font-family-display)',
          fontSize: 'var(--font-size-display-lg)',
          fontWeight: 'var(--font-weight-bold)',
          lineHeight: 'var(--line-height-tight)',
          letterSpacing: 'var(--tracking-tight)',
        },

        // ── Mono (tabular data: logs, fingerprint, IP:port, numbers) ─
        '.text-mono': {
          fontFamily: 'var(--font-family-mono)',
          fontSize: 'var(--font-size-body-sm)',
          fontWeight: 'var(--font-weight-regular)',
          lineHeight: 'var(--line-height-normal)',
        },
        '.text-mono-sm': {
          fontFamily: 'var(--font-family-mono)',
          fontSize: 'var(--font-size-caption)',
          fontWeight: 'var(--font-weight-regular)',
          lineHeight: 'var(--line-height-normal)',
        },
      });
    }),
  ],
};
