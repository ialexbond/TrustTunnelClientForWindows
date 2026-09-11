import { describe, it, expect } from "vitest";
import {
  validateListenAddress,
  validateLogLevel,
  validateUrlPath,
  validateAuthStatusCode,
  validateFqdnSni,
} from "./validators";

describe("validateListenAddress", () => {
  it("accepts IPv4 addresses with port", () => {
    expect(validateListenAddress("0.0.0.0:443")).toBe("");
    expect(validateListenAddress("192.168.1.1:8080")).toBe("");
    expect(validateListenAddress("127.0.0.1:1")).toBe("");
  });

  it("accepts IPv6 addresses with port", () => {
    expect(validateListenAddress("[::]:443")).toBe("");
    expect(validateListenAddress("[::1]:8443")).toBe("");
  });

  it("rejects shell injection", () => {
    expect(validateListenAddress("0.0.0.0:443; rm -rf /")).not.toBe("");
    expect(validateListenAddress("$(whoami):443")).not.toBe("");
    expect(validateListenAddress("0.0.0.0:443'")).not.toBe("");
    expect(validateListenAddress("0.0.0.0:443`id`")).not.toBe("");
  });

  it("rejects empty", () => {
    expect(validateListenAddress("")).not.toBe("");
  });

  it("rejects too long (>64 chars)", () => {
    expect(validateListenAddress("a".repeat(65))).not.toBe("");
  });

  it("rejects missing port", () => {
    expect(validateListenAddress("0.0.0.0")).not.toBe("");
  });

  it("rejects port out of range", () => {
    expect(validateListenAddress("0.0.0.0:0")).not.toBe("");
    expect(validateListenAddress("0.0.0.0:99999")).not.toBe("");
  });
});

describe("validateLogLevel", () => {
  it("accepts whitelist values", () => {
    expect(validateLogLevel("trace")).toBe("");
    expect(validateLogLevel("debug")).toBe("");
    expect(validateLogLevel("info")).toBe("");
    expect(validateLogLevel("warn")).toBe("");
    expect(validateLogLevel("error")).toBe("");
    expect(validateLogLevel("")).toBe(""); // empty = use default
  });

  it("rejects unknown values", () => {
    expect(validateLogLevel("verbose")).not.toBe("");
    expect(validateLogLevel("INFO")).not.toBe(""); // case-sensitive
    expect(validateLogLevel("$(whoami)")).not.toBe("");
  });
});

describe("validateUrlPath", () => {
  it("accepts valid paths", () => {
    expect(validateUrlPath("/ping")).toBe("");
    expect(validateUrlPath("/speedtest")).toBe("");
    expect(validateUrlPath("/api/health.json")).toBe("");
    expect(validateUrlPath("/v1/_internal-test")).toBe("");
  });

  it("rejects empty", () => {
    expect(validateUrlPath("")).not.toBe("");
  });

  it("rejects no leading slash", () => {
    expect(validateUrlPath("ping")).not.toBe("");
  });

  it("rejects shell injection", () => {
    expect(validateUrlPath("/ping; rm -rf /")).not.toBe("");
    expect(validateUrlPath("/$(whoami)")).not.toBe("");
    expect(validateUrlPath("/path with spaces")).not.toBe("");
  });

  it("rejects too long (>255 chars)", () => {
    expect(validateUrlPath("/" + "a".repeat(255))).not.toBe("");
  });
});

describe("validateAuthStatusCode", () => {
  it("accepts 405 and 407", () => {
    expect(validateAuthStatusCode(405)).toBe("");
    expect(validateAuthStatusCode(407)).toBe("");
  });

  it("rejects all other codes", () => {
    expect(validateAuthStatusCode(200)).not.toBe("");
    expect(validateAuthStatusCode(401)).not.toBe("");
    expect(validateAuthStatusCode(403)).not.toBe("");
    expect(validateAuthStatusCode(500)).not.toBe("");
    expect(validateAuthStatusCode(0)).not.toBe("");
  });
});

describe("validateFqdnSni", () => {
  it("accepts valid FQDN", () => {
    expect(validateFqdnSni("cdn.example.com")).toBe("");
    expect(validateFqdnSni("a.b.c.example.org")).toBe("");
    expect(validateFqdnSni("sub-domain.example.com")).toBe("");
    expect(validateFqdnSni("")).toBe(""); // empty = optional
  });

  it("rejects shell injection / non-ASCII / spaces", () => {
    expect(validateFqdnSni("$(whoami)")).not.toBe("");
    expect(validateFqdnSni("with spaces")).not.toBe("");
    expect(validateFqdnSni("кириллица.com")).not.toBe("");
  });

  it("rejects malformed FQDN", () => {
    expect(validateFqdnSni(".starts-with-dot.com")).not.toBe("");
    expect(validateFqdnSni("ends-with-dot.com.")).not.toBe("");
    expect(validateFqdnSni("double..dot.com")).not.toBe("");
    expect(validateFqdnSni("-dash-start.com")).not.toBe("");
    expect(validateFqdnSni("dash-end-.com")).not.toBe("");
  });

  it("rejects too long", () => {
    expect(validateFqdnSni("a".repeat(254))).not.toBe("");
  });
});
