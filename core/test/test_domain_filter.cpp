#include <filesystem>
#include <fstream>
#include <gtest/gtest.h>
#include <sstream>

#include "vpn/internal/domain_filter.h"
#include "vpn/utils.h"

using namespace ag;

TEST(DefaultOverrideTest, DomainWinsOverBroadDomainExclusion) {
    DomainFilter filter;
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, "*.example.com !vpn.example.com"));
    EXPECT_NE(filter.match_domain("vpn.example.com"), DFMS_EXCLUSION);
    EXPECT_EQ(filter.match_domain("direct.example.com"), DFMS_EXCLUSION);
}

TEST(DefaultOverrideTest, KnownDomainWinsOverGeoipExclusion) {
    DomainFilter filter;
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, "192.0.2.0/24 !vpn.example.com"));
    SockAddrTag tag{SocketAddress("192.0.2.53:443"), "browser.exe"};
    filter.add_resolved_tag(tag, "vpn.example.com");
    EXPECT_NE(filter.match_tag(tag).status, DFMS_EXCLUSION);
}

TEST(DefaultOverrideTest, AddressWinsOverBroaderCidr) {
    DomainFilter filter;
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, "192.0.2.0/24 !192.0.2.53"));
    EXPECT_NE(filter.match_tag({SocketAddress("192.0.2.53:443"), ""}).status, DFMS_EXCLUSION);
    EXPECT_EQ(filter.match_tag({SocketAddress("192.0.2.54:443"), ""}).status, DFMS_EXCLUSION);
}

TEST(DefaultOverrideTest, WildcardAndApexAreIndependent) {
    DomainFilter filter;
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, "*.example.com !*.vpn.example.com"));
    EXPECT_NE(filter.match_domain("child.vpn.example.com"), DFMS_EXCLUSION);
    EXPECT_EQ(filter.match_domain("vpn.example.com"), DFMS_EXCLUSION);
}

TEST(DefaultOverrideTest, UpdatingRulesRemovesPreviousOverride) {
    DomainFilter filter;
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, "example.com !example.com"));
    EXPECT_NE(filter.match_domain("example.com"), DFMS_EXCLUSION);
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, "example.com"));
    EXPECT_EQ(filter.match_domain("example.com"), DFMS_EXCLUSION);
}

TEST(DefaultOverrideTest, UnknownNameDefersCountryBypassUntilInspection) {
    DomainFilter filter;
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, "192.0.2.0/24 !vpn.example.com"));
    SockAddrTag tag{SocketAddress("192.0.2.53:443"), "browser.exe"};
    EXPECT_EQ(filter.match_tag(tag).status, DFMS_SUSPECT_EXCLUSION);
    filter.add_resolved_tag(tag, "unlisted.example.com");
    EXPECT_EQ(filter.match_tag(tag).status, DFMS_EXCLUSION);
}

TEST(DefaultOverrideTest, DnsPolicyAndSelectiveModeUseTheDefaultOverride) {
    DomainFilter filter;
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_SELECTIVE, "*.example.com !direct.example.com"));
    EXPECT_EQ(filter.match_domain("direct.example.com"), DFMS_DEFAULT_OVERRIDE);
    EXPECT_EQ(filter.match_domain("vpn.example.com"), DFMS_EXCLUSION);
}

TEST(DefaultOverrideTest, RepeatedNegationIsMalformedAndCannotRecurse) {
    EXPECT_EQ(DomainFilter::validate_entry("!!example.com"), DFVS_MALFORMED);
    DomainFilter filter;
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, "example.com !!example.com"));
    EXPECT_EQ(filter.match_domain("example.com"), DFMS_EXCLUSION);
}

TEST(DefaultOverrideTest, DnsNamesIgnoreAsciiCase) {
    DomainFilter filter;
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, "EXAMPLE.COM !VPN.EXAMPLE.COM !WWW.OTHER.EXAMPLE.ORG"));
    EXPECT_EQ(filter.match_domain("Example.Com"), DFMS_EXCLUSION);
    EXPECT_EQ(filter.match_domain("vpn.example.com"), DFMS_DEFAULT_OVERRIDE);
    EXPECT_EQ(filter.match_domain("other.example.org"), DFMS_DEFAULT_OVERRIDE);
}

