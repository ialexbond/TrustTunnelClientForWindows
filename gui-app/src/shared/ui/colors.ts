/**
 * Semantic color constants for inline styles.
 * Replaces repeated rgba(...) values across the codebase.
 */
export const colors = {
  // Success (green)
  successBg: "rgba(16, 185, 129, 0.1)",
  successBgSubtle: "rgba(16, 185, 129, 0.06)",
  successBorder: "rgba(16, 185, 129, 0.15)",
  successGlow: "0 0 12px rgba(16, 185, 129, 0.6)",

  // Warning (amber)
  warningBg: "rgba(245, 158, 11, 0.1)",
  warningBorder: "rgba(245, 158, 11, 0.15)",

  // Danger (red)
  dangerBg: "rgba(239, 68, 68, 0.08)",
  dangerBorder: "rgba(239, 68, 68, 0.15)",
  dangerGlow: "0 0 12px rgba(239, 68, 68, 0.4)",

  // Accent (indigo)
  accentBg: "rgba(99, 102, 241, 0.1)",
  accentBgSubtle: "rgba(99, 102, 241, 0.08)",
  accentBorder: "rgba(99, 102, 241, 0.2)",
  accentLogoGlow: "rgba(99, 102, 241, 0.15)",

  // Dropdown
  dropdownShadow: "0 8px 24px rgba(0,0,0,0.24)",
} as const;
