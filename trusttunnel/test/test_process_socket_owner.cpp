#include <gtest/gtest.h>

#include "../src/process_socket_owner.h"

using namespace ag;

namespace {

ProcessSocketAddress address(ProcessSocketFamily family, uint8_t last, uint16_t port, uint32_t scope = 0) {
    ProcessSocketAddress result{family};
    result.port = port;
    result.scope = scope;
    if (last != 0) {
        result.address[0] = family == ProcessSocketFamily::IPV4 ? 192 : 0x20;
        result.address[1] = family == ProcessSocketFamily::IPV4 ? 0 : 0x01;
        result.address[family == ProcessSocketFamily::IPV4 ? 3 : 15] = last;
    }
    return result;
}

ProcessSocketAddress v4(uint8_t last, uint16_t port) {
    return address(ProcessSocketFamily::IPV4, last, port);
}

ProcessSocketAddress v6(uint8_t last, uint16_t port, uint32_t scope = 0) {
    return address(ProcessSocketFamily::IPV6, last, port, scope);
}

constexpr auto TCP = ProcessSocketProtocol::TCP;
constexpr auto UDP = ProcessSocketProtocol::UDP;

} // namespace

TEST(ProcessSocketOwner, SelectsIpv4TcpAndUdpTables) {
    EXPECT_EQ(process_socket_table_family(v4(1, 40000), TCP), ProcessSocketFamily::IPV4);
    EXPECT_EQ(process_socket_table_family(v4(1, 40000), UDP), ProcessSocketFamily::IPV4);
}

TEST(ProcessSocketOwner, SelectsIpv6TcpAndUdpTables) {
    EXPECT_EQ(process_socket_table_family(v6(1, 40000), TCP), ProcessSocketFamily::IPV6);
    EXPECT_EQ(process_socket_table_family(v6(1, 40000), UDP), ProcessSocketFamily::IPV6);
}

TEST(ProcessSocketOwner, RejectsUnsupportedFamilyProtocolAndMissingPort) {
    EXPECT_FALSE(process_socket_table_family({}, TCP));
    EXPECT_FALSE(process_socket_table_family(v4(1, 0), TCP));
    EXPECT_FALSE(process_socket_table_family(v6(1, 0), UDP));
    EXPECT_FALSE(process_socket_table_family(v4(1, 40000), ProcessSocketProtocol::UNKNOWN));
    EXPECT_FALSE(process_socket_table_family(address(static_cast<ProcessSocketFamily>(99), 1, 40000), TCP));
}

TEST(ProcessSocketOwner, EmptySnapshotStaysUnknown) {
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, {}), 0);
    EXPECT_EQ(select_process_socket_owner(v6(1, 40000), std::nullopt, UDP, {}), 0);
}

TEST(ProcessSocketOwner, TcpUsesRemoteAddressInsteadOfFirstLocalPortMatch) {
    ProcessSocketOwner rows[] = {{v4(1, 40000), v4(3, 443), 100}, {v4(1, 40000), v4(2, 443), 200}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, rows), 200);
}

TEST(ProcessSocketOwner, TcpUsesRemotePortInsteadOfFirstLocalPortMatch) {
    ProcessSocketOwner rows[] = {{v4(1, 40000), v4(2, 80), 100}, {v4(1, 40000), v4(2, 443), 200}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, rows), 200);
}

TEST(ProcessSocketOwner, TcpPrefersExactSourceWhenLocalPortsAreShared) {
    ProcessSocketOwner rows[] = {{v4(3, 40000), v4(2, 443), 100}, {v4(1, 40000), v4(2, 443), 200}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, rows), 200);
}

TEST(ProcessSocketOwner, TcpPreservesUniqueOwnerWhenTunSourceDiffers) {
    ProcessSocketOwner rows[] = {{v4(3, 40000), v4(2, 443), 100}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, rows), 100);
}

TEST(ProcessSocketOwner, TcpDifferingSourceFallbackMustHaveUniqueOwner) {
    ProcessSocketOwner rows[] = {{v4(3, 40000), v4(2, 443), 100}, {v4(4, 40000), v4(2, 443), 200}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, rows), 0);
}

TEST(ProcessSocketOwner, ConflictingExactTcpRowsStayUnknown) {
    ProcessSocketOwner rows[] = {{v4(1, 40000), v4(2, 443), 100}, {v4(1, 40000), v4(2, 443), 200}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, rows), 0);
}

TEST(ProcessSocketOwner, TcpWithoutNumericDestinationNeverGuessesByPort) {
    ProcessSocketOwner rows[] = {{v4(1, 40000), v4(2, 443), 100}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), std::nullopt, TCP, rows), 0);
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 0), TCP, rows), 0);
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v6(2, 443), TCP, rows), 0);
}

TEST(ProcessSocketOwner, Ipv6TcpMatchesTheCompleteTuple) {
    ProcessSocketOwner rows[] = {{v6(1, 40000), v6(3, 443), 100}, {v6(1, 40000), v6(2, 443), 200}};
    EXPECT_EQ(select_process_socket_owner(v6(1, 40000), v6(2, 443), TCP, rows), 200);
}

