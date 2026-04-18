//! TOML editing helpers for `rules.toml` — per-user anti-DPI `client_random_prefix` and CIDR restrictions.
//!
//! Pure parsing/editing — no SSH, no async. SSH I/O lives in `server_config.rs`.
//!
//! Pattern source: adapted from `src/routing_rules.rs:462-518` (toml_edit DocumentMut).
//!
//! Username is stashed in a TOML comment (`# User: {name}\n`) preceding the `[[rule]]` block.
//! toml_edit preserves comments via `decor_mut().set_prefix()`. This gives us reverse mapping
//! from username → rule without needing a separate metadata file.
//!
//! Concurrency: no locking. Upstream rules.toml format does not support it. RESEARCH.md Q5
//! accepts last-write-wins — concurrent edits from two Pro app instances are not supported;
//! docs note this limitation.

use toml_edit::{value, DocumentMut, Item, Table};

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
pub struct UserRule {
    pub client_random_prefix: Option<String>,
    pub cidr: Option<String>,
}

/// Add a `[[rule]]` entry for `username` with optional `prefix` + `cidr`. Returns new file content.
pub fn add_user_rule(
    content: &str,
    username: &str,
    prefix: Option<&str>,
    cidr: Option<&str>,
) -> Result<String, String> {
    let mut doc: DocumentMut = content
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Parse rules.toml: {e}"))?;

    let rules = doc
        .entry("rule")
        .or_insert(Item::ArrayOfTables(Default::default()))
        .as_array_of_tables_mut()
        .ok_or("rule is not array-of-tables")?;

    let mut rule = Table::new();
    rule.insert("action", value("allow"));
    if let Some(p) = prefix {
        rule.insert("client_random_prefix", value(p));
    }
    if let Some(c) = cidr {
        rule.insert("cidr", value(c));
    }
    // Stash username in comment prefix — preserved by toml_edit
    rule.decor_mut().set_prefix(format!("\n# User: {}\n", username));
    rules.push(rule);

    Ok(doc.to_string())
}

/// Returns true if `prefix_str` contains a line that exactly matches `# User: {username}`.
///
/// Substring match is unsafe — `"# User: alice"` is a substring of `"# User: alice_jr"` and
/// `String::contains` would return false positives across users with prefix-overlapping names
/// (CR-04 in 14.1-REVIEW.md).
fn prefix_matches_user_marker(prefix_str: &str, username: &str) -> bool {
    let marker = format!("# User: {}", username);
    prefix_str.lines().any(|line| line.trim() == marker)
}

/// Remove `[[rule]]` entries whose preceding comment contains exactly `# User: {username}`.
/// Returns new file content. If no match, returns input unchanged.
pub fn remove_user_rule(content: &str, username: &str) -> Result<String, String> {
    let mut doc: DocumentMut = content
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Parse rules.toml: {e}"))?;

    let Some(Item::ArrayOfTables(rules)) = doc.get_mut("rule") else {
        return Ok(content.to_string());
    };

    rules.retain(|rule| {
        let prefix_str = rule.decor().prefix().and_then(|r| r.as_str()).unwrap_or("");
        !prefix_matches_user_marker(prefix_str, username)
    });

    Ok(doc.to_string())
}

