#include <gtest/gtest.h>

#include <algorithm>
#include <optional>

#include "common/socket_address.h"
#include "net/windows_network_guard.h"

namespace ag {
namespace {

// Offline interpreter of the exact declarative plan consumed by the WFP adapter.
// No test in this file opens a WFP engine, arms protection or changes host networking.
struct Flow {
    std::string remote;
    std::string local = "192.0.2.20";
    uint64_t interface_luid = 7;
    bool core = false;
    bool inbound = false;
    uint8_t protocol = 6;
    uint16_t local_port = 43210;
    uint16_t remote_port = 443;
};

bool matches(const NetworkGuardRule &rule, const Flow &flow) {
    SocketAddress remote(flow.remote, 0);
    SocketAddress local(flow.local, 0);
    return remote.is_ipv6() == rule.ipv6 && flow.inbound == rule.inbound
            && (rule.kind != NetworkGuardRuleKind::CORE || flow.core)
            && (rule.remote_range.empty() || CidrRange(rule.remote_range).contains(remote.addr()))
            && (rule.local_address.empty() || CidrRange(rule.local_address).contains(local.addr()))
            && (!rule.interface_luid || rule.interface_luid == flow.interface_luid)
            && (!rule.protocol || rule.protocol == flow.protocol)
            && (!rule.local_port || rule.local_port == flow.local_port)
            && (!rule.remote_port || rule.remote_port == flow.remote_port);
}

bool allowed(const std::vector<NetworkGuardRule> &rules, const Flow &flow) {
    bool result = true;
    uint8_t weight = 0;
    for (const auto &rule : rules) {
        if (matches(rule, flow) && network_guard_rule_weight(rule) > weight) {
            weight = network_guard_rule_weight(rule);
            result = !network_guard_rule_blocks(rule);
        }
    }
    return result;
}

TEST(WindowsNetworkGuardTest, FullDefaultCapturesBothFamiliesInBothDirections) {
    auto plan = network_guard_base_plan();
    ASSERT_FALSE(plan.empty());
    EXPECT_EQ(4, std::count_if(plan.begin(), plan.end(), [](const auto &rule) {
        return rule.kind == NetworkGuardRuleKind::BLOCK;
    }));
    for (bool inbound : {false, true}) {
        EXPECT_FALSE(allowed(plan, {.remote = "198.51.100.1", .inbound = inbound}));
        EXPECT_FALSE(allowed(plan, {.remote = "2001:db8::1", .local = "2001:db8::20", .inbound = inbound}));
        EXPECT_FALSE(allowed(plan, {.remote = "64:ff9b::c000:201", .local = "2001:db8::20", .inbound = inbound}));
        EXPECT_FALSE(allowed(plan, {.remote = "4000::1", .local = "2001:db8::20", .inbound = inbound}));
    }
}

TEST(WindowsNetworkGuardTest, OnlyCoreIdentityCanIntentionallyRelayDirectPublicTraffic) {
    auto plan = network_guard_base_plan();
    EXPECT_TRUE(allowed(plan, {.remote = "198.51.100.1", .core = true}));
    EXPECT_TRUE(allowed(plan, {.remote = "2001:db8::1", .local = "2001:db8::20", .core = true}));
    EXPECT_FALSE(allowed(plan, {.remote = "198.51.100.1"}));
    // Endpoint IPs are never automatically added as all-application exceptions.
    EXPECT_FALSE(allowed(plan, {.remote = "198.51.100.1", .protocol = 17, .remote_port = 443}));
}

TEST(WindowsNetworkGuardTest, ExactTunnelAddressAndInterfaceAreBothRequired) {
    auto base = network_guard_base_plan();
    // get_address_for_index passes host-length CIDRs to both address assignment
    // and the guard; CidrRange normalizes subnet inputs before either call.
    auto tunnel = network_guard_tunnel_plan(99, CidrRange("10.20.30.40/32"), CidrRange("fd00::40/128"));
    ASSERT_EQ(4, tunnel.size());
    base.insert(base.end(), tunnel.begin(), tunnel.end());
    for (bool inbound : {false, true}) {
        EXPECT_TRUE(allowed(
                base, {.remote = "198.51.100.1", .local = "10.20.30.40", .interface_luid = 99, .inbound = inbound}));
        EXPECT_FALSE(allowed(
                base, {.remote = "198.51.100.1", .local = "10.20.30.40", .interface_luid = 7, .inbound = inbound}));
        EXPECT_FALSE(allowed(
                base, {.remote = "198.51.100.1", .local = "10.20.30.41", .interface_luid = 99, .inbound = inbound}));
        EXPECT_TRUE(allowed(
                base, {.remote = "2001:db8::1", .local = "fd00::40", .interface_luid = 99, .inbound = inbound}));
        EXPECT_FALSE(allowed(
                base, {.remote = "2001:db8::1", .local = "fd00::41", .interface_luid = 99, .inbound = inbound}));
    }
}

TEST(WindowsNetworkGuardTest, InvalidTunnelCannotCreateAnUnboundPermit) {
    EXPECT_TRUE(network_guard_tunnel_plan(0, CidrRange("10.20.30.40"), CidrRange("fd00::40")).empty());
    EXPECT_TRUE(network_guard_tunnel_plan(99, CidrRange(""), CidrRange("fd00::40")).empty());
    EXPECT_EQ(2, network_guard_tunnel_plan(99, CidrRange("10.20.30.40"), CidrRange("")).size());
}

TEST(WindowsNetworkGuardTest, CustomScopeAndExplicitUserExclusionsArePreserved) {
    NetworkGuardPolicy policy{{"198.51.100.0/24", "2001:db8::/32"}, {"198.51.100.10/32", "2001:db8::10/128"}};
    auto plan = network_guard_base_plan(policy);
    EXPECT_FALSE(allowed(plan, {.remote = "198.51.100.11"}));
    EXPECT_TRUE(allowed(plan, {.remote = "198.51.100.10"}));
    EXPECT_TRUE(allowed(plan, {.remote = "203.0.113.1"}));
    EXPECT_FALSE(allowed(plan, {.remote = "2001:db8::11", .local = "2001:db8::20"}));
    EXPECT_TRUE(allowed(plan, {.remote = "2001:db8::10", .local = "2001:db8::20"}));
    EXPECT_TRUE(allowed(plan, {.remote = "4000::1", .local = "2001:db8::20"}));
}

TEST(WindowsNetworkGuardTest, LocalAccessDoesNotCreatePublicDnsOrServiceExceptions) {
    auto plan = network_guard_base_plan();
    for (const char *remote : {"127.0.0.1", "192.168.1.1", "10.1.2.3", "172.17.1.1", "169.254.1.2", "224.0.0.251"}) {
        EXPECT_TRUE(allowed(plan, {.remote = remote}));
    }
    for (uint16_t port : {53, 67, 68, 443, 853}) {
        EXPECT_FALSE(allowed(plan, {.remote = "198.51.100.1", .protocol = 17, .remote_port = port}));
    }
    EXPECT_TRUE(allowed(plan, {.remote = "255.255.255.255", .protocol = 17, .local_port = 68, .remote_port = 67}));
    EXPECT_FALSE(allowed(plan, {.remote = "255.255.255.255", .protocol = 6, .local_port = 68, .remote_port = 67}));
    EXPECT_FALSE(allowed(plan, {.remote = "255.255.255.255", .protocol = 17, .local_port = 43210, .remote_port = 67}));
    EXPECT_FALSE(allowed(plan, {.remote = "224.1.2.3"}));
}

TEST(WindowsNetworkGuardTest, CoreCrashRetainsGuiSessionBaseButGuiExitRemovesAllBlockingRules) {
    auto base = network_guard_base_plan();
    auto dynamic = network_guard_tunnel_plan(99, CidrRange("10.20.30.40"), CidrRange("fd00::40"));
    EXPECT_TRUE(std::none_of(base.begin(), base.end(), [](const auto &rule) {
        return rule.persistent;
    }));
    EXPECT_TRUE(std::none_of(dynamic.begin(), dynamic.end(), [](const auto &rule) {
        return rule.persistent;
    }));
    auto live = base;
    live.insert(live.end(), dynamic.begin(), dynamic.end());
    Flow flow{.remote = "198.51.100.1", .local = "10.20.30.40", .interface_luid = 99};
    EXPECT_TRUE(allowed(live, flow));
    // Core death closes its TUN engine; the separate GUI-owned helper still owns its base.
    dynamic.clear();
    EXPECT_FALSE(allowed(base, flow));
    EXPECT_FALSE(allowed(base, {.remote = "2001:db8::1", .local = "2001:db8::20"}));
    EXPECT_TRUE(allowed(base, {.remote = "198.51.100.1", .core = true}));
    // Helper EOF/GUI job termination removes its entire dynamic base. Windows
    // restart cannot restore it: neither the base nor TUN plan has persistent rules.
    base.clear();
    EXPECT_TRUE(allowed(base, flow));
    EXPECT_TRUE(allowed(base, {.remote = "2001:db8::1", .local = "2001:db8::20"}));
}

TEST(WindowsNetworkGuardTest, CrashCannotFallBackToLanDnsButRetainsOrdinaryLanAccess) {
    NetworkGuardPolicy policy{{"0.0.0.0/0", "::/1", "8000::/1"},
            {"10.0.0.0/8", "192.168.0.0/16", "fc00::/7", "::1/128", "fe80::/10", "ff00::/8"}};
    auto base = network_guard_base_plan(policy);
    for (uint8_t protocol : {uint8_t(6), uint8_t(17)}) {
        for (uint16_t port : {uint16_t(53), uint16_t(853)}) {
            EXPECT_FALSE(allowed(base, {.remote = "192.168.1.1", .protocol = protocol, .remote_port = port}));
            EXPECT_FALSE(allowed(
                    base, {.remote = "fd00::1", .local = "fd00::20", .protocol = protocol, .remote_port = port}));
            EXPECT_TRUE(
                    allowed(base, {.remote = "192.168.1.1", .core = true, .protocol = protocol, .remote_port = port}));
        }
    }
    EXPECT_TRUE(allowed(base, {.remote = "192.168.1.1", .remote_port = 443}));
    auto tunnel = network_guard_tunnel_plan(99, CidrRange("10.20.30.40"), CidrRange("fd00::40"));
    base.insert(base.end(), tunnel.begin(), tunnel.end());
    EXPECT_TRUE(
            allowed(base, {.remote = "192.168.1.1", .local = "10.20.30.40", .interface_luid = 99, .remote_port = 53}));
    auto custom = network_guard_base_plan({{"198.51.100.0/24"}, {}});
    EXPECT_TRUE(allowed(custom, {.remote = "192.168.1.1", .protocol = 17, .remote_port = 53}));
    auto intentional = network_guard_base_plan({{"0.0.0.0/0"}, {"198.51.100.53/32"}});
    EXPECT_TRUE(allowed(intentional, {.remote = "198.51.100.53", .protocol = 17, .remote_port = 53}));
}

TEST(WindowsNetworkGuardTest, TransactionRollsBackEveryApplyFailure) {
    const auto old = network_guard_base_plan();
    const auto next = network_guard_base_plan({{"203.0.113.0/24"}, {}});
    for (size_t fail = 0; fail < next.size(); ++fail) {
        auto committed = old;
        std::vector<NetworkGuardRule> staged;
        bool aborted = false;
        EXPECT_FALSE(run_network_guard_transaction({
                .begin =
                        [] {
                            return true;
                        },
                .apply =
                        [&] {
                            for (size_t i = 0; i < next.size(); ++i) {
                                if (i == fail) {
                                    return false;
                                }
                                staged.push_back(next[i]);
                            }
                            return true;
                        },
                .commit =
                        [&] {
                            committed = staged;
                            return true;
                        },
                .abort =
                        [&] {
                            staged.clear();
                            aborted = true;
                        },
        }));
        EXPECT_TRUE(aborted);
        EXPECT_EQ(old.size(), committed.size());
        EXPECT_FALSE(allowed(committed, {.remote = "198.51.100.1"}));
    }
}

TEST(WindowsNetworkGuardTest, CommitFailureAndBeginFailurePreservePriorProtection) {
    bool applied = false;
    bool aborted = false;
    EXPECT_FALSE(run_network_guard_transaction({
            .begin =
                    [] {
                        return false;
                    },
            .apply =
                    [&] {
                        applied = true;
                        return true;
                    },
            .commit =
                    [] {
                        return true;
                    },
            .abort =
                    [&] {
                        aborted = true;
                    },
    }));
    EXPECT_FALSE(applied);
    EXPECT_FALSE(aborted);
    EXPECT_FALSE(run_network_guard_transaction({
            .begin =
                    [] {
                        return true;
                    },
            .apply =
                    [&] {
                        applied = true;
                        return true;
                    },
            .commit =
                    [] {
                        return false;
                    },
            .abort =
                    [&] {
                        aborted = true;
                    },
    }));
    EXPECT_TRUE(applied);
    EXPECT_TRUE(aborted);
}

TEST(WindowsNetworkGuardTest, SuccessfulTransactionCommitsExactlyOnce) {
    int commits = 0;
    int aborts = 0;
    EXPECT_TRUE(run_network_guard_transaction({
            .begin =
                    [] {
                        return true;
                    },
            .apply =
                    [] {
                        return true;
                    },
            .commit =
                    [&] {
                        ++commits;
                        return true;
                    },
            .abort =
                    [&] {
                        ++aborts;
                    },
    }));
    EXPECT_EQ(1, commits);
    EXPECT_EQ(0, aborts);
}

TEST(WindowsNetworkGuardTest, InvalidRoutesCannotBecomeWiderPermissions) {
    EXPECT_TRUE(network_guard_valid_policy({}));
    for (const char *route : {"example.com/24", "198.51.100.1/33", "2001:db8::1/129", "0.0.0.0/nope", "::/-1"}) {
        NetworkGuardPolicy policy{{route}, {}};
        EXPECT_FALSE(network_guard_valid_policy(policy));
        EXPECT_TRUE(network_guard_base_plan(policy).empty());
    }
    EXPECT_FALSE(network_guard_valid_policy({{}, {}}));
    EXPECT_FALSE(network_guard_valid_policy({{"0.0.0.0/0"}, {"198.51.100.1/xyz"}}));
}

TEST(WindowsNetworkGuardTest, BootstrapAcceptsOnlyOneHostAndNeverAUrlOrCommand) {
    for (const char *host : {"vpn.example.com", "xn--e1afmkfd.xn--p1ai", "198.51.100.1", "2001:db8::1"}) {
        EXPECT_TRUE(network_guard_valid_hostname(host));
    }
    for (const char *host :
            {"", "https://example.com", "example.com:443", "example.com/path", "a b", "-a.com", "a-.com", "a..com"}) {
        EXPECT_FALSE(network_guard_valid_hostname(host));
    }
    EXPECT_FALSE(network_guard_valid_hostname(std::string(254, 'a')));
}

TEST(WindowsNetworkGuardTest, UnknownStateIsReportedProtectedWithFixedError) {
    EXPECT_EQ("{\"armed\":true,\"error\":\"network-guard-unavailable\",\"version\":2}", NetworkGuardResult{}.to_json());
    EXPECT_EQ("{\"armed\":false,\"version\":2}", (NetworkGuardResult{true, false, nullptr}.to_json()));
    EXPECT_EQ("{\"addresses\":[],\"error\":\"network-guard-invalid-host\",\"version\":2}",
            (NetworkGuardResolveResult{{}, "network-guard-invalid-host"}.to_json()));
}

TEST(WindowsNetworkGuardTest, GuardedTransportRequiresBothPinsOnAPhysicalInterface) {
    EXPECT_TRUE(network_guard_socket_protection_result(true, 7, true, true, true));
    EXPECT_FALSE(network_guard_socket_protection_result(true, 0, true, true, true));
    EXPECT_FALSE(network_guard_socket_protection_result(true, 7, false, true, true));
    EXPECT_FALSE(network_guard_socket_protection_result(true, 7, true, false, true));
    EXPECT_FALSE(network_guard_socket_protection_result(true, 7, true, true, false));
    EXPECT_FALSE(network_guard_socket_protection_result(true, 7, true, false, false));
    EXPECT_TRUE(network_guard_socket_protection_result(false, 7, false, true, false));
    EXPECT_TRUE(network_guard_socket_protection_result(false, 7, false, false, true));
    EXPECT_FALSE(network_guard_socket_protection_result(false, 7, false, false, false));
}

TEST(WindowsNetworkGuardTest, SessionProtocolHasBoundedUnambiguousCommands) {
    EXPECT_EQ(NetworkGuardCommandKind::STATUS, network_guard_parse_command("S").kind);
    EXPECT_EQ(NetworkGuardCommandKind::RELEASE, network_guard_parse_command("R").kind);
    auto arm = network_guard_parse_command("A C:\\Profiles With Spaces\\profile.toml");
    EXPECT_EQ(NetworkGuardCommandKind::ARM, arm.kind);
    EXPECT_EQ("C:\\Profiles With Spaces\\profile.toml", arm.config_path);
    for (const char *line : {"", "A", "A ", "S ", "R anything", "arm path", "A file\nR", "A file\rR"}) {
        EXPECT_EQ(NetworkGuardCommandKind::INVALID, network_guard_parse_command(line).kind);
    }
    EXPECT_EQ(NetworkGuardCommandKind::INVALID, network_guard_parse_command("A " + std::string(32769, 'x')).kind);
    EXPECT_EQ(NetworkGuardCommandKind::INVALID, network_guard_parse_command(std::string("A file\0R", 8)).kind);
}

TEST(WindowsNetworkGuardTest, CoreCannotStartWithoutTheExactGuiJobHandshake) {
    EXPECT_TRUE(network_guard_valid_gui_ready("TRUSTTUNNEL_GUI_READY_V2"));
    for (const char *line :
            {"", "TRUSTTUNNEL_GUI_READY_V1", "TRUSTTUNNEL_GUI_READY_V2 ", "ready", "TRUSTTUNNEL_GUI_READY_V2\n"}) {
        EXPECT_FALSE(network_guard_valid_gui_ready(line));
    }
    EXPECT_FALSE(network_guard_valid_gui_ready(std::string(65, 'x')));
}

} // namespace
} // namespace ag
