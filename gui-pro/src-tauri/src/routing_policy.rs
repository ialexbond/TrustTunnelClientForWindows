//! Pure compiler for the Windows core's two routing sets. `!entry` restores the default
//! route ahead of exclusions; the packaged core must advertise routing-policy-version 1.

use std::collections::HashSet;

pub(crate) const DEFAULT_PRIVATE_EXCLUSIONS: &[&str] = &[
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "::1/128",
    "fc00::/7",
    "fe80::/10",
];

pub(crate) fn build_general_exclusions(direct: &[String], proxy: &[String]) -> Vec<String> {
    let mut result: Vec<String> = direct.iter().filter(|e| !e.is_empty()).cloned().collect();
    let forced: HashSet<&str> = proxy.iter().map(String::as_str).collect();
    let mut present: HashSet<String> = result.iter().cloned().collect();
    for &cidr in DEFAULT_PRIVATE_EXCLUSIONS {
        if !forced.contains(cidr) && present.insert(cidr.to_string()) {
            result.push(cidr.to_string());
        }
    }
    append_overrides(&mut result, proxy);
    result
}

fn append_overrides(result: &mut Vec<String>, entries: &[String]) {
    result.extend(
        entries
            .iter()
            .filter(|e| !e.is_empty())
            .map(|e| format!("!{e}")),
    );
}

pub(crate) fn build_exclusions(mode: &str, direct: &[String], proxy: &[String]) -> Vec<String> {
    if mode == "selective" {
        let mut result: Vec<String> = proxy.iter().filter(|e| !e.is_empty()).cloned().collect();
        append_overrides(&mut result, direct);
        result
    } else {
        build_general_exclusions(direct, proxy)
    }
}

pub(crate) fn requires_override_support(exclusions: &[String]) -> bool {
    exclusions
        .iter()
        .any(|entry| entry.starts_with(['!', '+', '^']))
}

pub(crate) fn build_policy(
    mode: &str,
    direct: &[String],
    proxy: &[String],
    explicit_direct: &[String],
    explicit_proxy: &[String],
) -> Vec<String> {
    let mut result = build_exclusions(mode, direct, proxy);
    let (excluded, defaults) = if mode == "selective" {
        (explicit_proxy, explicit_direct)
    } else {
        (explicit_direct, explicit_proxy)
    };
    result.extend(
        excluded
            .iter()
            .filter(|e| !e.is_empty())
            .map(|e| format!("+{e}")),
    );
    result.extend(
        defaults
            .iter()
            .filter(|e| !e.is_empty())
            .map(|e| format!("^{e}")),
    );
    result
}

pub(crate) fn core_supports_overrides(help: &str) -> bool {
    help.lines()
        .any(|line| line.trim_start().starts_with("--routing-policy-version"))
}

pub(crate) fn resolution_is_complete(unresolved: &[String]) -> bool {
    unresolved.is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|e| e.to_string()).collect()
    }

    #[test]
    fn vpn_exception_survives_a_broad_direct_country_range() {
        let compiled = build_exclusions(
            "general",
            &values(&["192.0.2.0/24"]),
            &values(&["vpn.example.com", "*.vpn.example.com"]),
        );
        assert!(compiled.contains(&"192.0.2.0/24".into()));
        assert!(compiled.contains(&"!vpn.example.com".into()));
        assert!(compiled.contains(&"!*.vpn.example.com".into()));
        assert!(requires_override_support(&compiled));
    }

    #[test]
    fn selective_mode_keeps_explicit_direct_exceptions() {
        let compiled = build_exclusions(
            "selective",
            &values(&["direct.example.com"]),
            &values(&["*.example.com"]),
        );
        assert_eq!(compiled, values(&["*.example.com", "!direct.example.com"]));
    }

    #[test]
    fn default_private_networks_remain_direct_except_explicit_overrides() {
        let compiled = build_exclusions("general", &[], &values(&["192.168.0.0/16"]));
        assert!(!compiled.contains(&"192.168.0.0/16".into()));
        assert!(compiled.contains(&"!192.168.0.0/16".into()));
        assert!(compiled.contains(&"10.0.0.0/8".into()));
    }

    #[test]
    fn an_explicit_direct_entry_is_not_lost_while_adding_defaults() {
        let compiled = build_exclusions(
            "general",
            &values(&["direct.example.com", "10.0.0.0/8"]),
            &[],
        );
        assert_eq!(compiled.iter().filter(|e| *e == "10.0.0.0/8").count(), 1);
        assert!(compiled.contains(&"direct.example.com".into()));
        assert!(!requires_override_support(&compiled));
    }

    #[test]
    fn legacy_core_help_cannot_claim_the_new_policy_format() {
        assert!(!core_supports_overrides(
            "-c, --config Config file\n-v, --version Print version"
        ));
        assert!(core_supports_overrides(
            "  --routing-policy-version Print supported format\n"
        ));
    }

    #[test]
    fn a_missing_list_cannot_be_started_as_a_partial_policy() {
        assert!(resolution_is_complete(&[]));
        assert!(!resolution_is_complete(&values(&["geosite:missing"])));
    }

    #[test]
    fn compiled_bytes_match_the_fixture_executed_by_the_cpp_matcher() {
        let compiled = build_policy(
            "general",
            &values(&["192.0.2.0/24", "direct.example.com"]),
            &values(&["vpn.example.com", "*.vpn.example.com", "direct.example.com"]),
            &values(&["direct.example.com"]),
            &values(&["vpn.example.com", "*.vpn.example.com"]),
        );
        assert_eq!(
            compiled.join("\n"),
            include_str!("../../../core/test/fixtures/routing_default_overrides.txt").trim_end()
        );
    }
}
