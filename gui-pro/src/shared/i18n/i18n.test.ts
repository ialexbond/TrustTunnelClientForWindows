import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ru from "./locales/ru.json";
// The app's OWN configured instance — not a instance built for the test. The
// milestone review "reproduced" a Russian plural bug by calling t() directly on
// keys the app reaches only behind a language branch; a gate that builds its own
// i18next can drift from the shipped config the same way.
import i18n from "./index";
// `?raw` imports return the unparsed file text — required for Pitfall 1
// detection: duplicate JSON keys are silently collapsed by `JSON.parse`, so
// the parsed `en`/`ru` modules cannot reveal them. Vite + Vitest both honor
// the `?raw` query (typed via `vite/client` in tsconfig types).
import ruRaw from "./locales/ru.json?raw";
import enRaw from "./locales/en.json?raw";

function flattenKeys(obj: Record<string, unknown>, prefix = ""): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      flattenKeys(value as Record<string, unknown>, fullKey).forEach((k) => keys.add(k));
    } else {
      keys.add(fullKey);
    }
  }
  return keys;
}

describe("i18n key parity", () => {
  it("all English keys exist in Russian", () => {
    const enKeys = flattenKeys(en);
    const ruKeys = flattenKeys(ru);
    const missing = [...enKeys].filter((k) => !ruKeys.has(k));
    expect(missing).toEqual([]);
  });

  it("all Russian keys exist in English", () => {
    const enKeys = flattenKeys(en);
    const ruKeys = flattenKeys(ru);
    const extra = [...ruKeys].filter((k) => !enKeys.has(k));
    expect(extra).toEqual([]);
  });

  it("BUG-A2: messages.connect_cancelled exists in BOTH ru and en with its expected copy", () => {
    // The cancel snackbar («Подключение отменено») must be present + localized in both bundles so the
    // wiring layer (useVpnStatusListener snack:cancelled → i18n.t('messages.connect_cancelled')) never
    // falls back to the raw key / English default in the RU-primary app.
    expect(ru.messages.connect_cancelled).toBe("Подключение отменено");
    expect(en.messages.connect_cancelled).toBe("Connection cancelled");
  });

  it("routing.processListError and its hint exist in BOTH ru and en", () => {
    // The process picker renders these when the running-process enumeration fails. It must render
    // the translated text and never the raw backend error, so a missing key here would put a bare
    // key string in front of the user at precisely the moment something already went wrong.
    expect(ru.routing.processListError).toBeTruthy();
    expect(en.routing.processListError).toBeTruthy();
    expect(ru.routing.processListErrorHint).toBeTruthy();
    expect(en.routing.processListErrorHint).toBeTruthy();
    expect(ru.routing.processListError).not.toBe(en.routing.processListError);
  });
});

