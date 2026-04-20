import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * Custom tailwind-merge instance — aware of Phase 14.2 typography semantics.
 *
 * Why we extend:
 *   1. Semantic composite classes (.text-caption/body/title/display/mono — added via
 *      Tailwind plugin) set font-size + weight + line-height + family atomically.
 *      Without extending "font-size" group, merge won't resolve conflict between
 *      e.g. `text-caption text-title` — it would keep both.
 *   2. Legacy pattern `text-[var(--font-size-*)]` (anti-pattern — to be removed in
 *      Phase 3 migration) is kept in the group so existing code doesn't break.
 *
 * Canonical plan: .planning/typography-refactor.md
 * Phase 14.2 CONTEXT: .planning/phases/14.2-typography-foundation/14.2-CONTEXT.md
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        // Semantic composites (Phase 14.2 — via Tailwind plugin)
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
        // Legacy arbitrary var(--font-size-*) pattern — Phase 3 will remove usages
        { text: [(v: string) => /^\[var\(--font-size-/.test(v)] },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
