/**
 * Semantic color constants for inline styles.
 * Replaces repeated rgba(...) values across the codebase.
 */
export const colors = {
  // Success (green)
  successBg: "rgba(16, 185, 129, 0.1)",
  successBgSubtle: "rgba(16, 185, 129, 0.06)",
  successBorder: "rgba(16, 185, 129, 0.15)",
  /** @deprecated v3.0: glow removed per restrained elegance direction. Use shadow tokens. Removed in Phase 6. */
  successGlow: "none",

  // Warning (amber)
  warningBg: "rgba(245, 158, 11, 0.1)",
  warningBorder: "rgba(245, 158, 11, 0.15)",

  // Danger (red)
  dangerBg: "rgba(239, 68, 68, 0.08)",
  dangerBorder: "rgba(239, 68, 68, 0.15)",
  /** @deprecated v3.0: glow removed per restrained elegance direction. Use shadow tokens. Removed in Phase 6. */
  dangerGlow: "none",

  // Accent (indigo)
  accentBg: "rgba(99, 102, 241, 0.1)",
  accentBgSubtle: "rgba(99, 102, 241, 0.08)",
  accentBorder: "rgba(99, 102, 241, 0.2)",
  /** @deprecated v3.0: glow removed per restrained elegance direction. Use shadow tokens. Removed in Phase 6. */
  accentLogoGlow: "none",

  // Dropdown
  dropdownShadow: "0 8px 24px rgba(0,0,0,0.24)",
} as const;
