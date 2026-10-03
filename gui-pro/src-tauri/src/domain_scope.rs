//! What a NAME-shaped routing rule means, and the bytes that make the C++ core agree.
//!
//! # The policy (owner's ruling, 2026-09-03)
//!
//! > «Я добавляю просто домен, допустим `maxmind.com`. И я ожидаю, что все поддомены —
//! > `mail.maxmind.com`, `geoip.maxmind.com` — тоже идут напрямую.»
//!
//! **A bare name means that name AND every subdomain of it.** That is what the user expects, what
//! every comparable split-tunnel product does, and — since 2026-09-03 — the contract of this app.
//!
//! # Why one bare line does NOT deliver that
//!
//! The C++ core (frozen, not ours) decides an entry's match mode at PARSE time
//! (`core/src/domain_filter.cpp:74-82`):
//!
//! ```text
//! if (starts_with(entry, "*.")) { match_flags.set(DFMM_SUBDOMAINS); }
//! else                          { match_flags.set(DFMM_EXACT); /* + strip a leading "www." */ }
//! ```
//!
//! `DFMM_EXACT` matches the name itself and its `www.` twin, and NOTHING else — the core's own
//! test suite pins `{"example.com", "sub.sub.example.com"} -> DFMS_DEFAULT` as a no-match
//! (`core/test/test_domain_filter.cpp:72`). So the eleven bytes `maxmind.com` reach the core as
//! «this exact host plus www.», and `device.maxmind.com` goes the other way — the defect the owner
//! reported (ROUTE-10).
//!
//! # Why the fix is entirely ours
//!
//! The core ALREADY supports «the name and all its subdomains»; you write both forms, and its own
//! tests pin the pair (`core/test/test_domain_filter.cpp:55-56`):
//!
//! ```text
//! {VPN_MODE_GENERAL, "example.com *.example.com", "sub.example.com"},   // matches
//! {VPN_MODE_GENERAL, "*.example.com example.com", "example.com"},       // matches
//! ```
//!
//! `update_exclusions` merges the two lines onto ONE hash-map key with `|=`
//! (`domain_filter.cpp:101`), so the entry ends up carrying both flags. Two consequences worth
//! stating, because they are what makes this cheap:
//!
//! * The resolved `exclusions.txt` grows by exactly ONE LINE PER NAME, so how much it grows
//!   depends on how many of a user's entries are names rather than addresses. MEASURED, by running
//!   this resolver over a copy of a real rule set rather than by projecting: his
//!   «Напрямую» list — mostly CIDRs from `geoip:ru` / `geoip:private` / `iplist_group:ru_whitelist`
//!   — goes 584 692 → 633 253 bytes (+8.3 %; 28 151 → 30 834 lines, only 2 683 of them names),
//!   while his «Через VPN» list — almost entirely `geosite:ru-blocked` — goes 1 210 712 →
//!   2 571 150 bytes (+112 %; 74 908 → 149 811 lines). The «roughly doubles» estimate made before
//!   the fix landed describes the second case; the first, which is the mode he actually runs, costs
//!   under a tenth of that. Nothing on either side caps the file: our writer has no limit
//!   (`MAX_ROUTING_JSON_BYTES` caps `routing_rules.json`, a different file), and the sidecar
//!   `ftell`s the whole thing into one `std::string` (`trusttunnel/src/config.cpp:294-310`).
//!   The core's in-memory table does not grow at all.
//! * The `DFMM_EXACT` bit SURVIVES the merge, so `get_resolvable_exclusions`
//!   (`domain_filter.cpp:205-213`) still hands these names to the background IP-resolution
//!   backstop. Writing the second line takes nothing away.
//!
//! # Which rules this applies to, and why that is every name we write on the user's behalf
//!
//! Applied by [`crate::routing_rules::resolve_entries_collecting`] to `domain` rules, to
//! `iplist_group` cache entries and to the unknown-type fallback (which documents itself as
//! «treating it as a domain»), and by [`crate::geodata_v2ray::format_geo_domain`] to v2ray type-2
//! (suffix) entries.
//!
//! The one name-shaped rule that is deliberately NOT expanded is v2ray type 3 (`Full`). There the
//! geosite publisher has explicitly said «this exact host» by choosing a different type, and
//! honouring a stated intent is not the same question as guessing at an unstated one. Everywhere
//! else — a hand-typed rule, a group cache of bare hostnames, an unknown type — nobody has said
//! anything about scope, so the ruling decides it.
//!
//! # A Cyrillic name is converted on the way out, not on the way in
//!
//! ROUTE-11, closed 2026-09-04. «сайт.рф» stays «сайт.рф» everywhere the user can see it, and
//! reaches the core as `xn--80aswg.xn--p1ai` — with `*.xn--80aswg.xn--p1ai` as its twin, built from
//! the CONVERTED name. [`to_core_ascii`] owns that and states why both halves are necessary.
//!
//! # There is still exactly one way to say «subdomains only»
//!
//! An entry the user writes as `*.example.com` keeps its own `*.` and is never given a second one,
//! so it keeps meaning
//! subdomains-and-`www.`-but-not-the-apex. Double-prefixing it would produce `*.*.example.com`,
//! which fails the core's character whitelist (`domain_filter.cpp:62-70`) and is DISCARDED with a
//! «Malformed entry detected in exceptions list» line (`:108`) — i.e. the rule would silently stop
//! routing. That is the sharpest of the guards below and it has its own test.

