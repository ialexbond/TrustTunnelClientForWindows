#include <algorithm>
#include <chrono>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <ranges>

#include <gtest/gtest.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/x509v3.h>

#include "vpn/trusttunnel/config.h"

#include "net/os_tunnel.h"
#include "net/tls.h"

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

TEST(EndpointCertificateConfigTest, MalformedExplicitTrustDoesNotFallBackToSystemTrust) {
    auto config = config_with_rule_file("exclusions_file", unused_rule_path());
    config.erase("exclusions_file");
    auto *endpoint = config["endpoint"].as_table();
    ASSERT_NE(endpoint, nullptr);
    for (const auto *certificate : {"not a certificate", "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----"}) {
        endpoint->insert_or_assign("certificate", certificate);
        EXPECT_FALSE(TrustTunnelConfig::build_config(config).has_value());
    }
}

TEST(EndpointCertificateConfigTest, AbsentOrEmptyCustomTrustPreservesSystemVerification) {
    auto config = config_with_rule_file("exclusions_file", unused_rule_path());
    config.erase("exclusions_file");
    auto without_custom = TrustTunnelConfig::build_config(config);
    ASSERT_TRUE(without_custom.has_value());
    EXPECT_FALSE(without_custom->location.skip_verification);
    EXPECT_EQ(without_custom->location.ca_store, nullptr);

    config["endpoint"].as_table()->insert_or_assign("certificate", "");
    auto empty_custom = TrustTunnelConfig::build_config(config);
    ASSERT_TRUE(empty_custom.has_value());
    EXPECT_FALSE(empty_custom->location.skip_verification);
    EXPECT_EQ(empty_custom->location.ca_store, nullptr);
}

TEST(EndpointCertificateConfigTest, ValidLegacyCertificateKeepsExplicitTrust) {
    constexpr auto PEM = R"(-----BEGIN CERTIFICATE-----
MIIBJDCBy6ADAgECAgEBMAoGCCqGSM49BAMCMBsxGTAXBgNVBAMMEHZwbi5leGFt
cGxlLnRlc3QwIBcNMjAwMTAxMDAwMDAwWhgPMjA1MDAxMDEwMDAwMDBaMBsxGTAX
BgNVBAMMEHZwbi5leGFtcGxlLnRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AARVqnK6f/FdIrzbyW7OB8xq4wPd5jNziWeHZf1Pg4Y4AbUWlK223Rc5rbPCnhkr
ZvFsZ7E8wCOGynB6ANK9LFXZMAoGCCqGSM49BAMCA0gAMEUCIQCRiyJXdsZaO02Q
aXBAL2Dq6IC1VlR091I5CdjvGYOTXAIgC1VH4MfJ13IblIZJvyLHh3oYssalqk/w
pUnnfYe6cBQ=
-----END CERTIFICATE-----
)";
    auto config = config_with_rule_file("exclusions_file", unused_rule_path());
    config.erase("exclusions_file");
    config["endpoint"].as_table()->insert_or_assign("certificate", PEM);
    auto result = TrustTunnelConfig::build_config(config);
    ASSERT_TRUE(result.has_value());
    EXPECT_FALSE(result->location.skip_verification);
    EXPECT_NE(result->location.ca_store, nullptr);
    DeclPtr<BIO, &BIO_free> bio{BIO_new_mem_buf(PEM, -1)};
    ASSERT_TRUE(bio);
    DeclPtr<X509, &X509_free> certificate{PEM_read_bio_X509(bio.get(), nullptr, nullptr, nullptr)};
    ASSERT_TRUE(certificate);
    EXPECT_EQ(tls_verify_cert_detailed(certificate.get(), nullptr, result->location.ca_store.get()).error, nullptr);
    EXPECT_TRUE(tls_verify_cert_host_name(certificate.get(), "vpn.example.test"));
}

TEST(EndpointCertificateConfigTest, ExplicitVerificationOptOutIsNotSilentlyChanged) {
    auto config = config_with_rule_file("exclusions_file", unused_rule_path());
    config.erase("exclusions_file");
    auto *endpoint = config["endpoint"].as_table();
    endpoint->insert_or_assign("skip_verification", true);
    endpoint->insert_or_assign("certificate", "unused legacy value");
    auto result = TrustTunnelConfig::build_config(config);
    ASSERT_TRUE(result.has_value());
    EXPECT_TRUE(result->location.skip_verification);
}