TEST(DefaultOverrideTest, RustCompilerFixtureRoutesBothExceptionsAndOrdinaryTraffic) {
    auto path = std::filesystem::path(__FILE__).parent_path() / "fixtures" / "routing_default_overrides.txt";
    std::ifstream file(path);
    ASSERT_TRUE(file.is_open());
    std::stringstream content;
    content << file.rdbuf();
    DomainFilter filter;
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, content.str()));
    SockAddrTag vpn{SocketAddress("192.0.2.53:443"), "browser.exe"};
    SockAddrTag direct{SocketAddress("192.0.2.54:443"), "browser.exe"};
    filter.add_resolved_tag(vpn, "child.vpn.example.com");
    filter.add_resolved_tag(direct, "ordinary.example.com");
    EXPECT_EQ(filter.match_tag(vpn).status, DFMS_DEFAULT_OVERRIDE);
    EXPECT_EQ(filter.match_tag(direct).status, DFMS_EXCLUSION);
    EXPECT_EQ(filter.match_tag({SocketAddress("198.51.100.1:443"), "browser.exe"}).status, DFMS_DEFAULT);
    EXPECT_EQ(filter.match_domain("direct.example.com"), DFMS_EXCLUSION);
}

TEST(DefaultOverrideTest, ExplicitDirectBeatsVpnGroupAndNarrowerUserDomainWins) {
    DomainFilter filter;
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL,
            "*.example.com !*.example.com +direct.example.com ^*.private.example.com +public.private.example.com"));
    EXPECT_EQ(filter.match_domain("direct.example.com"), DFMS_EXCLUSION);
    EXPECT_EQ(filter.match_domain("child.private.example.com"), DFMS_DEFAULT_OVERRIDE);
    EXPECT_EQ(filter.match_domain("public.private.example.com"), DFMS_EXCLUSION);
}

TEST(DefaultOverrideTest, ExplicitDomainBeatsGroupIpInBothDirections) {
    DomainFilter filter;
    SockAddrTag tag{SocketAddress("192.0.2.53:443"), "browser.exe"};
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, "!192.0.2.0/24 +direct.example.com"));
    filter.add_resolved_tag(tag, "direct.example.com");
    EXPECT_EQ(filter.match_tag(tag).status, DFMS_EXCLUSION);
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, "+192.0.2.0/24 ^vpn.example.com"));
    filter.add_resolved_tag(tag, "vpn.example.com");
    EXPECT_EQ(filter.match_tag(tag).status, DFMS_DEFAULT_OVERRIDE);
}

TEST(DefaultOverrideTest, ExplicitDirectAddressBeatsVpnGroupsWithoutAName) {
    DomainFilter filter;
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, "+192.0.2.53 !*.example.com"));
    EXPECT_EQ(filter.match_tag({SocketAddress("192.0.2.53:443"), "browser.exe"}).status, DFMS_EXCLUSION);
}

TEST(DefaultOverrideTest, GeositeTldFixtureCoversTheEntireAsciiAndIdnZones) {
    auto path = std::filesystem::path(__FILE__).parent_path() / "fixtures" / "geosite_tld_suffixes.txt";
    std::ifstream file(path);
    ASSERT_TRUE(file.is_open());
    std::stringstream content;
    content << file.rdbuf();
    DomainFilter filter;
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, content.str()));
    EXPECT_EQ(filter.match_domain("example.ru"), DFMS_EXCLUSION);
    EXPECT_EQ(filter.match_domain("xn--e1afmkfd.xn--p1ai"), DFMS_EXCLUSION);
    EXPECT_EQ(filter.match_domain("example.com"), DFMS_DEFAULT);
}

// Settings update should purge previous entries
TEST(MatchTest, UpdateSettings) {
    DomainFilter filter = {};
    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, "example.com"));
    ASSERT_EQ(filter.match_domain("example.com"), DFMS_EXCLUSION);

    ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, ""));
    ASSERT_EQ(filter.match_domain("example.com"), DFMS_DEFAULT);
}

