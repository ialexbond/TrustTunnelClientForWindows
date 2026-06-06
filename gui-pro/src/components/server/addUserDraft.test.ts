import { describe, it, expect, beforeEach } from "vitest";
import {
  readAddUserDraft,
  writeAddUserDraft,
  clearAddUserDraft,
} from "./addUserDraft";

/**
 * addUserDraft — per-server-identity scoping (Users C-03 + review LOW) and
 * secret-at-rest (SAFETY-02) regression tests.
 *
 * Regression-test-first half of Phase 04 Plan 06 Tasks 2–3 — each block FAILS
 * before its fix and PASSES after:
 *   - cross-server bleed + same-hostname collision  → per-server-identity key
 *   - password persisted in sessionStorage          → password excluded at rest
 */

interface FakeDeeplink {
  displayName: string;
  cidr: string;
}

const draftA = {
  username: "alice",
  password: "S3cr3tA",
  deeplink: { displayName: "A", cidr: "10.0.0.0/24" } satisfies FakeDeeplink,
};
const draftB = {
  username: "bob",
  password: "S3cr3tB",
  deeplink: { displayName: "B", cidr: "10.0.1.0/24" } satisfies FakeDeeplink,
};

// The scoping assertions compare against the AT-REST shape: SAFETY-02 drops the
// password from sessionStorage, so a restored draft always has password="".
// These helpers keep the scoping tests focused on identity isolation (which
// username/deeplink come back under which key), not on password persistence
// (covered by the secret-at-rest block below).
const atRestA = { ...draftA, password: "" };
const atRestB = { ...draftB, password: "" };

// Two distinct server identities. `serverId` is the FULL identity the app uses
// to tell server records apart (host:port:user), NOT the bare hostname.
const SERVER_A = "alpha.example.com:22:root";
const SERVER_B = "beta.example.com:22:root";
// Same bare hostname, different port/user — the review-LOW collision case.
const HOST_2200_ROOT = "shared.example.com:2200:root";
const HOST_22_ADMIN = "shared.example.com:22:admin";

describe("addUserDraft — per-server-identity scoping (C-03)", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("does NOT bleed a draft written for server A into server B (cross-server isolation)", () => {
    writeAddUserDraft<FakeDeeplink>(SERVER_A, draftA);

    // Server B has never had a draft written — it must see nothing, not A's.
    expect(readAddUserDraft<FakeDeeplink>(SERVER_B)).toBeNull();
    // Server A still reads its own draft back (password dropped at rest).
    expect(readAddUserDraft<FakeDeeplink>(SERVER_A)).toEqual(atRestA);
  });

  it("keeps drafts INDEPENDENT for two server entries that share a hostname but differ in port/user (review LOW collision)", () => {
    writeAddUserDraft<FakeDeeplink>(HOST_2200_ROOT, draftA);
    writeAddUserDraft<FakeDeeplink>(HOST_22_ADMIN, draftB);

    // Each identity reads back its OWN draft — no overwrite/collision on the
    // shared bare hostname.
    expect(readAddUserDraft<FakeDeeplink>(HOST_2200_ROOT)).toEqual(atRestA);
    expect(readAddUserDraft<FakeDeeplink>(HOST_22_ADMIN)).toEqual(atRestB);
  });

  it("clear is scoped to one identity and leaves the other intact", () => {
    writeAddUserDraft<FakeDeeplink>(SERVER_A, draftA);
    writeAddUserDraft<FakeDeeplink>(SERVER_B, draftB);

    clearAddUserDraft(SERVER_A);

    expect(readAddUserDraft<FakeDeeplink>(SERVER_A)).toBeNull();
    expect(readAddUserDraft<FakeDeeplink>(SERVER_B)).toEqual(atRestB);
  });
});

describe("addUserDraft — secret-at-rest (SAFETY-02)", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("never writes the password into the persisted sessionStorage value", () => {
    writeAddUserDraft<FakeDeeplink>(SERVER_A, {
      username: "alice",
      password: "S3cr3t",
      deeplink: { displayName: "A", cidr: "10.0.0.0/24" },
    });

    // Walk EVERY sessionStorage entry — the probe secret must appear nowhere
    // at rest, regardless of which key the draft landed under.
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)!;
      const value = sessionStorage.getItem(key) ?? "";
      expect(value).not.toContain("S3cr3t");
    }
  });

  it("still restores username + deeplink (only the password is dropped at rest)", () => {
    writeAddUserDraft<FakeDeeplink>(SERVER_A, {
      username: "alice",
      password: "S3cr3t",
      deeplink: { displayName: "A", cidr: "10.0.0.0/24" },
    });

    const restored = readAddUserDraft<FakeDeeplink>(SERVER_A);
    expect(restored?.username).toBe("alice");
    expect(restored?.deeplink).toEqual({ displayName: "A", cidr: "10.0.0.0/24" });
    // The password is absent from the restored draft (not persisted).
    expect(restored?.password).toBe("");
  });
});
