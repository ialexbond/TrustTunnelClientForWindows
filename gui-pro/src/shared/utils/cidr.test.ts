import { describe, it, expect } from "vitest";
import {
  isValidCidr,
  parseCidr,
  formatCidr,
  describeCidr,
  isValidIpv4,
  isValidIpv6,
  isValidIpv6Cidr,
  isValidRouteAddress,
} from "./cidr";

describe("isValidCidr", () => {
  it("accepts empty (no restriction)", () => {
    expect(isValidCidr("")).toBe(true);
  });

  it("accepts 0.0.0.0/0 (allow all)", () => {
    expect(isValidCidr("0.0.0.0/0")).toBe(true);
  });

  it("accepts 10.0.0.0/24", () => {
    expect(isValidCidr("10.0.0.0/24")).toBe(true);
  });

  it("accepts 255.255.255.255/32 (boundary)", () => {
    expect(isValidCidr("255.255.255.255/32")).toBe(true);
  });

  it("accepts 192.168.1.0/16", () => {
    expect(isValidCidr("192.168.1.0/16")).toBe(true);
  });

  it("rejects octet 256", () => {
    expect(isValidCidr("10.0.0.256/24")).toBe(false);
  });

  it("rejects prefix 33", () => {
    expect(isValidCidr("10.0.0.0/33")).toBe(false);
  });

  it("rejects shell injection", () => {
    expect(isValidCidr("10.0.0.0/24; rm -rf /")).toBe(false);
  });

  it("rejects missing prefix", () => {
    expect(isValidCidr("10.0.0.0")).toBe(false);
  });

  it("rejects 3 octets", () => {
    expect(isValidCidr("10.0.0/24")).toBe(false);
  });

  it("rejects empty octet", () => {
    expect(isValidCidr("10..0.0/24")).toBe(false);
  });

  it("rejects leading space", () => {
    expect(isValidCidr(" 10.0.0.0/24")).toBe(false);
  });
});

describe("parseCidr", () => {
  it("returns null for empty", () => {
    expect(parseCidr("")).toBeNull();
  });

  it("returns null for invalid", () => {
    expect(parseCidr("not a cidr")).toBeNull();
  });

  it("splits 10.0.0.0/24 correctly", () => {
    expect(parseCidr("10.0.0.0/24")).toEqual({
      octets: ["10", "0", "0", "0"],
      prefix: "24",
    });
  });

  it("splits 255.255.255.255/32", () => {
    expect(parseCidr("255.255.255.255/32")).toEqual({
      octets: ["255", "255", "255", "255"],
      prefix: "32",
    });
  });
});

describe("formatCidr", () => {
  it("returns empty when all empty", () => {
    expect(formatCidr(["", "", "", ""], "")).toBe("");
  });

  it("returns empty when partial", () => {
    expect(formatCidr(["10", "", "0", "0"], "24")).toBe("");
  });

  it("returns empty when prefix missing", () => {
    expect(formatCidr(["10", "0", "0", "0"], "")).toBe("");
  });

  it("formats complete parts", () => {
    expect(formatCidr(["10", "0", "0", "0"], "24")).toBe("10.0.0.0/24");
  });

  it("formats with prefix 0", () => {
    expect(formatCidr(["0", "0", "0", "0"], "0")).toBe("0.0.0.0/0");
  });

  it("formats with prefix 32", () => {
    expect(formatCidr(["192", "168", "1", "1"], "32")).toBe("192.168.1.1/32");
  });

  it("rejects wrong octet length", () => {
    expect(formatCidr(["10", "0", "0"], "24")).toBe("");
  });
});

describe("describeCidr", () => {
  it("returns empty-key for empty", () => {
    expect(describeCidr("")).toBe("server.users.cidr_empty_any");
  });

  it("returns zero-all key for 0.0.0.0/0", () => {
    expect(describeCidr("0.0.0.0/0")).toBe("server.users.cidr_zero_all");
  });

  it("computes range for 10.0.0.0/24", () => {
    const desc = describeCidr("10.0.0.0/24");
    expect(desc).toContain("10.0.0.0");
    expect(desc).toContain("10.0.0.255");
    expect(desc).toContain("256 addresses");
  });

  it("returns empty string for invalid", () => {
    expect(describeCidr("not.valid")).toBe("");
  });
});

// MR3-06 (D-17/D-19): the routing-rule address field must reject impossible IPv4 addresses and
// accept an IPv6 subnet written with a slash. These helpers back AddRuleInput.validateEntry.
describe("isValidIpv4", () => {
  it("accepts 0.0.0.0", () => {
    expect(isValidIpv4("0.0.0.0")).toBe(true);
  });

  it("accepts 255.255.255.255", () => {
    expect(isValidIpv4("255.255.255.255")).toBe(true);
  });

  it("rejects octet 256", () => {
    expect(isValidIpv4("256.1.1.1")).toBe(false);
  });

  it("rejects too few octets", () => {
    expect(isValidIpv4("1.2.3")).toBe(false);
  });

  it("rejects too many octets", () => {
    expect(isValidIpv4("01.2.3.4.5")).toBe(false);
  });
});

describe("isValidIpv6", () => {
  it.each([
    ["::1", true],
    ["2001:db8::", true],
    ["fe80::1", true],
    ["2001:0db8:0000:0000:0000:ff00:0042:8329", true],
    [":::::", false],
    ["2001:db8:::1", false],
    ["1:2:3:4:5:6:7:8:9", false],
    ["gggg::1", false],
    ["12345::1", false],
  ])("isValidIpv6(%s) === %s", (input, expected) => {
    expect(isValidIpv6(input)).toBe(expected);
  });
});

describe("isValidIpv6Cidr", () => {
  it.each([
    ["2001:db8::/32", true],
    ["::/0", true],
    ["2001:db8::/128", true],
    ["2001:db8::/129", false],
    ["2001:db8::/", false],
    ["/32", false],
  ])("isValidIpv6Cidr(%s) === %s", (input, expected) => {
    expect(isValidIpv6Cidr(input)).toBe(expected);
  });
});

describe("isValidRouteAddress (D-19: the five-input contract)", () => {
  it.each([
    ["999.999.999.999", false],
    ["192.168.1.1", true],
    ["10.0.0.0/24", true],
    ["2001:db8::/32", true],
    ["999.999.999.999/99", false],
  ])("isValidRouteAddress(%s) === %s", (input, expected) => {
    expect(isValidRouteAddress(input)).toBe(expected);
  });

  it("still accepts empty via isValidCidr semantics (no restriction)", () => {
    expect(isValidCidr("")).toBe(true);
  });
});