namespace {

using EndpointTestKey = DeclPtr<EVP_PKEY, &EVP_PKEY_free>;
using EndpointTestCert = DeclPtr<X509, &X509_free>;

EndpointTestKey endpoint_test_key() {
    DeclPtr<EVP_PKEY_CTX, &EVP_PKEY_CTX_free> context{EVP_PKEY_CTX_new_id(EVP_PKEY_EC, nullptr)};
    EVP_PKEY *key = nullptr;
    if (!context || EVP_PKEY_keygen_init(context.get()) != 1
            || EVP_PKEY_CTX_set_ec_paramgen_curve_nid(context.get(), NID_X9_62_prime256v1) != 1
            || EVP_PKEY_keygen(context.get(), &key) != 1) {
        return {};
    }
    return EndpointTestKey{key};
}

bool endpoint_test_extension(X509 *certificate, int nid, const char *value) {
    DeclPtr<X509_EXTENSION, &X509_EXTENSION_free> extension{
            X509V3_EXT_nconf_nid(nullptr, nullptr, nid, const_cast<char *>(value))};
    return extension && X509_add_ext(certificate, extension.get(), -1) == 1;
}

EndpointTestCert endpoint_test_certificate(EVP_PKEY *key, const char *name, long serial, X509 *issuer,
        EVP_PKEY *issuer_key, bool ca, int from_days = -1, int until_days = 30, bool server = true) {
    EndpointTestCert certificate{X509_new()};
    DeclPtr<X509_NAME, &X509_NAME_free> subject{X509_NAME_new()};
    if (!certificate || !subject || X509_set_version(certificate.get(), 2) != 1
            || ASN1_INTEGER_set(X509_get_serialNumber(certificate.get()), serial) != 1
            || X509_NAME_add_entry_by_txt(subject.get(), "CN", MBSTRING_ASC,
                       reinterpret_cast<const unsigned char *>(name), -1, -1, 0)
                    != 1
            || X509_set_subject_name(certificate.get(), subject.get()) != 1
            || X509_set_issuer_name(certificate.get(), issuer ? X509_get_subject_name(issuer) : subject.get()) != 1
            || X509_set_pubkey(certificate.get(), key) != 1
            || !ASN1_TIME_adj(X509_getm_notBefore(certificate.get()), std::time(nullptr), from_days, 0)
            || !ASN1_TIME_adj(X509_getm_notAfter(certificate.get()), std::time(nullptr), until_days, 0)
            || !endpoint_test_extension(
                    certificate.get(), NID_basic_constraints, ca ? "critical,CA:TRUE" : "critical,CA:FALSE")
            || !endpoint_test_extension(certificate.get(), NID_key_usage,
                    ca ? "critical,keyCertSign,cRLSign" : "critical,digitalSignature")
            || (!ca
                    && (!endpoint_test_extension(certificate.get(), NID_ext_key_usage, server ? "serverAuth" : "clientAuth")
                            || !endpoint_test_extension(
                                    certificate.get(), NID_subject_alt_name, "DNS:vpn.example.test")))
            || X509_sign(certificate.get(), issuer_key ? issuer_key : key, EVP_sha256()) <= 0) {
        return {};
    }
    return certificate;
}

std::string endpoint_test_pem(X509 *certificate) {
    DeclPtr<BIO, &BIO_free> output{BIO_new(BIO_s_mem())};
    if (!output || PEM_write_bio_X509(output.get(), certificate) != 1) {
        return {};
    }
    char *data = nullptr;
    const long size = BIO_get_mem_data(output.get(), &data);
    return size > 0 ? std::string{data, static_cast<size_t>(size)} : std::string{};
}

std::optional<TrustTunnelConfig> endpoint_test_config(std::string certificate) {
    auto config = config_with_rule_file("exclusions_file", unused_rule_path());
    config.erase("exclusions_file");
    config["endpoint"].as_table()->insert_or_assign("certificate", std::move(certificate));
    return TrustTunnelConfig::build_config(config);
}

class EndpointPartialChainTest : public ::testing::Test {
protected:
    void SetUp() override {
        root_key = endpoint_test_key();
        intermediate_key = endpoint_test_key();
        leaf_key = endpoint_test_key();
        ASSERT_TRUE(root_key && intermediate_key && leaf_key);
        root = endpoint_test_certificate(root_key.get(), "Endpoint test root", 101, nullptr, nullptr, true);
        ASSERT_TRUE(root);
        intermediate = endpoint_test_certificate(intermediate_key.get(), "Endpoint test intermediate", 102,
                root.get(), root_key.get(), true);
        ASSERT_TRUE(intermediate);
        leaf = endpoint_test_certificate(leaf_key.get(), "vpn.example.test", 103, intermediate.get(),
                intermediate_key.get(), false);
        ASSERT_TRUE(leaf);
    }