/// The prefix the core reads as «subdomains» (`WILDCARD_PREFIX`, `domain_filter.cpp:74`).
const WILDCARD_PREFIX: &str = "*.";

/// Expand ONE name-shaped rule into the lines that make the core cover the name and its subdomains.
///
/// Returns the value unchanged (a single line) whenever expanding it would be wrong or would emit
/// something the core cannot parse — see [`is_plain_name`]. Never returns an empty vector: a rule
/// this function does not understand is still the user's rule and must keep reaching the core
/// exactly as it did before.
pub(crate) fn expand_domain_rule(value: &str) -> Vec<String> {
    // ROUTE-11: convert BEFORE the guards and before the wildcard is built, so `is_plain_name` and
    // the `*.` twin both see the bytes the core will actually compare against.
    let value = to_core_ascii(value);
    if !is_plain_name(&value) {
        return vec![value.into_owned()];
    }
    vec![value.to_string(), format!("{WILDCARD_PREFIX}{value}")]
}

/// Turn one stored name into the ASCII the core can match, i.e. punycode for an IDN (ROUTE-11).
///
/// # Why this belongs here and not where the rule is stored
///
/// The user typed «сайт.рф» and must keep seeing «сайт.рф» — in the rule list, in export/import,
/// everywhere. Converting at storage time would change what they are looking at to fix something
/// they cannot see. So the stored rule stays as written and the conversion happens on the way out,
/// in the one place that already owns «what bytes does the core read for this name».
///
/// # Why it is needed at all
///
/// Two independent reasons, either of which is fatal on its own:
///
/// * The core runs every entry through `isalnum(ch)` on a `char`
///   (`core/src/domain_filter.cpp:62-70`), so raw UTF-8 is DISCARDED as «Malformed entry detected
///   in exceptions list». Our own input field accepts Cyrillic with a dedicated message
///   (`AddRuleInput.tsx`), so the user is told the rule is fine while it never reaches the matcher.
/// * Even past that gate it could not match. The hostname the core compares against arrives from a
///   DNS query and is therefore already `xn--…`; a UTF-8 key has nothing to match.
///
/// # The two things it must not do
///
/// * **An ASCII value must come out byte-identical.** IDNA mapping lowercases and re-folds, which
///   for `Example.COM` would be a silent change to 99 % of rules in exchange for nothing. So an
///   ASCII value is never handed to the mapper — the check is the guarantee, not the mapper's
///   good behaviour.
/// * **A value it cannot honestly convert must survive unchanged.** Conversion is a chance to do
///   better, never a new way to lose a rule, so the fallback is the user's own text — which then
///   meets exactly the guards it met before.
///
/// That second point needs a stronger test than «did idna return `Ok`», because `Ok` is not the
/// same as usable. `domain_to_ascii` runs with `UseSTD3ASCIIRules = false`, which is what lets a
/// legitimate `_` through — but it also lets a SPACE through: `два слова.рф` comes back as the
/// `Ok` value `xn-- -7sbbfci6cyaz.xn--p1ai`, space and all, which the core would discard as
/// malformed. Emitting that would replace the user's readable rule with mangled bytes and lose it
/// just the same. So the result is kept only if it is a name the core could actually store — the
/// same [`is_plain_name`] predicate the caller applies — and anything else, including a mapping
/// that collapses to nothing (an ignorable code point such as U+00AD), falls back to the original.
///
/// A leading `*.` is split off first: it is our own wildcard marker, not part of any label, and
/// IDNA has no reason to accept it.
fn to_core_ascii(value: &str) -> std::borrow::Cow<'_, str> {
    if value.is_ascii() {
        return std::borrow::Cow::Borrowed(value);
    }
    let (prefix, name) = match value.strip_prefix(WILDCARD_PREFIX) {
        Some(rest) => (WILDCARD_PREFIX, rest),
        None => ("", value),
    };
    match idna::domain_to_ascii(name) {
        Ok(ascii) if is_plain_name(&ascii) => std::borrow::Cow::Owned(format!("{prefix}{ascii}")),
        _ => std::borrow::Cow::Borrowed(value),
    }
}

