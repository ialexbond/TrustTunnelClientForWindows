import { describe, it, expect } from "vitest";
import {
  fromServerResponse,
  toServerPayload,
  type UserAdvancedParams,
} from "./userAdvanced";

const fullUiParams: UserAdvancedParams = {
  displayName: "Home",
  customSni: "cdn.example.com",
  upstreamProtocol: "h2",
  skipVerification: true,
  pinCert: true,
  certDerB64: "AAAA",
  certFingerprint: "deadbeef",
  dnsUpstreams: ["8.8.8.8", "1.1.1.1"],
  antiDpi: true,
};

const fullServerResponse = {
  username: "alice",
  display_name: "Home",
  custom_sni: "cdn.example.com",
  upstream_protocol: "h2",
  skip_verification: true,
  pin_cert_der_b64: "AAAA",
  dns_upstreams: ["8.8.8.8", "1.1.1.1"],
  anti_dpi: true,
};

describe("userAdvanced/fromServerResponse", () => {
  it("returns null for null / undefined (no persisted entry)", () => {
    expect(fromServerResponse(null)).toBeNull();
    expect(fromServerResponse(undefined)).toBeNull();
  });

  it("maps a full server response into UI shape", () => {
    const ui = fromServerResponse(fullServerResponse);
    expect(ui).not.toBeNull();
    expect(ui).toMatchObject({
      displayName: "Home",
      customSni: "cdn.example.com",
      upstreamProtocol: "h2",
      skipVerification: true,
      pinCert: true,
      certDerB64: "AAAA",
      dnsUpstreams: ["8.8.8.8", "1.1.1.1"],
      antiDpi: true,
    });
    // Fingerprint isn't persisted — UI recomputes on demand.
    expect(ui?.certFingerprint).toBeNull();
  });

  it("normalizes null optional strings to empty string", () => {
    const minimal = {
      ...fullServerResponse,
      display_name: null,
      custom_sni: null,
      upstream_protocol: null,
      pin_cert_der_b64: null,
    };
    const ui = fromServerResponse(minimal);
    expect(ui?.displayName).toBe("");
    expect(ui?.customSni).toBe("");
    expect(ui?.upstreamProtocol).toBe("auto");
    expect(ui?.pinCert).toBe(false);
    expect(ui?.certDerB64).toBeNull();
  });

  it("clamps unknown upstream_protocol to 'auto'", () => {
    const mutant = { ...fullServerResponse, upstream_protocol: "gopher" };
    const ui = fromServerResponse(mutant);
    expect(ui?.upstreamProtocol).toBe("auto");
  });

  it("accepts h3 upstream_protocol", () => {
    const mutant = { ...fullServerResponse, upstream_protocol: "h3" };
    const ui = fromServerResponse(mutant);
    expect(ui?.upstreamProtocol).toBe("h3");
  });

  it("returns null on malformed payloads", () => {
    expect(fromServerResponse("not an object")).toBeNull();
    expect(fromServerResponse({ username: 123 })).toBeNull();
    expect(fromServerResponse({ ...fullServerResponse, dns_upstreams: [42] })).toBeNull();
    expect(
      fromServerResponse({ ...fullServerResponse, skip_verification: "yes" }),
    ).toBeNull();
  });
});

describe("userAdvanced/toServerPayload", () => {
  it("roundtrips full UI shape → server shape", () => {
    const payload = toServerPayload(fullUiParams, "alice");
    expect(payload).toEqual(fullServerResponse);
  });

  it("maps empty strings to null", () => {
    const empty: UserAdvancedParams = {
      displayName: "",
      customSni: "",
      upstreamProtocol: "auto",
      skipVerification: false,
      pinCert: false,
      certDerB64: null,
      certFingerprint: null,
      dnsUpstreams: [],
      antiDpi: false,
    };
    const payload = toServerPayload(empty, "bob");
    expect(payload).toEqual({
      username: "bob",
      display_name: null,
      custom_sni: null,
      upstream_protocol: null,
      skip_verification: false,
      pin_cert_der_b64: null,
      dns_upstreams: [],
      anti_dpi: false,
    });
  });

  it("drops certDerB64 when pinCert toggled off", () => {
    const unpinned: UserAdvancedParams = {
      ...fullUiParams,
      pinCert: false,
      certDerB64: "AAAA",
    };
    expect(toServerPayload(unpinned, "alice").pin_cert_der_b64).toBeNull();
  });

  it("roundtrips through fromServerResponse → toServerPayload", () => {
    const server = toServerPayload(fullUiParams, "alice");
    const ui = fromServerResponse(server);
    expect(ui).not.toBeNull();
    const back = toServerPayload(ui!, "alice");
    // Note: certFingerprint doesn't roundtrip — backend doesn't persist it.
    expect(back).toEqual(server);
  });
});
