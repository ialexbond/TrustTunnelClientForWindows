import { describe, expect, it } from "vitest";

import { reconnectLabel } from "./reconnectLabel";

/**
 * The interpretation layer between the backend's two integers and the sentence a person reads.
 * Every case here is one the owner actually hit or asked for during 28-UAT (tests 1 and 3), so the
 * names say what the user sees rather than which branch runs.
 */
describe("reconnectLabel", () => {
  it("counts retries when one server is being retried", () => {
    // The server is not in question — it is the one on screen. What is in question is patience.
    expect(reconnectLabel({ attempt: 3, max: 10, failover: false })).toEqual({
      key: "status.reconnect_attempt",
      vars: { attempt: 3, max: 10 },
    });
  });

  it("names the server and its place in the queue when a walk has somewhere to go", () => {
    expect(
      reconnectLabel({ attempt: 2, max: 4, failover: true, server: "NL Hip Hosting" }),
    ).toEqual({
      key: "status.failover_to_of",
      vars: { server: "NL Hip Hosting", attempt: 2, max: 4 },
    });
  });

  it("drops the position when there is only one candidate — «1 из 1» is the complaint itself", () => {
    // The words: «вообще это тупо, когда попытка один из одного». With a single candidate
    // the numbers carry nothing the sentence does not already say, so they are not shown at all.
    const label = reconnectLabel({ attempt: 1, max: 1, failover: true, server: "US relay7 PL" });
    expect(label).toEqual({ key: "status.failover_to", vars: { server: "US relay7 PL" } });
    expect(label.vars).not.toHaveProperty("attempt");
    expect(label.vars).not.toHaveProperty("max");
  });

  it("falls back to the position when the server has no readable name", () => {
    // Unreadable or unnamed config: say what is happening, never invent a server.
    expect(reconnectLabel({ attempt: 2, max: 4, failover: true, server: null })).toEqual({
      key: "status.failover_candidate",
      vars: { attempt: 2, max: 4 },
    });
  });

  it("falls back to a bare sentence when there is neither a name nor a useful position", () => {
    expect(reconnectLabel({ attempt: 1, max: 1, failover: true })).toEqual({
      key: "status.failover_next",
      vars: {},
    });
  });

  it("treats a blank or whitespace name as no name at all", () => {
    // A config saved with an empty name must not render «Переключение на «  »».
    expect(reconnectLabel({ attempt: 2, max: 3, failover: true, server: "   " })).toEqual({
      key: "status.failover_candidate",
      vars: { attempt: 2, max: 3 },
    });
  });

  it("ignores a server name on a plain reconnect", () => {
    // Defensive: naming the server the user is already on would add a word and no information.
    expect(reconnectLabel({ attempt: 2, max: 10, failover: false, server: "US relay7 PL" })).toEqual(
      { key: "status.reconnect_attempt", vars: { attempt: 2, max: 10 } },
    );
  });
});
