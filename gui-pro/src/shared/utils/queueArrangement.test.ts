import { describe, expect, it } from "vitest";

import { applyQueueArrangement } from "./queueArrangement";
import type { ConfigSummary } from "../hooks/useConfigList";

function cfg(id: string, name = id, order = 0): ConfigSummary {
  return {
    id,
    name,
    host: `${id}.example`,
    display_host: `${id}.example`,
    user: "u",
    path: `C:/cfg/${id}.toml`,
    order,
    last_used: false,
  };
}

/**
 * The rule «Порядок переключения» follows: the ORDER is the user's, everything a row SAYS is the
 * manifest's. Each case here is one the owner hit, or one the previous rule was protecting.
 */
describe("applyQueueArrangement", () => {
  it("shows the manifest order when the user has never rearranged anything", () => {
    const fresh = [cfg("a"), cfg("b")];
    expect(applyQueueArrangement([], fresh)).toBe(fresh);
  });

  it("takes a renamed config's new title without disturbing its place", () => {
    // The bug. A rename does not move an id, which is exactly why the old id-set rule never
    // noticed it — and why the arrangement holds ids while the rows come from the manifest.
    const next = applyQueueArrangement(["b", "a"], [cfg("a", "New name"), cfg("b")]);

    expect(next.map((c) => c.id)).toEqual(["b", "a"]);
    expect(next.map((c) => c.name)).toEqual(["b", "New name"]);
  });

  it("keeps the user's arrangement when the manifest returns the same rows in another order", () => {
    // What the old rule existed to protect, and it must survive the fix: `list_configs` hoists the
    // last-used config to the top, and adopting that would snap it to slot 1 mid-drag.
    const next = applyQueueArrangement(["c", "a", "b"], [cfg("a"), cfg("b"), cfg("c")]);
    expect(next.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("drops an id whose config no longer exists", () => {
    const next = applyQueueArrangement(["a", "gone", "b"], [cfg("a"), cfg("b")]);
    expect(next.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("appends a config the arrangement has never seen", () => {
    // A newly imported or duplicated server: highest manifest order, so the end is where it belongs.
    const next = applyQueueArrangement(["b", "a"], [cfg("a"), cfg("b"), cfg("new")]);
    expect(next.map((c) => c.id)).toEqual(["b", "a", "new"]);
  });

  it("ignores a duplicated id in the arrangement rather than showing a row twice", () => {
    // Defensive: a persisted arrangement is not something this module gets to trust.
    const next = applyQueueArrangement(["a", "a", "b"], [cfg("a"), cfg("b")]);
    expect(next.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("returns an empty list when every config is gone", () => {
    expect(applyQueueArrangement(["a", "b"], [])).toEqual([]);
  });

  it("survives an arrangement that mentions nothing that exists", () => {
    const next = applyQueueArrangement(["stale-1", "stale-2"], [cfg("a"), cfg("b")]);
    expect(next.map((c) => c.id)).toEqual(["a", "b"]);
  });
});