/// Is this value a plain DNS name that the core would store in its DOMAIN table?
///
/// Deliberately a MIRROR of the core's own acceptance test (`domain_filter.cpp:59-70`) rather than
/// a looser guess, because the cost of the two errors is asymmetric: expanding something the core
/// then rejects adds a line it logs as malformed (noise for nothing), while refusing to expand a
/// real name silently keeps the ROUTE-10 defect for that rule. So this answers «would the core
/// accept `*.` + this value as a domain entry», and nothing broader.
///
/// What it rejects, and why each one matters:
///
/// * **Anything already carrying `*`** — `*.x.com` must not become `*.*.x.com` (see the module
///   note); a mid-name `*` was never a valid entry to begin with.
/// * **A dotless value** — `youtube` is stored EXACT and can already match nothing, since the
///   matcher only ever looks up suffixes of a real hostname (`domain_filter.cpp:130-157`).
///   `*.youtube` would be a second dead line rather than a fix.
/// * **An IP literal**, so an `ip`-shaped value arriving through a name-shaped door never grows a
///   wildcard. `1.2.3.4` belongs in the core's ADDRESS table (`domain_filter.cpp:96-98`);
///   `*.1.2.3.4` would land in the domain table instead and match nothing at all.
/// * **A `:` or a `/`** — a port or a CIDR; both are parsed by the core BEFORE the domain arm
///   (`domain_filter.cpp:36-53`), and neither survives the character whitelist afterwards.
/// * **Whitespace** — the core splits its exclusions blob on whitespace (`:114-125`), so a value
///   containing any would not have been one entry in the first place.
/// * **Non-ASCII** — but by the time this runs, [`to_core_ascii`] has already turned an IDN into
///   its punycode, so the only non-ASCII values still arriving here are the ones IDNA itself
///   refused. Those the core would feed to `isalnum(char)` and discard, so expanding them would
///   add a second line it also discards (ROUTE-11, closed 2026-09-04).
/// * **A leading `.` or a `..` run** — the core rejects both outright (`:66-68`).
fn is_plain_name(value: &str) -> bool {
    if value.is_empty() || !value.contains('.') {
        return false;
    }
    if value.parse::<std::net::IpAddr>().is_ok() {
        return false;
    }
    // The core seeds its own scan with `last_ch = '.'`, which is what makes a LEADING dot fail the
    // `..` test below. Seeded identically here on purpose — a value the core would call malformed
    // must not be handed a wildcard twin.
    let mut last = '.';
    for ch in value.chars() {
        if !(ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.') {
            return false;
        }
        if ch == '.' && last == '.' {
            return false;
        }
        last = ch;
    }
    true
}