struct MatchTestParam {
    VpnMode mode;
    std::string_view exclusions;
    std::string entry;
};

class MatchTest : public testing::TestWithParam<MatchTestParam> {
public:
    DomainFilter filter = {};

    static void SetUpTestSuite() {
        ag::Logger::set_log_level(ag::LOG_LEVEL_TRACE);
    }

    void SetUp() override {
        const MatchTestParam &param = GetParam();
        ASSERT_TRUE(filter.update_exclusions(param.mode, param.exclusions));
    }
};

class DomainMatch : public MatchTest {};
TEST_P(DomainMatch, Test) {
    const MatchTestParam &param = GetParam();
    ASSERT_EQ(DFMS_EXCLUSION, filter.match_domain(param.entry));
}

static const MatchTestParam DOMAIN_MATCH_TEST_SAMPLES[] = {
        {VPN_MODE_GENERAL, "example.com", "example.com"},
        {VPN_MODE_GENERAL, "example.com    example.org", "example.com"},
        {VPN_MODE_GENERAL, "example.com example.org", "example.org"},

        {VPN_MODE_GENERAL, "example.com", "www.example.com"},
        {VPN_MODE_GENERAL, "www.example.com", "example.com"},

        {VPN_MODE_GENERAL, "*.example.com", "sub.example.com"},
        {VPN_MODE_GENERAL, "*.example.com", "www.example.com"},

        {VPN_MODE_GENERAL, "example.com *.example.com", "sub.example.com"},
        {VPN_MODE_GENERAL, "*.example.com example.com", "example.com"},
        {VPN_MODE_GENERAL, "*.example.com", "*.example.com"},
};
INSTANTIATE_TEST_SUITE_P(Simple, DomainMatch, testing::ValuesIn(DOMAIN_MATCH_TEST_SAMPLES));

class DomainNoMatch : public MatchTest {};
TEST_P(DomainNoMatch, Test) {
    const MatchTestParam &param = GetParam();
    ASSERT_EQ(DFMS_DEFAULT, filter.match_domain(param.entry));
}

static const MatchTestParam DOMAIN_NOMATCH_TEST_SAMPLES[] = {
        {VPN_MODE_GENERAL, "example.com", "example.org"},
        {VPN_MODE_GENERAL, "example.com example.org", "example.net"},

        {VPN_MODE_GENERAL, "sub.example.com", "example.com"},
        {VPN_MODE_GENERAL, "example.com", "sub.sub.example.com"},
        {VPN_MODE_GENERAL, "example.com", "www.example.org"},
        {VPN_MODE_GENERAL, "example.com", "sub.example.org"},
        {VPN_MODE_GENERAL, "example.com", "example.com."},
        {VPN_MODE_GENERAL, "example.com", "*.example.com"},
};
INSTANTIATE_TEST_SUITE_P(Simple, DomainNoMatch, testing::ValuesIn(DOMAIN_NOMATCH_TEST_SAMPLES));

class AddressMatch : public MatchTest {};
TEST_P(AddressMatch, Test) {
    const MatchTestParam &param = GetParam();

    SocketAddress address(param.entry.c_str());
    ASSERT_TRUE(address.valid());
    ASSERT_EQ(DFMS_EXCLUSION, filter.match_tag({address, ""}).status);
}

