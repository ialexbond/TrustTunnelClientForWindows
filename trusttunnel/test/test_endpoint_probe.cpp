#include <gtest/gtest.h>

#include "../src/endpoint_probe.h"
#include "vpn/platform.h"

using namespace ag;

TEST(EndpointProbe, TunnelRouteCannotWinEvenWhenItsMetricIsLower) {
    const EndpointProbeRoute routes[] = {{20, 32, 0, false}, {21, 0, 50, true}};
    EXPECT_EQ(select_endpoint_probe_route(routes), 1);
}

TEST(EndpointProbe, PhysicalRouteUsesLongestPrefixThenCombinedMetric) {
    const EndpointProbeRoute routes[] = {{21, 0, 1, true}, {22, 24, 70, true}, {23, 24, 45, true}};
    EXPECT_EQ(select_endpoint_probe_route(routes), 2);
}

TEST(EndpointProbe, MissingPhysicalRouteNeverFallsBackToTunnel) {
    const EndpointProbeRoute routes[] = {{20, 32, 0, false}, {0, 0, 0, true}};
    EXPECT_FALSE(select_endpoint_probe_route(routes));
}

TEST(EndpointProbe, InvalidInputCannotStartAProbe) {
    EXPECT_STREQ(probe_endpoint_tcp("vpn.example.test:443", 100).status, "no-data");
    EXPECT_STREQ(probe_endpoint_tcp("127.0.0.1:0", 100).status, "no-data");
    EXPECT_STREQ(probe_endpoint_tcp("127.0.0.1:443", 0).status, "no-data");
    EXPECT_STREQ(probe_endpoint_tcp("127.0.0.1:443", 10001).status, "no-data");
}

TEST(EndpointProbe, OutputContainsOnlyVersionAndMeasurement) {
    EXPECT_EQ((EndpointProbeResult{"ok", 67, ""}).to_json(), R"({"ms":67,"status":"ok","version":1})");
    auto failure = EndpointProbeResult{"no-data", 0, "physical-bind-failed"}.to_json();
    EXPECT_EQ(failure, R"({"reason":"physical-bind-failed","status":"no-data","version":1})");
}

#ifdef _WIN32
TEST(EndpointProbe, RealLocalListenerIsReachableWithoutTunnelSetup) {
    WSADATA data{};
    ASSERT_EQ(WSAStartup(MAKEWORD(2, 2), &data), 0);
    SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    ASSERT_NE(listener, INVALID_SOCKET);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    ASSERT_EQ(bind(listener, reinterpret_cast<sockaddr *>(&address), sizeof(address)), 0);
    ASSERT_EQ(listen(listener, 1), 0);
    int size = sizeof(address);
    ASSERT_EQ(getsockname(listener, reinterpret_cast<sockaddr *>(&address), &size), 0);
    auto result = probe_endpoint_tcp("127.0.0.1:" + std::to_string(ntohs(address.sin_port)), 500);
    closesocket(listener);
    WSACleanup();
    EXPECT_STREQ(result.status, "ok");
    EXPECT_LT(result.ms, 500);
}
#endif