TEST(ProcessSocketOwner, RemoteIpv6ScopeDoesNotMatchAnotherInterface) {
    ProcessSocketOwner rows[] = {{v6(1, 40000), v6(2, 443, 4), 100}};
    EXPECT_EQ(select_process_socket_owner(v6(1, 40000), v6(2, 443, 5), TCP, rows), 0);
}

TEST(ProcessSocketOwner, NeverMatchesAnotherAddressFamilyOrLocalPort) {
    ProcessSocketOwner rows[] = {{v6(1, 40000), v6(2, 443), 100}, {v4(1, 40001), v4(2, 443), 200}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, rows), 0);
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), std::nullopt, UDP, rows), 0);
}

TEST(ProcessSocketOwner, UdpMatchesExactAddressBeforeUnrelatedBoundSocket) {
    ProcessSocketOwner rows[] = {{v4(3, 40000), {}, 100}, {v4(1, 40000), {}, 200}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), std::nullopt, UDP, rows), 200);
}

TEST(ProcessSocketOwner, UdpWildcardCanIdentifyUniqueOwner) {
    ProcessSocketOwner rows[] = {{v4(0, 40000), {}, 100}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), std::nullopt, UDP, rows), 100);
}

TEST(ProcessSocketOwner, Ipv6UdpWildcardCanIdentifyUniqueOwner) {
    ProcessSocketOwner rows[] = {{v6(0, 40000), {}, 100}};
    EXPECT_EQ(select_process_socket_owner(v6(1, 40000), std::nullopt, UDP, rows), 100);
}

TEST(ProcessSocketOwner, UdpWildcardAndExactDifferentOwnersAreAmbiguous) {
    ProcessSocketOwner rows[] = {{v4(0, 40000), {}, 100}, {v4(1, 40000), {}, 200}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), std::nullopt, UDP, rows), 0);
}

TEST(ProcessSocketOwner, SharedUdpPortNeverPicksFirstProcess) {
    ProcessSocketOwner rows[] = {{v6(0, 40000), {}, 100}, {v6(0, 40000), {}, 200}};
    EXPECT_EQ(select_process_socket_owner(v6(1, 40000), std::nullopt, UDP, rows), 0);
}

TEST(ProcessSocketOwner, DuplicateRowsForSameProcessAreNotAmbiguous) {
    ProcessSocketOwner rows[] = {{v4(0, 40000), {}, 100}, {v4(1, 40000), {}, 100}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), std::nullopt, UDP, rows), 100);
}

TEST(ProcessSocketOwner, UdpPreservesUniqueOwnerWhenTunSourceDiffers) {
    ProcessSocketOwner rows[] = {{v4(3, 40000), {}, 100}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), std::nullopt, UDP, rows), 100);
}

TEST(ProcessSocketOwner, UdpDifferingSourceFallbackMustHaveUniqueOwner) {
    ProcessSocketOwner rows[] = {{v4(3, 40000), {}, 100}, {v4(4, 40000), {}, 200}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), std::nullopt, UDP, rows), 0);
}

TEST(ProcessSocketOwner, SystemOrUnknownOwnerCannotBeIgnoredToInventUniqueOwner) {
    for (uint32_t reserved : {0, 4}) {
        ProcessSocketOwner rows[] = {{v4(0, 40000), {}, reserved}, {v4(0, 40000), {}, 100}};
        EXPECT_EQ(select_process_socket_owner(v4(1, 40000), std::nullopt, UDP, rows), 0);
    }
}

TEST(ProcessSocketOwner, EverySnapshotIsEvaluatedWithoutRememberingPreviousPid) {
    ProcessSocketOwner before[] = {{v4(1, 40000), v4(2, 443), 100}};
    ProcessSocketOwner after[] = {{v4(1, 40000), v4(2, 443), 200}};
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, before), 100);
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, {}), 0);
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, after), 200);
}

TEST(ProcessSocketOwner, SocksTcpUsesClientSocketForDomainAndNumericTarget) {
    ProcessSocketOwner rows[] = {{v4(1, 40000), v4(1, 1080), 100}};
    const auto context = ProcessSocketContext::SOCKS;
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), std::nullopt, TCP, rows, context), 100);
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, rows, context), 100);
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v6(2, 443), TCP, rows, context), 100);
    EXPECT_EQ(select_process_socket_owner(v4(3, 40000), std::nullopt, TCP, rows, context), 100);
    // The explicit SOCKS context must not loosen TUN destination matching.
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), std::nullopt, TCP, rows), 0);
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, rows), 0);
}

TEST(ProcessSocketOwner, SocksTcpSharedClientEndpointNeverChoosesFirstProcess) {
    ProcessSocketOwner rows[] = {{v4(1, 40000), v4(1, 1080), 100}, {v4(1, 40000), v4(2, 443), 200}};
    const auto context = ProcessSocketContext::SOCKS;
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), std::nullopt, TCP, rows, context), 0);
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, rows, context), 0);
    EXPECT_EQ(select_process_socket_owner(v4(3, 40000), std::nullopt, TCP, rows, context), 0);
    EXPECT_EQ(select_process_socket_owner(v4(1, 40000), v4(2, 443), TCP, rows), 200);
}
