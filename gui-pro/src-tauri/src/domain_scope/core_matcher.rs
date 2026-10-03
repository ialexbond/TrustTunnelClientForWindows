//! A line-by-line model of the C++ core's name matcher, for tests only.
//!
//! # Why this exists
//!
//! Phase 30.1 recorded the lesson this file is built on: a test that asserts BYTES IN A FILE proves
//! delivery, not effect. `exclusions.txt` containing the line `maxmind.com` was true before
//! ROUTE-10 was fixed and is true after it — the property that actually changed is what the CORE
//! does with those bytes, and the core is frozen C++ we do not build or link here.
//!
//! So the rule the core enforces is modelled here, transcribed from the source rather than
//! remembered, and the routing tests assert against THE MODEL. A test can then say «the core would
//! send `device.maxmind.com` down the tunnel» and mean it.
//!
//! # What it is transcribed from
//!
//! * `core/src/domain_filter.cpp:55-85`  — `parse_entry`: the character whitelist and the
//!   EXACT/SUBDOMAINS flag decision.
//! * `core/src/domain_filter.cpp:87-128` — `update_exclusions`: whitespace splitting and the `|=`
//!   merge that puts both forms of a name on one key.
//! * `core/src/domain_filter.cpp:130-158` — `match_domain`: the suffix walk and the length
//!   comparisons that make EXACT mean «this name and its `www.` twin».
//!
//! # What it deliberately does NOT model
//!
//! The address and CIDR tables (`domain_filter.cpp:36-53`, `:96-104`, `:160-175`). An entry that
//! parses as an IP, a `host:port` or a CIDR never enters the domain table, and a NAME query is
//! never answered from those tables — so for the question these tests ask («does the core match
//! this hostname?») skipping them is exact, not an approximation. [`entry_kind`] classifies them so
//! a test can still assert that an IP rule stayed out of the domain table.
//!
//! # The one thing that must never happen to this file
//!
//! It must not be «adjusted until the tests pass». It is only worth anything while it is a faithful
//! transcription; `domain_scope::tests::the_model_agrees_with_the_core_about_what_one_bare_line_means`
//! pins it against the four cases the core's own test suite states
//! (`core/test/test_domain_filter.cpp:52-72`). If the core is ever updated, re-transcribe.

use std::collections::HashMap;

/// `WILDCARD_PREFIX` / `WWW_PREFIX` as the core spells them (`domain_filter.cpp:74`, `:79`).
const WILDCARD_PREFIX: &str = "*.";
const WWW_PREFIX: &str = "www.";

/// Where the core would file one entry of an exclusions list.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum EntryKind {
    /// The domain table, matched by name (`m_domains`).
    Domain,
    /// The address or CIDR tables, matched by IP and never by name.
    AddressOrCidr,
    /// `Malformed entry detected in exceptions list` — logged and dropped (`:106-108`).
    Malformed,
}

/// Classify one entry exactly as `parse_entry` would.
pub(crate) fn entry_kind(entry: &str) -> EntryKind {
    // `parse_entry` tries SocketAddress, then CidrRange, then the domain arm. Modelled by shape:
    // anything holding a `/` is a CIDR attempt and anything that parses as an IP (with or without a
    // trailing `:port`) is an address. Both land outside the domain table, which is all the tests
    // downstream need to know.
    if entry.contains('/') {
        return EntryKind::AddressOrCidr;
    }
    if entry.parse::<std::net::IpAddr>().is_ok() || entry.parse::<std::net::SocketAddr>().is_ok() {
        return EntryKind::AddressOrCidr;
    }

    let domain = entry.strip_prefix(WILDCARD_PREFIX).unwrap_or(entry);
    if domain.is_empty() {
        return EntryKind::Malformed;
    }
    // `for (char last_ch = '.'; char ch : domain)` — the seed is what rejects a leading dot.
    let mut last = '.';
    for ch in domain.chars() {
        if !(ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.') {
            return EntryKind::Malformed;
        }
        if ch == '.' && last == '.' {
            return EntryKind::Malformed;
        }
        last = ch;
    }
    EntryKind::Domain
}

/// The two match modes a key can carry, merged with `|=` when a name appears in both forms.
#[derive(Default, Clone, Copy)]
struct Flags {
    exact: bool,
    subdomains: bool,
}

/// Build the core's `m_domains` table from the exact bytes of an exclusions file.
fn domain_table(exclusions: &str) -> HashMap<String, Flags> {
    let mut table: HashMap<String, Flags> = HashMap::new();
    // `update_exclusions` splits on ANY whitespace, not on newlines (`:114-125`).
    for entry in exclusions.split_whitespace() {
        if entry_kind(entry) != EntryKind::Domain {
            continue;
        }
        let (key, flags) = match entry.strip_prefix(WILDCARD_PREFIX) {
            Some(rest) => (
                rest.to_string(),
                Flags { exact: false, subdomains: true },
            ),
            None => (
                entry.strip_prefix(WWW_PREFIX).unwrap_or(entry).to_string(),
                Flags { exact: true, subdomains: false },
            ),
        };
        let slot = table.entry(key).or_default();
        slot.exact |= flags.exact;
        slot.subdomains |= flags.subdomains;
    }
    table
}

/// Would the core route `query` by this exclusions list? `true` = `DFMS_EXCLUSION`.
///
/// `exclusions` is the literal content of `resolved/exclusions.txt`, so a test can read the file
/// the app actually wrote and ask this question of it.
pub(crate) fn core_match_domain(exclusions: &str, query: &str) -> bool {
    let table = domain_table(exclusions);

    let www_prefixed = query.starts_with(WWW_PREFIX);
    let mut seek = if www_prefixed {
        query[WWW_PREFIX.len()..].to_string()
    } else {
        query.to_string()
    };

    loop {
        if let Some(flags) = table.get(&seek) {
            // Transcribed verbatim from `:139-142`. The length comparisons are the whole reason a
            // bare name does not cover subdomains: EXACT demands that the key IS the query (or the
            // query minus its `www.`), so a shortened `seek` can only ever match via SUBDOMAINS.
            let found = (flags.exact
                && (seek.len() == query.len()
                    || (www_prefixed && seek.len() + WWW_PREFIX.len() == query.len())))
                || (flags.subdomains && seek.len() < query.len());
            if found {
                return true;
            }
        }

        match seek.find('.') {
            Some(next_dot) if next_dot + 1 < seek.len() => {
                seek = seek[next_dot + 1..].to_string();
            }
            _ => return false,
        }
    }
}
