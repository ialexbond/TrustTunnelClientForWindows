/**
 * Merges class names, filtering out falsy values.
 * Minimal implementation that works without external dependencies.
 * When CVA infrastructure is installed (clsx + tailwind-merge), this can be upgraded.
 */
export type ClassValue = string | undefined | null | false | ClassValue[];

export function cn(...inputs: ClassValue[]): string {
  const result: string[] = [];

  for (const input of inputs) {
    if (!input) continue;
    if (typeof input === "string") {
      const trimmed = input.trim();
      if (trimmed) result.push(trimmed);
    } else if (Array.isArray(input)) {
      const merged = cn(...input);
      if (merged) result.push(merged);
    }
  }

  return result.join(" ");
}
