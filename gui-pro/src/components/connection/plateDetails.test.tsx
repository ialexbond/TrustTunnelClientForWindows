// Phase 13 / Plan 13-08 — unit tests for the shared CONNECT-plate detail-row builder.
//
// `plateDetails` is the SINGLE source of truth both the Storybook story and the production plate
// (`notification.tsx`) build the address/login/ping rows from. These lock its three pure pieces:
//   - isIpAddress: a bare IP (v4/v6) → true (server glyph); a domain → false (globe).
//   - pingColor: the green/amber/red quality thresholds.
//   - buildConnectDetails: the 3 rows (address icon by domain-vs-IP, login, ping) + the null-ping «—».
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { isIpAddress, pingColor, buildConnectDetails } from "./plateDetails";

describe("plateDetails — isIpAddress (domain vs IP)", () => {
  it("treats a bare IPv4 (with or without a port) as an IP", () => {
    expect(isIpAddress("203.0.113.42")).toBe(true);
    expect(isIpAddress("203.0.113.42:443")).toBe(true);
  });

  it("treats an IPv6 literal (bracketed or bare) as an IP", () => {
    expect(isIpAddress("[2001:db8::1]:443")).toBe(true);
    expect(isIpAddress("2001:db8::1")).toBe(true);
  });

  it("treats a domain name (with or without a port) as NOT an IP", () => {
    expect(isIpAddress("de-fra.trusttunnel.net")).toBe(false);
    expect(isIpAddress("de-fra.trusttunnel.net:443")).toBe(false);
  });
});

describe("plateDetails — pingColor (quality thresholds)", () => {
  it("maps < 100 ms to the connected (green) token", () => {
    expect(pingColor(0)).toBe("var(--color-status-connected)");
    expect(pingColor(99)).toBe("var(--color-status-connected)");
  });

  it("maps 100–199 ms to the warning (amber) token", () => {
    expect(pingColor(100)).toBe("var(--color-status-warning)");
    expect(pingColor(199)).toBe("var(--color-status-warning)");
  });

  it("maps >= 200 ms to the error (red) token", () => {
    expect(pingColor(200)).toBe("var(--color-status-error)");
    expect(pingColor(999)).toBe("var(--color-status-error)");
  });
});

describe("plateDetails — buildConnectDetails (the 3 rows)", () => {
  it("builds address + login + ping rows in order, ping coloured by quality", () => {
    const rows = buildConnectDetails("de-fra.trusttunnel.net:443", "ivan_petrov", 42, "ru");
    expect(rows).toHaveLength(3);
    // Address row — mono, the address value.
    expect(rows[0].value).toBe("de-fra.trusttunnel.net:443");
    expect(rows[0].mono).toBe(true);
    // Login row — the username, not mono.
    expect(rows[1].value).toBe("ivan_petrov");
    // Ping row — «{ms} мс», mono, coloured green for a fast ping.
    expect(rows[2].value).toBe("42 мс");
    expect(rows[2].mono).toBe(true);
    expect(rows[2].valueColor).toBe("var(--color-status-connected)");
  });

  it("renders the ping unit per language: ru «мс», en \"ms\" (review #4)", () => {
    // The unit used to be a hardcoded Cyrillic «мс», so an English plate showed "142 мс" amid
    // otherwise-English text. Russian keeps the owner-approved «42 мс»; English mirrors it as "ms".
    expect(buildConnectDetails("de-fra.trusttunnel.net:443", "ivan_petrov", 42, "ru")[2].value).toBe(
      "42 мс",
    );
    expect(buildConnectDetails("de-fra.trusttunnel.net:443", "ivan_petrov", 142, "en")[2].value).toBe(
      "142 ms",
    );
    // Address/login rows are language-independent — only the ping unit localizes.
    const en = buildConnectDetails("de-fra.trusttunnel.net:443", "ivan_petrov", 142, "en");
    expect(en[0].value).toBe("de-fra.trusttunnel.net:443");
    expect(en[1].value).toBe("ivan_petrov");
  });

  it("renders «—» in muted (no quality colour) when the ping is null — in either language", () => {
    const rows = buildConnectDetails("203.0.113.42:443", "ivan_petrov", null, "ru");
    expect(rows[2].value).toBe("—");
    // A missing measurement is muted, never a quality colour (never a misleading green/red).
    expect(rows[2].valueColor).toBe("var(--color-text-muted)");
    // The «—» no-data marker is language-neutral (no unit, no translation).
    expect(buildConnectDetails("203.0.113.42:443", "ivan_petrov", null, "en")[2].value).toBe("—");
  });

  it("uses the server glyph for a bare IP and the globe for a domain (icon differs)", () => {
    // The address icon is a React element — render each row's icon and compare the produced SVG so
    // the domain-vs-IP branch is actually exercised (not just asserted structurally).
    const ip = buildConnectDetails("203.0.113.42:443", "u", 10, "ru")[0];
    const domain = buildConnectDetails("de-fra.trusttunnel.net:443", "u", 10, "ru")[0];
    const { container: ipC } = render(<span>{ip.icon}</span>);
    const { container: domainC } = render(<span>{domain.icon}</span>);
    // Both are lucide SVGs but DIFFERENT icons — their markup must not be identical.
    expect(ipC.querySelector("svg")).not.toBeNull();
    expect(domainC.querySelector("svg")).not.toBeNull();
    expect(ipC.innerHTML).not.toBe(domainC.innerHTML);
  });
});
