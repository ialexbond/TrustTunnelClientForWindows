import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ru from "./locales/ru.json";

function flattenKeys(obj: Record<string, unknown>, prefix = ""): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      flattenKeys(value as Record<string, unknown>, fullKey).forEach((k) => keys.add(k));
    } else {
      keys.add(fullKey);
    }
  }
  return keys;
}

describe("i18n key parity", () => {
  it("all English keys exist in Russian", () => {
    const enKeys = flattenKeys(en);
    const ruKeys = flattenKeys(ru);
    const missing = [...enKeys].filter((k) => !ruKeys.has(k));
    expect(missing).toEqual([]);
  });

  it("all Russian keys exist in English", () => {
    const enKeys = flattenKeys(en);
    const ruKeys = flattenKeys(ru);
    const extra = [...ruKeys].filter((k) => !enKeys.has(k));
    expect(extra).toEqual([]);
  });
});