static const MatchTestParam ADDRESS_MATCH_TEST_SAMPLES[] = {
        {VPN_MODE_GENERAL, "1.1.1.1 2.2.2.2", "1.1.1.1"},
        {VPN_MODE_GENERAL, "1.1.1.1 2.2.2.2", "2.2.2.2"},
        {VPN_MODE_GENERAL, "dead::beef \t feed::babe", "dead::beef"},
        {VPN_MODE_GENERAL, "dead::beef feed::babe", "feed::babe"},
        {VPN_MODE_SELECTIVE, "1.1.1.1 2.2.2.2", "1.1.1.1"},
        {VPN_MODE_SELECTIVE, "dead::beef feed::babe", "feed::babe"},

        {VPN_MODE_GENERAL, "[dead::beef]", "[dead::beef]:1234"},
        {VPN_MODE_GENERAL, "dead::beef", "[dead::beef]:70"},
        {VPN_MODE_GENERAL, "1.1.1.1", "1.1.1.1:30"},
        {VPN_MODE_GENERAL, "1.1.1.1", "1.1.1.1:60"},

        {VPN_MODE_GENERAL, "192.168.0.0/16", "192.168.0.1"},
        {VPN_MODE_GENERAL, "192.168.0.0/16", "192.168.0.1:30"},
        {VPN_MODE_GENERAL, "2000::/64", "2000::1"},
        {VPN_MODE_GENERAL, "2000::/64", "[2000::1]"},
        {VPN_MODE_GENERAL, "2000::/64", "[2000::1]:123"},

        {VPN_MODE_GENERAL, "*:8080", "1.2.3.4:8080"},
        {VPN_MODE_GENERAL, "*:8080", "[dead::beef]:8080"},
        {VPN_MODE_GENERAL, "*:443 *:80", "5.6.7.8:443"},
};
INSTANTIATE_TEST_SUITE_P(Simple, AddressMatch, testing::ValuesIn(ADDRESS_MATCH_TEST_SAMPLES));

class AddressNoMatch : public MatchTest {};
TEST_P(AddressNoMatch, Test) {
    const MatchTestParam &param = GetParam();

    SocketAddress address(param.entry.c_str());
    ASSERT_TRUE(address.valid());
    ASSERT_EQ(filter.match_tag({address, ""}).status, DFMS_DEFAULT);
}

static const MatchTestParam ADDRESS_NOMATCH_TEST_SAMPLES[] = {
        {VPN_MODE_GENERAL, "1.1.1.1 2.2.2.2", "3.3.3.3"},
        {VPN_MODE_GENERAL, "dead::beef feed::babe", "beef::babe"},
        {VPN_MODE_SELECTIVE, "1.1.1.1 2.2.2.2", "3.3.3.3"},
        {VPN_MODE_SELECTIVE, "dead::beef feed::babe", "babe::beef"},

        {VPN_MODE_GENERAL, "1.1.1.1:1", "1.1.1.1:2"},
        {VPN_MODE_GENERAL, "[dead::beef]:1", "[dead::beef]:2"},

        {VPN_MODE_GENERAL, "192.168.0.0/16", "172.168.0.0"},
        {VPN_MODE_GENERAL, "192.168.0.0/16", "172.168.0.0:1122"},
        {VPN_MODE_GENERAL, "2000::/64", "2001::1"},
        {VPN_MODE_GENERAL, "2000::/64", "[2001::1]"},
        {VPN_MODE_GENERAL, "2000::/64", "[2001::1]:4433"},

        {VPN_MODE_GENERAL, "*:8080", "1.2.3.4:9090"},
        {VPN_MODE_GENERAL, "*:8080", "[dead::beef]:443"},
};
INSTANTIATE_TEST_SUITE_P(Simple, AddressNoMatch, testing::ValuesIn(ADDRESS_NOMATCH_TEST_SAMPLES));

struct TagsTestParam {
    std::string address;
    std::string app;
};

class Tags : public testing::TestWithParam<TagsTestParam> {
public:
    DomainFilter filter = {};
    SocketAddress address = {};

    static void SetUpTestSuite() {
        ag::Logger::set_log_level(ag::LOG_LEVEL_TRACE);
    }

    void SetUp() override {
        const TagsTestParam &param = GetParam();

        address = SocketAddress(param.address.c_str());
        ASSERT_TRUE(address.valid());

        ASSERT_TRUE(filter.update_exclusions(VPN_MODE_GENERAL, "example.com"));
    }
};

TEST_P(Tags, Basic) {
    const TagsTestParam &param = GetParam();

    ASSERT_EQ(filter.match_tag({address, param.app}).status, DFMS_DEFAULT);

    filter.add_resolved_tag({address, param.app}, "example.com");
    auto res = filter.match_tag({address, param.app});
    ASSERT_EQ(res.status, DFMS_EXCLUSION);
    ASSERT_EQ(res.domain, "example.com");
    res = filter.match_tag({address, ""});
    ASSERT_EQ(res.status, DFMS_DEFAULT);
    ASSERT_FALSE(res.domain.has_value());
    res = filter.match_tag({address, param.app + "1"});
    ASSERT_EQ(res.status, DFMS_DEFAULT);
    ASSERT_FALSE(res.domain.has_value());
}

