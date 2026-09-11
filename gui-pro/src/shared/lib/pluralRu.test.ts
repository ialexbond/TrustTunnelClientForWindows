import { describe, it, expect } from "vitest";
import { pluralRu } from "./pluralRu";

// Pins the Russian one/few/many declension after the PA-6 relocation out of
// components/server/certUtils.ts. No test travelled with the function (certUtils.test
// never covered it), so this locks the contract at its new shared/lib home.
describe("pluralRu — Russian one/few/many declension", () => {
  const forms = ["день", "дня", "дней"] as const;
  const decline = (n: number) => pluralRu(n, ...forms);

  it("uses the ONE form for last digit 1 (except teens)", () => {
    expect(decline(1)).toBe("1 день");
    expect(decline(21)).toBe("21 день");
    expect(decline(101)).toBe("101 день");
  });

  it("uses the FEW form for last digit 2-4 (except teens)", () => {
    expect(decline(2)).toBe("2 дня");
    expect(decline(3)).toBe("3 дня");
    expect(decline(4)).toBe("4 дня");
    expect(decline(22)).toBe("22 дня");
  });

  it("uses the MANY form for 0, 5-9 and the teens 11-19", () => {
    expect(decline(0)).toBe("0 дней");
    expect(decline(5)).toBe("5 дней");
    expect(decline(9)).toBe("9 дней");
    expect(decline(11)).toBe("11 дней"); // teen — MANY even though last digit is 1
    expect(decline(12)).toBe("12 дней"); // teen — MANY even though last digit is 2
    expect(decline(19)).toBe("19 дней");
  });

  it("declines by the last two digits, so 111-114 stay MANY (teens) and 121-124 go FEW", () => {
    expect(decline(111)).toBe("111 дней");
    expect(decline(112)).toBe("112 дней");
    expect(decline(124)).toBe("124 дня");
  });
});
