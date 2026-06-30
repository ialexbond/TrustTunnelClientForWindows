// Wave-0 scaffold — SUPERSEDED in Wave 1 (Plan 11-02).
//
// The real ConfigList behaviour is now asserted in the production test alongside the
// component: `../ConfigList.production.test.tsx` (empty-no-configs single CTA, the F22
// a11y rule, the loading skeleton, and the migrated lead card rendering). This Wave-0
// scaffold file is kept only as a breadcrumb so anyone looking for "the ConfigList test"
// here is pointed at the production suite; it intentionally holds no assertions of its
// own to avoid duplicating the same truths in two places.
//
// Story-vs-plan note (resolved in 11-02): the live design contract
// (ConfigList.stories.tsx → EmptyNoConfigs) renders a SINGLE «Импортировать конфиг» CTA —
// the «…мастер установки» pointer was intentionally dropped (the install wizard installs
// the protocol, not configs). The production test asserts the live single-CTA contract.

import { describe, it, expect } from "vitest";

describe("ConfigList (scaffold pointer)", () => {
  it("delegates real assertions to ConfigList.production.test.tsx", () => {
    // Sentinel: the production suite is the source of truth for ConfigList behaviour.
    expect(true).toBe(true);
  });
});