/// Find rule entry for `username`. Returns None if no matching comment found.
pub fn find_user_rule(content: &str, username: &str) -> Result<Option<UserRule>, String> {
    let doc: DocumentMut = content
        .parse()
        .map_err(|e: toml_edit::TomlError| format!("Parse rules.toml: {e}"))?;

    let Some(Item::ArrayOfTables(rules)) = doc.get("rule") else {
        return Ok(None);
    };

    for rule in rules.iter() {
        let prefix_str = rule.decor().prefix().and_then(|r| r.as_str()).unwrap_or("");
        if prefix_matches_user_marker(prefix_str, username) {
            let prefix = rule.get("client_random_prefix").and_then(|v| v.as_str()).map(String::from);
            let cidr = rule.get("cidr").and_then(|v| v.as_str()).map(String::from);
            return Ok(Some(UserRule { client_random_prefix: prefix, cidr }));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_to_empty_file_creates_one_rule() {
        let result = add_user_rule("", "alice", Some("aabbccdd"), None).unwrap();
        assert!(result.contains("# User: alice"));
        assert!(result.contains("client_random_prefix = \"aabbccdd\""));
        assert!(!result.contains("cidr ="));
    }

    #[test]
    fn add_with_cidr_only() {
        let result = add_user_rule("", "bob", None, Some("10.0.0.0/24")).unwrap();
        assert!(result.contains("cidr = \"10.0.0.0/24\""));
        assert!(!result.contains("client_random_prefix"));
    }

    #[test]
    fn add_with_neither_only_action() {
        let result = add_user_rule("", "carol", None, None).unwrap();
        assert!(result.contains("# User: carol"));
        assert!(result.contains("action = \"allow\""));
        assert!(!result.contains("cidr"));
        assert!(!result.contains("client_random_prefix"));
    }

    #[test]
    fn add_preserves_top_level_comments() {
        let input = "# My rules.toml header\n";
        let result = add_user_rule(input, "dave", Some("deadbeef"), None).unwrap();
        // toml_edit preserves comments — the header comment appears somewhere in the output
        // (may be attached as prefix decor to the first [[rule]] entry)
        assert!(result.contains("# My rules.toml header"));
        assert!(result.contains("# User: dave"));
    }

    #[test]
    fn add_append_to_existing() {
        let input = "[[rule]]\naction = \"allow\"\n";
        let result = add_user_rule(input, "eve", Some("cafebabe"), None).unwrap();
        assert_eq!(result.matches("[[rule]]").count(), 2);
        assert!(result.contains("# User: eve"));
    }

    #[test]
    fn remove_matching_user() {
        let input = add_user_rule("", "alice", Some("aabb"), None).unwrap();
        let result = remove_user_rule(&input, "alice").unwrap();
        assert!(!result.contains("# User: alice"));
        assert!(!result.contains("aabb"));
    }

    #[test]
    fn remove_nonexistent_user_unchanged() {
        let input = "[[rule]]\naction = \"allow\"\n";
        let result = remove_user_rule(input, "ghost").unwrap();
        assert_eq!(input, result);
    }

    #[test]
    fn remove_preserves_other_users() {
        let mut content = String::new();
        content = add_user_rule(&content, "alice", Some("aa"), None).unwrap();
        content = add_user_rule(&content, "bob", Some("bb"), None).unwrap();
        let result = remove_user_rule(&content, "alice").unwrap();
        assert!(!result.contains("alice"));
        assert!(result.contains("bob"));
        assert!(result.contains("# User: bob"));
    }

    #[test]
    fn find_existing_user() {
        let content = add_user_rule("", "alice", Some("aabb"), Some("10.0.0.0/24")).unwrap();
        let found = find_user_rule(&content, "alice").unwrap().unwrap();
        assert_eq!(found.client_random_prefix, Some("aabb".to_string()));
        assert_eq!(found.cidr, Some("10.0.0.0/24".to_string()));
    }

    #[test]
    fn find_nonexistent_user_none() {
        let content = "[[rule]]\naction = \"allow\"\n";
        let found = find_user_rule(content, "ghost").unwrap();
        assert!(found.is_none());
    }

    #[test]
    fn round_trip_add_then_remove() {
        let input = "# My rules.toml\n";
        let added = add_user_rule(input, "alice", Some("aabb"), None).unwrap();
        let removed = remove_user_rule(&added, "alice").unwrap();
        // Removed should be equivalent (trimmed trailing newlines) to input
        assert_eq!(removed.trim_end(), input.trim_end());
    }

    #[test]
    fn shell_injection_in_comment_preserved_verbatim() {
        // Username sanitization is backend's responsibility before calling this fn.
        // This test asserts we do not further process the string.
        let content = add_user_rule("", "alice\"; rm", Some("aa"), None).unwrap();
        assert!(content.contains("alice\"; rm"));
    }

    #[test]
    fn find_user_does_not_match_prefix_substring() {
        // CR-04: marker `# User: alice` must NOT match `# User: alice_jr` block.
        let mut content = add_user_rule("", "alice", Some("aa"), None).unwrap();
        content = add_user_rule(&content, "alice_jr", Some("bb"), None).unwrap();

        let alice = find_user_rule(&content, "alice").unwrap().unwrap();
        assert_eq!(alice.client_random_prefix.as_deref(), Some("aa"));

        let alice_jr = find_user_rule(&content, "alice_jr").unwrap().unwrap();
        assert_eq!(alice_jr.client_random_prefix.as_deref(), Some("bb"));
    }

    #[test]
    fn remove_user_does_not_match_prefix_substring() {
        // CR-04: removing `alice` must NOT remove `alice_jr` (data-loss bug).
        let mut content = add_user_rule("", "alice", Some("aa"), None).unwrap();
        content = add_user_rule(&content, "alice_jr", Some("bb"), None).unwrap();

        let removed = remove_user_rule(&content, "alice").unwrap();
        assert!(
            find_user_rule(&removed, "alice_jr").unwrap().is_some(),
            "alice_jr must survive removal of alice (substring overlap)"
        );
        assert!(
            find_user_rule(&removed, "alice").unwrap().is_none(),
            "alice must be removed"
        );
    }
}
