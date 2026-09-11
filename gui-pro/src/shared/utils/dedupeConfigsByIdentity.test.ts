import { describe, it, expect } from "vitest";
import { dedupeConfigsByIdentity } from "./dedupeConfigsByIdentity";
import type { ConfigSummary } from "../hooks/useConfigList";

function cfg(over: Partial<ConfigSummary>): ConfigSummary {
  return {
    id: "id",
    name: "name",
    host: "de1.example.com",
    display_host: "de1.example.com",
    user: "swift-fox",
    path: "C:/app/x.toml",
    order: 0,
    last_used: false,
    ...over,
  };
}

describe("dedupeConfigsByIdentity", () => {
  it("keeps distinct servers untouched", () => {
    const a = cfg({ id: "a", host: "de1.example.com", user: "swift-fox", path: "C:/app/a.toml", order: 0 });
    const b = cfg({ id: "b", host: "nl1.example.com", user: "calm-owl", path: "C:/app/b.toml", order: 1 });
    expect(dedupeConfigsByIdentity([a, b])).toEqual([a, b]);
  });

  it("collapses two files of the same server (host+user) into one card", () => {
    // The exact gap-A scenario: legacy trusttunnel_client.toml + wizard TrustTunnel_<user>.toml.
    const legacy = cfg({ id: "legacy", path: "C:/app/trusttunnel_client.toml", order: 1, last_used: false });
    const wizard = cfg({ id: "wizard", path: "C:/app/TrustTunnel_swift-fox.toml", order: 0, last_used: true });
    const out = dedupeConfigsByIdentity([wizard, legacy]);
    expect(out).toHaveLength(1);
  });

  it("dedups case-insensitively on host and user", () => {
    const a = cfg({ id: "a", host: "DE1.Example.com", user: "Swift-Fox", path: "C:/app/a.toml" });
    const b = cfg({ id: "b", host: "de1.example.com", user: "swift-fox", path: "C:/app/b.toml" });
    expect(dedupeConfigsByIdentity([a, b])).toHaveLength(1);
  });

  it("keeps the entry matching activeConfigPath so live status lands on the connected file", () => {
    const legacy = cfg({ id: "legacy", path: "C:/app/trusttunnel_client.toml", order: 0, last_used: true });
    const wizard = cfg({ id: "wizard", path: "C:/app/TrustTunnel_swift-fox.toml", order: 1, last_used: false });
    // The tunnel actually runs through the wizard file (different separator style on purpose).
    const out = dedupeConfigsByIdentity([legacy, wizard], "C:\\app\\TrustTunnel_swift-fox.toml");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("wizard");
  });

  it("prefers last_used when activeConfigPath does not match either", () => {
    const a = cfg({ id: "a", path: "C:/app/a.toml", order: 1, last_used: true });
    const b = cfg({ id: "b", path: "C:/app/b.toml", order: 0, last_used: false });
    const out = dedupeConfigsByIdentity([b, a]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("a");
  });

  it("falls back to the lowest order when neither active nor last_used", () => {
    const a = cfg({ id: "a", path: "C:/app/a.toml", order: 2, last_used: false });
    const b = cfg({ id: "b", path: "C:/app/b.toml", order: 1, last_used: false });
    const out = dedupeConfigsByIdentity([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("b");
  });

  it("never merges entries with no host (can't be identity-keyed)", () => {
    const a = cfg({ id: "a", host: "", user: "", path: "C:/app/a.toml" });
    const b = cfg({ id: "b", host: "", user: "", path: "C:/app/b.toml" });
    expect(dedupeConfigsByIdentity([a, b])).toHaveLength(2);
  });

  it("collapses three twins down to a single survivor", () => {
    const t1 = cfg({ id: "t1", path: "C:/app/1.toml", order: 0, last_used: false });
    const t2 = cfg({ id: "t2", path: "C:/app/2.toml", order: 1, last_used: true });
    const t3 = cfg({ id: "t3", path: "C:/app/3.toml", order: 2, last_used: false });
    const out = dedupeConfigsByIdentity([t1, t2, t3]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("t2");
  });

  // IN-19 (gap G): a deliberately-added IMPORT copy (`<stem>-2.toml`) of an existing config is
  // the same host+user, but it MUST keep its own card — the old collapse swallowed it.
  it("keeps an import «Добавить копию» twin (<stem>-2.toml) as its own card", () => {
    const original = cfg({ id: "orig", path: "C:/app/TrustTunnel_swift-fox.toml", order: 0, last_used: true });
    const copy = cfg({ id: "copy", path: "C:/app/TrustTunnel_swift-fox-2.toml", order: 1, last_used: false });
    const out = dedupeConfigsByIdentity([original, copy]);
    expect(out.map((c) => c.id)).toEqual(["orig", "copy"]);
  });

  // IN-19 (gap G): the «Дублировать» card copy (`<stem>-copy.toml`, name «… (копия)») also stays.
  it("keeps a «Дублировать» copy (<stem>-copy.toml / «(копия)») as its own card", () => {
    const original = cfg({ id: "orig", name: "Германия", path: "C:/app/TrustTunnel_swift-fox.toml", order: 0 });
    const copy = cfg({ id: "copy", name: "Германия (копия)", path: "C:/app/TrustTunnel_swift-fox-copy.toml", order: 1 });
    expect(dedupeConfigsByIdentity([original, copy])).toHaveLength(2);
  });

  // IN-19 (gap G): the real owner scenario — a migrated machine (legacy + branded twin) on which
  // the user then adds a copy must show TWO cards: the collapsed server + the copy (NOT one).
  it("on a migrated machine, collapses the twin but still shows an added copy", () => {
    const legacy = cfg({ id: "legacy", path: "C:/app/trusttunnel_client.toml", order: 2, last_used: false });
    const branded = cfg({ id: "branded", path: "C:/app/TrustTunnel_swift-fox.toml", order: 0, last_used: true });
    const copy = cfg({ id: "copy", path: "C:/app/TrustTunnel_swift-fox-2.toml", order: 1, last_used: false });
    const out = dedupeConfigsByIdentity([branded, copy, legacy], "C:/app/TrustTunnel_swift-fox.toml");
    // The legacy+branded twin collapses to the active branded; the copy stays as its own card.
    expect(out.map((c) => c.id)).toEqual(["branded", "copy"]);
  });

  // B6 fix #5: a NUMBERED copy label «<base> (копия 2)» must be recognised as a copy (kept as its
  // own card), same as «(копия)». The old `.includes("(копия)")` missed the numbered form — which
  // both hid the copy here AND let the Rust delete identity-sweep permanently delete it. The FE and
  // Rust `is_deliberate_copy` rules must agree on «(копия N)».
  it("keeps a numbered «(копия 2)» copy as its own card (fix #5)", () => {
    const original = cfg({ id: "orig", name: "Россия", path: "C:/app/TrustTunnel_swift-fox.toml", order: 0, last_used: true });
    // Numbered copy label, and a filename with no copy suffix so ONLY the name rule can flag it.
    const copy2 = cfg({ id: "copy2", name: "Россия (копия 2)", path: "C:/app/TrustTunnel_swift-fox-backup.toml", order: 1 });
    const out = dedupeConfigsByIdentity([original, copy2]);
    expect(out.map((c) => c.id)).toEqual(["orig", "copy2"]);
  });
});