    EndpointTestKey root_key;
    EndpointTestKey intermediate_key;
    EndpointTestKey leaf_key;
    EndpointTestCert root;
    EndpointTestCert intermediate;
    EndpointTestCert leaf;
};

} // namespace

TEST_F(EndpointPartialChainTest, IntermediateAnchorAcceptsLeafWithoutRoot) {
    auto config = endpoint_test_config(endpoint_test_pem(intermediate.get()));
    ASSERT_TRUE(config);
    ASSERT_TRUE(config->location.ca_store);
    EXPECT_FALSE(config->location.skip_verification);
    auto result = tls_verify_cert_detailed(leaf.get(), nullptr, config->location.ca_store.get());
    EXPECT_EQ(result.error, nullptr);
    EXPECT_TRUE(tls_verify_cert_host_name(leaf.get(), "vpn.example.test"));
}

TEST_F(EndpointPartialChainTest, LeafAndIntermediateBundleAcceptsRootOmitted) {
    auto config = endpoint_test_config(endpoint_test_pem(leaf.get()) + endpoint_test_pem(intermediate.get()));
    ASSERT_TRUE(config);
    ASSERT_TRUE(config->location.ca_store);
    EXPECT_EQ(tls_verify_cert_detailed(leaf.get(), nullptr, config->location.ca_store.get()).error, nullptr);
}

TEST_F(EndpointPartialChainTest, ExactLeafAnchorAcceptsNoIssuerChain) {
    auto config = endpoint_test_config(endpoint_test_pem(leaf.get()));
    ASSERT_TRUE(config);
    ASSERT_TRUE(config->location.ca_store);
    EXPECT_EQ(tls_verify_cert_detailed(leaf.get(), nullptr, config->location.ca_store.get()).error, nullptr);
}

TEST_F(EndpointPartialChainTest, ForeignChainIsRejectedByCustomAnchors) {
    auto foreign_key = endpoint_test_key();
    ASSERT_TRUE(foreign_key);
    auto foreign_root = endpoint_test_certificate(foreign_key.get(), "Foreign test root", 201, nullptr, nullptr, true);
    ASSERT_TRUE(foreign_root);
    auto foreign_leaf = endpoint_test_certificate(
            leaf_key.get(), "vpn.example.test", 202, foreign_root.get(), foreign_key.get(), false);
    ASSERT_TRUE(foreign_leaf);
    auto config = endpoint_test_config(endpoint_test_pem(intermediate.get()));
    ASSERT_TRUE(config);
    ASSERT_TRUE(config->location.ca_store);
    // A server-supplied root belongs to the untrusted chain, never the anchor store.
    DeclPtr<STACK_OF(X509), &sk_X509_free> chain{sk_X509_new_null()};
    ASSERT_TRUE(chain);
    ASSERT_NE(sk_X509_push(chain.get(), foreign_root.get()), 0);
    auto result = tls_verify_cert_detailed(foreign_leaf.get(), chain.get(), config->location.ca_store.get());
    EXPECT_NE(result.error, nullptr);
    EXPECT_FALSE(result.not_yet_valid);
}

TEST_F(EndpointPartialChainTest, InvalidSignatureOnUntrustedLeafIsRejected) {
    // The issuer name matches the authenticated intermediate, but the signature
    // uses the unrelated root key. The leaf itself is deliberately not trusted.
    auto invalid = endpoint_test_certificate(
            leaf_key.get(), "vpn.example.test", 203, intermediate.get(), root_key.get(), false);
    ASSERT_TRUE(invalid);
    auto config = endpoint_test_config(endpoint_test_pem(intermediate.get()));
    ASSERT_TRUE(config);
    ASSERT_TRUE(config->location.ca_store);
    auto result = tls_verify_cert_detailed(invalid.get(), nullptr, config->location.ca_store.get());
    EXPECT_NE(result.error, nullptr);
    EXPECT_FALSE(result.not_yet_valid);
}

