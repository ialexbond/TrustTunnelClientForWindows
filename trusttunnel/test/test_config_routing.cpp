#include <chrono>
#include <filesystem>
#include <fstream>

#include <gtest/gtest.h>

#include "vpn/trusttunnel/config.h"

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
