//! Integration test: rules.toml round-trip via public server_rules API.
//!
//! Uses `trusttunnel_lib::ssh::server::*` to verify the module compiles and
//! exports are wired correctly for IPC.

use trusttunnel_lib::ssh::server::{add_user_rule, find_user_rule, remove_user_rule};

#[test]
fn full_lifecycle_add_find_remove() {
    let mut content = String::from("# trusttunnel rules.toml\n");
    content = add_user_rule(&content, "alice", Some("aabbccdd"), Some("10.0.0.0/24")).unwrap();
    let found = find_user_rule(&content, "alice").unwrap();
    assert!(found.is_some());
    let rule = found.unwrap();
    assert_eq!(rule.client_random_prefix.as_deref(), Some("aabbccdd"));
    assert_eq!(rule.cidr.as_deref(), Some("10.0.0.0/24"));

    content = remove_user_rule(&content, "alice").unwrap();
    let found_after = find_user_rule(&content, "alice").unwrap();
    assert!(found_after.is_none());
    assert!(content.contains("# trusttunnel rules.toml"));
}

#[test]
fn multiple_users_isolated() {
    let mut content = String::new();
    content = add_user_rule(&content, "alice", Some("aa"), None).unwrap();
    content = add_user_rule(&content, "bob", None, Some("192.168.1.0/24")).unwrap();
    content = add_user_rule(&content, "carol", Some("cc"), Some("10.0.0.0/8")).unwrap();

    assert!(find_user_rule(&content, "alice").unwrap().is_some());
    assert!(find_user_rule(&content, "bob").unwrap().is_some());
    assert!(find_user_rule(&content, "carol").unwrap().is_some());
    assert!(find_user_rule(&content, "ghost").unwrap().is_none());

    content = remove_user_rule(&content, "bob").unwrap();
    assert!(find_user_rule(&content, "bob").unwrap().is_none());
    assert!(find_user_rule(&content, "alice").unwrap().is_some());
    assert!(find_user_rule(&content, "carol").unwrap().is_some());
}
