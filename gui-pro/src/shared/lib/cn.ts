import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Custom tailwind-merge instance — aware of Phase 14.2 typography semantics.
 *
 * Semantic composite classes (.text-caption/body/title/display/mono — added via
 * Tailwind plugin in tailwind.config.js) set font-size + weight + line-height +
 * family atomically. Without extending "font-size" group, merge wouldn't resolve
 * conflicts like `text-caption text-title` — it would keep both.
 *
 * The `text-[var(...)]` arbitrary-value pattern guard is kept as a safety net —
 * it's an anti-pattern (Tailwind generates `color:` instead of `font-size:`) and
 * Plan 14.2-03 removed all usages, but leaving the class-group entry means any
 * future regression is still correctly resolved by tailwind-merge.
 *
 * Canonical docs: memory/v3/design-system/typography.md
 * Anti-patterns: src/docs/Typography.mdx §Don'ts
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        // Semantic composites (Phase 14.2 plugin)
        "text-caption",
        "text-body-sm",
        "text-body",
        "text-body-lg",
        "text-subtitle",
        "text-button",
        "text-title-sm",
        "text-title",
        "text-title-lg",
        "text-display-sm",
        "text-display",
        "text-wordmark",
        "text-mono",
        "text-mono-sm",
        // Safety net for `text-[var(--font-size-*)]` anti-pattern (not used in code)
        { text: [(v: string) => /^\[var\(--font-size-/.test(v)] },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
