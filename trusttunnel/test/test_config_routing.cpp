#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <ranges>

#include <gtest/gtest.h>

#include "vpn/trusttunnel/config.h"

#include "net/os_tunnel.h"

using namespace ag;

static std::filesystem::path unused_rule_path() {
    auto nonce = std::chrono::steady_clock::now().time_since_epoch().count();
    return std::filesystem::temp_directory_path() / ("trusttunnel-routing-test-" + std::to_string(nonce) + ".txt");
}

static toml::table config_with_rule_file(std::string_view key, const std::filesystem::path &path) {
    auto parsed = toml::parse(R"(
vpn_mode = "selective"
killswitch_enabled = true
[endpoint]
hostname = "vpn.example.com"
addresses = ["192.0.2.1:443"]
username = "test"
password = "test"
upstream_protocol = "http2"
[listener.socks]
address = "127.0.0.1:1080"
)");
    auto config = std::move(parsed).table();
    config.insert_or_assign(key, path.string());
    return config;
}

TEST(RoutingFileTest, MissingConfiguredFileRefusesStartup) {
    auto path = unused_rule_path();
    ASSERT_FALSE(std::filesystem::exists(path));
    for (auto key : {"exclusions_file", "process_direct_file", "process_proxy_file", "process_block_file"}) {
        EXPECT_FALSE(TrustTunnelConfig::build_config(config_with_rule_file(key, path)).has_value()) << key;
    }
}

TEST(RoutingFileTest, AnIntentionallyEmptyFileIsValid) {
    auto path = unused_rule_path();
    ASSERT_FALSE(std::filesystem::exists(path));
    {
        std::ofstream file(path);
    }
    auto result = TrustTunnelConfig::build_config(config_with_rule_file("exclusions_file", path));
    std::filesystem::remove(path);
    ASSERT_TRUE(result.has_value());
    EXPECT_TRUE(result->exclusions.empty());
}

static std::vector<CidrRange> effective_ipv6_routes(const TrustTunnelConfig::TunListener &tun) {
    std::vector<const char *> included;
    std::vector<const char *> excluded;
    for (const auto &route : tun.included_routes) {
        included.push_back(route.c_str());
    }
    for (const auto &route : tun.excluded_routes) {
        excluded.push_back(route.c_str());
    }
    VpnAddressArray included_array{.data = included.data(), .size = uint32_t(included.size())};
    VpnAddressArray excluded_array{.data = excluded.data(), .size = uint32_t(excluded.size())};
    std::vector<CidrRange> ipv4;
    std::vector<CidrRange> ipv6;
    tunnel_utils::get_setup_routes(ipv4, ipv6, included_array, excluded_array);
    return ipv6;
}

static bool contains_address(const std::vector<CidrRange> &routes, std::string_view address) {
    return std::ranges::any_of(routes, [address](const CidrRange &route) {
        return route.contains(address);
    });
}

TEST(WindowsIpv6ProtectionTest, LegacyFullTunnelCapturesPublicNat64AndFuturePrefixesInMemory) {
    TrustTunnelConfig::TunListener original;
    original.included_routes = {"0.0.0.0/0"};
    original.mtu_size = 1280;
    const auto effective = original.with_windows_ipv6_protection(true);

    EXPECT_EQ(original.included_routes, (std::vector<std::string>{"0.0.0.0/0"}));
    EXPECT_TRUE(original.excluded_routes.empty());
    EXPECT_EQ(effective.mtu_size, 1280);
    const auto routes = effective_ipv6_routes(effective);
    for (auto address : {"2001:db8::1", "64:ff9b::c000:201", "4000::1", "9000::1"}) {
        EXPECT_TRUE(contains_address(routes, address)) << address;
    }
    for (auto address : {"::1", "fe80::1", "ff02::1", "fd01::1"}) {
        EXPECT_FALSE(contains_address(routes, address)) << address;
    }
}

TEST(WindowsIpv6ProtectionTest, DisabledProtectionDoesNotExpandTheCapture) {
    TrustTunnelConfig::TunListener tun;
    tun.included_routes = {"0.0.0.0/0"};
    tun.excluded_routes = {"192.168.0.0/16"};
    const auto effective = tun.with_windows_ipv6_protection(false);

    EXPECT_EQ(effective.included_routes, tun.included_routes);
    EXPECT_EQ(effective.excluded_routes, tun.excluded_routes);
}

TEST(WindowsIpv6ProtectionTest, ExplicitIpv6ScopeAndCustomIpv4ScopesAreAuthoritative) {
    for (const std::vector<std::string> &routes : {
                 std::vector<std::string>{},
                 {"192.0.2.0/24"},
                 {"0.0.0.0/1", "128.0.0.0/1"},
                 {"0.0.0.0/0", "2001:db8::/32"},
                 {"0.0.0.0/0", "2000::/3"},
                 {"0.0.0.0/0", "::/0"},
                 {"0.0.0.0/0", "::/1", "8000::/1"},
         }) {
        TrustTunnelConfig::TunListener tun;
        tun.included_routes = routes;
        tun.excluded_routes = {"2001:db8:1::/48"};
        const auto effective = tun.with_windows_ipv6_protection(true);
        EXPECT_EQ(effective.included_routes, tun.included_routes);
        EXPECT_EQ(effective.excluded_routes, tun.excluded_routes);
    }
}

TEST(WindowsIpv6ProtectionTest, PreservesExplicitExclusionsIncludingResolvedEndpoints) {
    TrustTunnelConfig::TunListener tun;
    tun.included_routes = {"0.0.0.0/0"};
    tun.excluded_routes = {"192.0.2.0/24", "2001:db8:1::/48", "64:ff9b::c000:202/128", "fe00::/8", "fc00::/7"};
    const auto effective = tun.with_windows_ipv6_protection(true);
    EXPECT_TRUE(std::equal(tun.excluded_routes.begin(), tun.excluded_routes.end(), effective.excluded_routes.begin()));
    EXPECT_EQ(std::ranges::count(effective.excluded_routes, "fc00::/7"), 1);
    EXPECT_EQ(std::ranges::count(effective.excluded_routes, "fe80::/10"), 0);

    const auto routes = effective_ipv6_routes(effective);
    EXPECT_FALSE(contains_address(routes, "2001:db8:1::123"));
    EXPECT_FALSE(contains_address(routes, "64:ff9b::c000:202"));
    EXPECT_TRUE(contains_address(routes, "2001:db8:2::123"));
    EXPECT_TRUE(contains_address(routes, "64:ff9b::c000:203"));
}

TEST(WindowsIpv6ProtectionTest, RepeatedPreparationIsIdempotent) {
    TrustTunnelConfig::TunListener tun;
    tun.included_routes = {"0.0.0.0/0"};
    const auto once = tun.with_windows_ipv6_protection(true);
    const auto twice = once.with_windows_ipv6_protection(true);
    EXPECT_EQ(twice.included_routes, once.included_routes);
    EXPECT_EQ(twice.excluded_routes, once.excluded_routes);
}