describe("Phase 19 — JSON structural integrity", () => {
  // Pitfall 1 mitigation: retracted attempt commit 13118c3f created duplicate
  // "service" JSON keys at the same level — i18n parser silently dropped half
  // of the keys, NSIS installer rendered raw key strings in UI. Single
  // regex-based assertion at file level catches the regression.
  it("ru.json has exactly one 'service' block in JSON (Pitfall 1)", () => {
    const matches = ruRaw.match(/"service"\s*:\s*\{/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("en.json has exactly one 'service' block in JSON (Pitfall 1)", () => {
    const matches = enRaw.match(/"service"\s*:\s*\{/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("ru.json has no 'utilities' keys post-rename (Pitfall 1)", () => {
    const matches = ruRaw.match(/"utilities"\s*:/g) ?? [];
    expect(matches.length).toBe(0);
  });

  it("en.json has no 'utilities' keys post-rename (Pitfall 1)", () => {
    const matches = enRaw.match(/"utilities"\s*:/g) ?? [];
    expect(matches.length).toBe(0);
  });

  it("parity — server.service sub-keys match between ru and en", () => {
    // `as unknown as Record<...>` cast: the typed locale modules describe their
    // exact literal shape, which doesn't overlap with a generic recursive Record.
    // Going through `unknown` is TypeScript's documented escape hatch for
    // "trust me, I know the runtime shape" assertions (per ts2352 hint).
    const ruServer = (ru as unknown as Record<string, Record<string, Record<string, unknown>>>).server;
    const enServer = (en as unknown as Record<string, Record<string, Record<string, unknown>>>).server;
    const ruServiceKeys = Object.keys(ruServer.service).sort();
    const enServiceKeys = Object.keys(enServer.service).sort();
    expect(ruServiceKeys).toEqual(enServiceKeys);
  });

  it("parity — server.service.protocol sub-keys match between ru and en", () => {
    const ruProtocol = (ru as unknown as Record<string, Record<string, Record<string, Record<string, unknown>>>>).server.service.protocol;
    const enProtocol = (en as unknown as Record<string, Record<string, Record<string, Record<string, unknown>>>>).server.service.protocol;
    const ruProtocolKeys = Object.keys(ruProtocol).sort();
    const enProtocolKeys = Object.keys(enProtocol).sort();
    expect(ruProtocolKeys).toEqual(enProtocolKeys);
  });
});

// ─── Phase 30.1-05 — Russian plural completeness ─────────────────────────────
//
// WHY THIS EXISTS, given two gates already guard these files:
//   * `scripts/i18n-dead-keys.cjs` (npm run i18n:check) answers "is this key
//     reachable from the source tree". A plural form that was never written is
//     not an unreachable key — it is an ABSENT one, and set math over the keys
//     that DO exist structurally cannot see it.
//   * The parity assertions above answer "do the two bundles carry the same key
//     set". Two bundles that are both missing `_few` are in perfect parity.
// So neither existing gate can fail on a missing Russian plural form. This one
// renders the strings and reads what comes out.
//
// WHY IT ENUMERATES ITS OWN SUBJECTS: a hard-coded list of today's groups stops
// guarding the moment someone adds the next one — which is exactly how the
// defect this gate was written for got in. The subjects come out of the parsed
// `ru` bundle.
//
// A NOTE ON ITS OWN SOURCE: this comment block necessarily spells out the very
// suffixes the gate searches for. Discovery therefore runs over the PARSED JSON
// object only, never over file text, so no sentence written here can become a
// subject of the rule it explains.

/** The categories the platform itself demands for Russian: one, few, many, other.
 *  Read from `Intl.PluralRules` rather than hard-coded, because that is the same
 *  source i18next v21+ consults when it picks a suffix — a hard-coded list could
 *  disagree with the runtime and the gate would be measuring the wrong thing. */
const RU_PLURAL_CATEGORIES = new Intl.PluralRules("ru").resolvedOptions().pluralCategories;
const RU_PLURAL_RULES = new Intl.PluralRules("ru");

/** Counts chosen so that EVERY Russian category is exercised by an actual render:
 *  1/21/101 → one (21 and 101 are here because a naive `count === 1` guard passes
 *  1 and fails 21), 2/3/4 → few, 5/11 → many, 1.5 → other. `other` is unreachable
 *  from any whole number in Russian, so without a fractional count it could only
 *  ever be checked by key presence — which is the weaker assertion this gate is
 *  written to avoid. */
const RU_GATE_COUNTS = [1, 2, 3, 4, 5, 11, 21, 101, 1.5];

const CANNOT_MEASURE = "CANNOT MEASURE";

function flattenEntries(
  obj: Record<string, unknown>,
  prefix = "",
  out = new Map<string, string>(),
): Map<string, string> {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      flattenEntries(value as Record<string, unknown>, fullKey, out);
    } else if (typeof value === "string") {
      out.set(fullKey, value);
    }
  }
  return out;
}

/**
 * Finds the plural groups in a bundle by stripping a category suffix off each
 * key and collecting the bases.
 *
 * The qualifier — a candidate is a real plural group when at least one of its
 * members interpolates `{{count}}`, OR when it has two or more distinct category
 * suffixes. Without it, an ordinary key that merely happens to end in a category
 * word (`nav.tab_other` = «Другое») would be dragged in and the gate would demand
 * three plural forms for a string that has no count. The `{{count}}` arm covers
 * every group in the bundle today; the two-suffix arm is there so a future group
 * that spells its counts out in words is still a subject.
 */
function discoverPluralGroups(bundle: Record<string, unknown>): Map<string, Set<string>> {
  const entries = flattenEntries(bundle);
  const candidates = new Map<string, Set<string>>();
  const countDriven = new Set<string>();

  for (const [key, value] of entries) {
    for (const category of RU_PLURAL_CATEGORIES) {
      const suffix = `_${category}`;
      if (!key.endsWith(suffix)) continue;
      const group = key.slice(0, -suffix.length);
      const seen = candidates.get(group) ?? new Set<string>();
      seen.add(category);
      candidates.set(group, seen);
      if (value.includes("{{count}}")) countDriven.add(group);
      break;
    }
  }

  const groups = new Map<string, Set<string>>();
  for (const [group, seen] of candidates) {
    if (countDriven.has(group) || seen.size >= 2) groups.set(group, seen);
  }
  return groups;
}

/** An inability to measure is a FAILURE, never a quiet pass. A rule that has lost
 *  its subjects reports green forever while guarding nothing — the exact way the
 *  two gates of phase 30 stopped being evidence. */
function requireSubjects(groups: Map<string, Set<string>>, subject: string): void {
  if (groups.size === 0) {
    throw new Error(
      `${CANNOT_MEASURE}: the Russian plural gate discovered zero plural groups in ${subject}. ` +
        "Either the bundle genuinely has none (then this gate is guarding nothing and must be " +
        "removed deliberately, not left green), or discovery broke and every missing plural form " +
        "in the app is now invisible.",
    );
  }
}

/** What i18next actually returned, plus which bundle it came out of. */
type Resolution = { res: string; usedLng: string };

describe("Russian plural completeness (30.1-05)", () => {
  it("the chosen counts reach every Russian plural category", () => {
    // The gate can only measure the categories its counts select. Drop 1.5 and
    // `other` stops being rendered by anything; drop 5 and `many` does. Neither
    // loss would turn a single assertion red — the gate would just quietly guard
    // less. So the coverage itself is asserted.
    const reached = new Set(RU_GATE_COUNTS.map((n) => RU_PLURAL_RULES.select(n)));
    expect([...reached].sort()).toEqual([...RU_PLURAL_CATEGORIES].sort());
  });

  it("every plural group in ru.json renders its OWN Russian form at every Russian count", async () => {
    const groups = discoverPluralGroups(ru as unknown as Record<string, unknown>);
    requireSubjects(groups, "ru.json");

    await i18n.changeLanguage("ru");
    const ruEntries = flattenEntries(ru as unknown as Record<string, unknown>);

    // Collected rather than thrown one at a time: a bundle with three broken
    // groups should report three, not send the reader round the loop three times.
    const failures: string[] = [];

    for (const group of [...groups.keys()].sort()) {
      for (const count of RU_GATE_COUNTS) {
        const category = RU_PLURAL_RULES.select(count);
        const formKey = `${group}_${category}`;
        const form = ruEntries.get(formKey);

        // Arm 1 — presence. On its own this arm is worthless: a misspelled suffix
        // leaves the correctly-spelled key absent, and a bundle could satisfy a
        // presence-only gate while rendering the wrong string. It is kept because
        // it produces the one diagnostic arm 2 cannot: WHICH form is missing.
        if (form === undefined) {
          failures.push(
            `${formKey} — absent. Russian needs it: count ${count} selects the "${category}" form.`,
          );
          continue;
        }

        const resolved = i18n.t(group, {
          count,
          returnDetails: true,
        }) as unknown as Resolution;
        const expected = form.replace(/\{\{\s*count\s*\}\}/g, String(count));

        // Arm 2 — provenance. i18next reports the bundle it resolved from, so a
        // fall-through to English is named as such instead of being inferred from
        // the text. This is the arm that distinguishes "the Russian form is
        // missing" from "the two languages legitimately share a string": it never
        // compares ru against en at all, so a group whose Russian and English copy
        // are identical is not a false failure.
        if (resolved.usedLng !== "ru") {
          failures.push(
            `${group} @ ${count} — resolved out of the "${resolved.usedLng}" bundle: ` +
              `"${resolved.res}". The Russian UI is showing another language's text.`,
          );
          continue;
        }

        // Arm 3 — the resolved string. This is the assertion that carries the
        // gate. It cannot be satisfied by accident: the only way to render exactly
        // the "${category}" form is for i18next to have selected exactly that key.
        // It catches what neither presence nor provenance can — i18next falls back
        // to a BARE key within the same language when the selected form is absent,
        // which quietly supplies a WRONG grammatical form while provenance still
        // reads "ru".
        if (resolved.res !== expected) {
          failures.push(
            `${group} @ ${count} — rendered "${resolved.res}", but the "${category}" form ` +
              `(${formKey}) is "${expected}". Something other than that form answered.`,
          );
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("no plural group carries a bare key beside its forms", () => {
    // The masking construct, banned. When the selected plural form is absent,
    // i18next does NOT fail over to the fallback language if a bare key of the
    // same name exists — it answers with the bare key, in the right language and
    // the wrong grammar. `firewall_subtitle_active_rules` shipped exactly that:
    // at count 2 the Russian UI rendered «2 правил» (should be «2 правила»)
    // while `_few` was missing, so provenance still read "ru" and the review's
    // own reproduction saw Russian text and moved on.
    const groups = discoverPluralGroups(ru as unknown as Record<string, unknown>);
    requireSubjects(groups, "ru.json");
    const ruEntries = flattenEntries(ru as unknown as Record<string, unknown>);
    const enEntries = flattenEntries(en as unknown as Record<string, unknown>);
    const masking: string[] = [];
    for (const group of [...groups.keys()].sort()) {
      if (ruEntries.has(group)) masking.push(`ru.json: ${group}`);
      if (enEntries.has(group)) masking.push(`en.json: ${group}`);
    }
    expect(masking).toEqual([]);
  });

  it("the gate refuses to pass when it has no subjects to measure", () => {
    // Mutation (c) made permanent. A gate whose discovery silently returns
    // nothing is indistinguishable from a gate that found nothing wrong, so the
    // empty case is asserted here rather than trusted.
    expect(discoverPluralGroups({}).size).toBe(0);
    expect(() => requireSubjects(discoverPluralGroups({}), "an empty fixture")).toThrow(
      new RegExp(CANNOT_MEASURE),
    );
  });

  it("discovery admits count-driven groups and rejects lookalike keys", () => {
    // The qualifier, pinned. Left unpinned, a later "simplification" of
    // discoverPluralGroups could quietly widen or narrow the subject set and no
    // test would notice.
    const admitted = discoverPluralGroups({
      area: { thing_one: "{{count}} штука", thing_other: "{{count}} штук" },
    });
    expect([...admitted.keys()]).toEqual(["area.thing"]);

    // A single non-count key that merely ends in a category word is not a group.
    expect(discoverPluralGroups({ nav: { tab_other: "Другое" } }).size).toBe(0);

    // The real bundle must still hold every group the project has today, so a
    // discovery regression that drops subjects cannot hide behind a green run.
    const real = discoverPluralGroups(ru as unknown as Record<string, unknown>);
    expect([...real.keys()].sort()).toEqual([
      "about.when_days",
      "about.when_hours",
      "about.when_minutes",
      "connection.import.config_count",
      "drop.configs_added",
      "server.logs.modal.match_count",
      "server.security.summary.firewall_subtitle_active_rules",
    ]);
  });
});