static const TagsTestParam TAGS_TEST_SAMPLES[] = {
        {"1.1.1.1:1", "test"},
        {"[abcd::feed]:13", "test"},
};
INSTANTIATE_TEST_SUITE_P(Tags, Tags, testing::ValuesIn(TAGS_TEST_SAMPLES));

TEST(DomainFilterTest, ValidateEntry) {
    ASSERT_EQ(DFVS_OK_DOMAIN, DomainFilter::validate_entry("google.com"));
    ASSERT_EQ(DFVS_OK_DOMAIN, DomainFilter::validate_entry("google123.com"));
    ASSERT_EQ(DFVS_OK_DOMAIN, DomainFilter::validate_entry("gOOgle.com"));
    ASSERT_EQ(DFVS_OK_ADDR, DomainFilter::validate_entry("1.1.1.1:1"));
    ASSERT_EQ(DFVS_OK_ADDR, DomainFilter::validate_entry("1.2.3.4"));
    ASSERT_EQ(DFVS_OK_DOMAIN, DomainFilter::validate_entry("1.2.3.257"));
    ASSERT_EQ(DFVS_OK_DOMAIN, DomainFilter::validate_entry("1.2.3.4.5"));
    ASSERT_EQ(DFVS_OK_CIDR, DomainFilter::validate_entry("1.2.3.0/24"));
    ASSERT_EQ(DFVS_OK_ADDR, DomainFilter::validate_entry("[fd::]:80"));
    ASSERT_EQ(DFVS_OK_ADDR, DomainFilter::validate_entry("[fd::]"));
    ASSERT_EQ(DFVS_OK_ADDR, DomainFilter::validate_entry("fd::"));
    ASSERT_EQ(DFVS_OK_CIDR, DomainFilter::validate_entry("fd::/64"));
    ASSERT_EQ(DFVS_OK_DOMAIN, DomainFilter::validate_entry("*.google"));

    ASSERT_EQ(DFVS_MALFORMED, DomainFilter::validate_entry("1.1.1.1:0"));
    ASSERT_EQ(DFVS_MALFORMED, DomainFilter::validate_entry("1.2.3.0/33"));
    ASSERT_EQ(DFVS_MALFORMED, DomainFilter::validate_entry("google.*"));
    ASSERT_EQ(DFVS_MALFORMED, DomainFilter::validate_entry("*.google.*"));
    ASSERT_EQ(DFVS_MALFORMED, DomainFilter::validate_entry("1.2.3.4:65536"));
    ASSERT_EQ(DFVS_MALFORMED, DomainFilter::validate_entry("goo\"gle.com"));
    ASSERT_EQ(DFVS_MALFORMED, DomainFilter::validate_entry(" "));
    ASSERT_EQ(DFVS_MALFORMED, DomainFilter::validate_entry(""));
    ASSERT_EQ(DFVS_MALFORMED, DomainFilter::validate_entry(" example.org"));
    ASSERT_EQ(DFVS_MALFORMED, DomainFilter::validate_entry("."));
    ASSERT_EQ(DFVS_MALFORMED, DomainFilter::validate_entry(".."));
    ASSERT_EQ(DFVS_MALFORMED, DomainFilter::validate_entry("*:0"));
    ASSERT_EQ(DFVS_MALFORMED, DomainFilter::validate_entry("*:65536"));
    ASSERT_EQ(DFVS_MALFORMED, DomainFilter::validate_entry("*:abc"));

    ASSERT_EQ(DFVS_OK_PORT, DomainFilter::validate_entry("*:80"));
    ASSERT_EQ(DFVS_OK_PORT, DomainFilter::validate_entry("*:443"));
    ASSERT_EQ(DFVS_OK_PORT, DomainFilter::validate_entry("*:65535"));
}