/// A faithful, test-only model of the core's matcher. Lives behind `cfg(test)` and is never
/// compiled into the shipped binary — see the module's own header for what it is for.
#[cfg(test)]
pub(crate) mod core_matcher;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_name_is_expanded_into_both_forms_the_core_needs() {
        assert_eq!(
            expand_domain_rule("maxmind.com"),
            vec!["maxmind.com".to_string(), "*.maxmind.com".to_string()],
            "a bare name must reach the core as the pair its own tests pin \
             (core/test/test_domain_filter.cpp:55-56)"
        );
    }

    #[test]
    fn an_entry_already_written_as_a_wildcard_is_never_double_prefixed() {
        // `*.*.x.com` fails the core's character whitelist (domain_filter.cpp:62-70) and is
        // DISCARDED as «Malformed entry detected in exceptions list» — the rule would stop routing.
        assert_eq!(
            expand_domain_rule("*.maxmind.com"),
            vec!["*.maxmind.com".to_string()],
            "double-prefixing turns a working rule into one the core throws away"
        );
    }

    #[test]
    fn an_address_shaped_value_never_grows_a_wildcard() {
        for value in ["1.2.3.4", "255.255.255.255", "::1", "2001:db8::1", "::ffff:1.2.3.4"] {
            assert_eq!(
                expand_domain_rule(value),
                vec![value.to_string()],
                "{value} belongs in the core's ADDRESS table; a wildcard form would land in the \
                 domain table and match nothing"
            );
        }
        for value in ["10.0.0.0/8", "fc00::/7", "1.2.3.4:8080"] {
            assert_eq!(
                expand_domain_rule(value),
                vec![value.to_string()],
                "{value} is parsed by the core before the domain arm ever sees it"
            );
        }
    }

    #[test]
    fn a_dotless_value_produces_no_nonsense_wildcard() {
        for value in ["youtube", "localhost", ""] {
            assert_eq!(
                expand_domain_rule(value),
                vec![value.to_string()],
                "{value:?} has no dot; the matcher only looks up suffixes of a real hostname, so a \
                 wildcard form would be a second dead line rather than a fix"
            );
        }
    }

    #[test]
    fn a_value_the_core_would_call_malformed_is_passed_through_untouched() {
        // Each of these is rejected by the core's own whitelist. Expanding them would double the
        // number of lines it logs as malformed while fixing nothing.
        for value in [
            ".example.com",
            "example..com",
            "example.com/path",
            "two words.com",
            "^r+[0-9]+\\.googlevideo\\.com$",
        ] {
            assert_eq!(
                expand_domain_rule(value),
                vec![value.to_string()],
                "{value:?} must reach the core exactly as before — no better, no noisier"
            );
        }
    }

    // ─── ROUTE-11: IDN ────────────────────────────────────────────────────────────────────────

    #[test]
    fn a_cyrillic_name_reaches_the_core_as_the_punycode_the_dns_query_carries() {
        // `сайт.рф` was in the «malformed, pass through» list above until 2026-09-04, and that was
        // the bug: the input field ACCEPTS Cyrillic (AddRuleInput.tsx has a dedicated error string
        // for it), so the user is told the rule is fine while the raw UTF-8 fails the core's
        // `isalnum(char)` whitelist (domain_filter.cpp:62-70) and is discarded. Even if it survived,
        // the hostname the core matches against comes out of a DNS query and is ALREADY punycode —
        // a UTF-8 key could never match it.
        assert_eq!(
            expand_domain_rule("сайт.рф"),
            vec![
                "xn--80aswg.xn--p1ai".to_string(),
                "*.xn--80aswg.xn--p1ai".to_string()
            ],
            "the wildcard twin must be built from the CONVERTED name — `*.сайт.рф` would be a \
             second line the core also throws away"
        );
    }

    #[test]
    fn a_wildcard_the_user_typed_in_cyrillic_is_converted_and_still_not_double_prefixed() {
        assert_eq!(
            expand_domain_rule("*.сайт.рф"),
            vec!["*.xn--80aswg.xn--p1ai".to_string()],
            "the `*.` the user wrote keeps meaning subdomains-only; only the NAME under it converts"
        );
    }

    #[test]
    fn an_ascii_name_comes_out_byte_identical() {
        // The 99 % case must not pay for the 1 %. IDNA mapping lowercases and re-folds, so a name
        // that is already ASCII is never handed to it — `Example.COM` staying `Example.COM` is what
        // proves the conversion is skipped rather than merely well-behaved.
        assert_eq!(
            expand_domain_rule("Example.COM"),
            vec!["Example.COM".to_string(), "*.Example.COM".to_string()],
            "an ASCII value must survive byte-for-byte — no normalisation surprises"
        );
    }

    #[test]
    fn a_non_ascii_value_idna_cannot_convert_is_still_passed_through_untouched() {
        // Conversion is a chance to do better, never a new way to lose a rule.
        //
        // «два слова.рф» is the case that makes this test worth writing rather than assuming:
        // idna does NOT refuse it. With UseSTD3ASCIIRules = false it returns the `Ok` value
        // `xn-- -7sbbfci6cyaz.xn--p1ai` — space and all — which the core discards as malformed.
        // Trusting `Ok` alone would have swapped the user's readable rule for mangled bytes and
        // lost it exactly the same way. `сайт.рф/path` and U+00AD cover the other two shapes: a
        // conversion the mapper rejects outright, and one that collapses to nothing.
        for value in ["два слова.рф", "сайт.рф/path", "\u{00AD}"] {
            assert_eq!(
                expand_domain_rule(value),
                vec![value.to_string()],
                "{value:?} is not convertible; it must arrive unchanged rather than mangled"
            );
        }
    }

    #[test]
    fn the_model_agrees_with_the_core_about_what_one_bare_line_means() {
        // The premise of this whole module, asserted rather than assumed. If this ever fails, the
        // model has drifted from `domain_filter.cpp` and every test built on it is worthless.
        assert!(
            core_matcher::core_match_domain("example.com", "example.com"),
            "EXACT matches the name itself (domain_filter.cpp:139-141)"
        );
        assert!(
            core_matcher::core_match_domain("example.com", "www.example.com"),
            "EXACT also matches the www. twin (domain_filter.cpp:79-81, :141)"
        );
        assert!(
            !core_matcher::core_match_domain("example.com", "sub.sub.example.com"),
            "and nothing else — the core's own test pins this no-match \
             (core/test/test_domain_filter.cpp:72)"
        );
        assert!(
            core_matcher::core_match_domain("example.com *.example.com", "sub.example.com"),
            "…while the PAIR matches, which is the whole fix \
             (core/test/test_domain_filter.cpp:55)"
        );
    }
}