TEST_F(EndpointPartialChainTest, ExpiredLeafIsRejectedEvenWhenExplicitAnchor) {
    auto expired = endpoint_test_certificate(leaf_key.get(), "vpn.example.test", 301, intermediate.get(),
            intermediate_key.get(), false, -30, -1);
    ASSERT_TRUE(expired);
    for (auto pem : {endpoint_test_pem(expired.get()), endpoint_test_pem(intermediate.get())}) {
        auto config = endpoint_test_config(std::move(pem));
        ASSERT_TRUE(config);
        ASSERT_TRUE(config->location.ca_store);
        auto result = tls_verify_cert_detailed(expired.get(), nullptr, config->location.ca_store.get());
        EXPECT_NE(result.error, nullptr);
        EXPECT_FALSE(result.not_yet_valid);
    }
}

TEST_F(EndpointPartialChainTest, FutureLeafIsStillRejectedWithSpecificCause) {
    auto future = endpoint_test_certificate(leaf_key.get(), "vpn.example.test", 302, intermediate.get(),
            intermediate_key.get(), false, 1, 30);
    ASSERT_TRUE(future);
    auto config = endpoint_test_config(endpoint_test_pem(future.get()));
    ASSERT_TRUE(config);
    ASSERT_TRUE(config->location.ca_store);
    auto result = tls_verify_cert_detailed(future.get(), nullptr, config->location.ca_store.get());
    EXPECT_NE(result.error, nullptr);
    EXPECT_TRUE(result.not_yet_valid);
}

TEST_F(EndpointPartialChainTest, WrongHostnameIsRejectedAfterCustomChainSucceeds) {
    auto config = endpoint_test_config(endpoint_test_pem(intermediate.get()));
    ASSERT_TRUE(config);
    ASSERT_TRUE(config->location.ca_store);
    EXPECT_EQ(tls_verify_cert_detailed(leaf.get(), nullptr, config->location.ca_store.get()).error, nullptr);
    // Production checks identity separately in core/src/vpn_manager.cpp; no VPN
    // runtime or Windows certificate store is created by this test.
    EXPECT_FALSE(tls_verify_cert_host_name(leaf.get(), "other.example.test"));
    EXPECT_TRUE(tls_verify_cert_host_name(leaf.get(), "vpn.example.test"));
}

TEST_F(EndpointPartialChainTest, WrongPurposeLeafIsRejectedAsAnchorOrThroughIntermediate) {
    auto client_only = endpoint_test_certificate(leaf_key.get(), "vpn.example.test", 303, intermediate.get(),
            intermediate_key.get(), false, -1, 30, false);
    ASSERT_TRUE(client_only);
    EXPECT_FALSE(endpoint_test_config(endpoint_test_pem(client_only.get())).has_value());
    auto config = endpoint_test_config(endpoint_test_pem(intermediate.get()));
    ASSERT_TRUE(config);
    ASSERT_TRUE(config->location.ca_store);
    EXPECT_NE(tls_verify_cert_detailed(client_only.get(), nullptr, config->location.ca_store.get()).error, nullptr);
}

TEST_F(EndpointPartialChainTest, ExpiredIntermediateAnchorIsStillRejected) {
    auto expired_intermediate = endpoint_test_certificate(intermediate_key.get(), "Expired test intermediate", 304,
            root.get(), root_key.get(), true, -30, -1);
    ASSERT_TRUE(expired_intermediate);
    auto valid_leaf = endpoint_test_certificate(leaf_key.get(), "vpn.example.test", 305,
            expired_intermediate.get(), intermediate_key.get(), false);
    ASSERT_TRUE(valid_leaf);
    auto config = endpoint_test_config(endpoint_test_pem(expired_intermediate.get()));
    ASSERT_TRUE(config);
    ASSERT_TRUE(config->location.ca_store);
    auto result = tls_verify_cert_detailed(valid_leaf.get(), nullptr, config->location.ca_store.get());
    EXPECT_NE(result.error, nullptr);
    EXPECT_FALSE(result.not_yet_valid);
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
