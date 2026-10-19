#include "endpoint_probe.h"

#include <chrono>
#include <vector>

#include <nlohmann/json.hpp>

#include "common/socket_address.h"
#include "common/utils.h"

#ifdef _WIN32
#include <iphlpapi.h>
#include <netioapi.h>
#endif

namespace ag {

std::optional<size_t> select_endpoint_probe_route(std::span<const EndpointProbeRoute> routes) {
    std::optional<size_t> best;
    for (size_t i = 0; i < routes.size(); ++i) {
        const auto &candidate = routes[i];
        if (!candidate.physical || candidate.interface_index == 0) {
            continue;
        }
        if (!best || candidate.prefix_length > routes[*best].prefix_length
                || (candidate.prefix_length == routes[*best].prefix_length
                        && candidate.metric < routes[*best].metric)) {
            best = i;
        }
    }
    return best;
}

std::string EndpointProbeResult::to_json() const {
    nlohmann::json value{{"version", 1}, {"status", status}};
    if (std::string_view(status) == "ok") {
        value["ms"] = ms;
    } else {
        value["reason"] = reason;
    }
    return value.dump();
}

#ifdef _WIN32

struct PhysicalRoute {
    EndpointProbeRoute choice;
    SOCKADDR_INET source{};
};

static std::optional<PhysicalRoute> physical_route_for(const SocketAddress &target) {
    ULONG size = 0;
    constexpr ULONG FLAGS = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    if (GetAdaptersAddresses(AF_UNSPEC, FLAGS, nullptr, nullptr, &size) != ERROR_BUFFER_OVERFLOW) {
        return std::nullopt;
    }
    std::vector<uint8_t> storage(size);
    auto *adapters = reinterpret_cast<IP_ADAPTER_ADDRESSES *>(storage.data());
    if (GetAdaptersAddresses(AF_UNSPEC, FLAGS, nullptr, adapters, &size) != ERROR_SUCCESS) {
        return std::nullopt;
    }
    std::vector<PhysicalRoute> routes;
    std::vector<EndpointProbeRoute> choices;
    for (const auto *adapter = adapters; adapter; adapter = adapter->Next) {
        // The same physical adapter types accepted by the existing core egress
        // selector. In particular Wintun (53) and loopback (24) cannot win.
        if (adapter->OperStatus != IfOperStatusUp || adapter->FirstUnicastAddress == nullptr
                || (adapter->IfType != IF_TYPE_ETHERNET_CSMACD && adapter->IfType != IF_TYPE_IEEE80211
                        && adapter->IfType != 243 && adapter->IfType != 244)) {
            continue;
        }
        ULONG index = target.is_ipv4() ? adapter->IfIndex : adapter->Ipv6IfIndex;
        MIB_IPFORWARD_ROW2 row{};
        SOCKADDR_INET source{};
        if (index == 0
                || GetBestRoute2(nullptr, index, nullptr, reinterpret_cast<const SOCKADDR_INET *>(target.c_storage()),
                           0, &row, &source)
                        != ERROR_SUCCESS) {
            continue;
        }
        MIB_IPINTERFACE_ROW interface_row{};
        InitializeIpInterfaceEntry(&interface_row);
        interface_row.Family = target.c_sockaddr()->sa_family;
        interface_row.InterfaceIndex = index;
        if (GetIpInterfaceEntry(&interface_row) != ERROR_SUCCESS || !interface_row.Connected) {
            continue;
        }
        PhysicalRoute route{
                .choice = {index, row.DestinationPrefix.PrefixLength, uint64_t(row.Metric) + interface_row.Metric,
                        true},
                .source = source,
        };
        routes.push_back(route);
        choices.push_back(route.choice);
    }
    auto best = select_endpoint_probe_route(choices);
    return best ? std::optional(routes[*best]) : std::nullopt;
}

static bool bind_physical_socket(SOCKET socket, const SocketAddress &target, const PhysicalRoute &route) {
    SocketAddress source(reinterpret_cast<const sockaddr *>(&route.source));
    if (bind(socket, source.c_sockaddr(), source.c_socklen()) != 0) {
        return false;
    }
    const uint32_t index = target.is_ipv4() ? htonl(route.choice.interface_index) : route.choice.interface_index;
    const int level = target.is_ipv4() ? IPPROTO_IP : IPPROTO_IPV6;
    const int option = target.is_ipv4() ? IP_UNICAST_IF : IPV6_UNICAST_IF;
    return setsockopt(socket, level, option, reinterpret_cast<const char *>(&index), sizeof(index)) == 0;
}

#endif

EndpointProbeResult probe_endpoint_tcp(const std::string &address, uint32_t timeout_ms) {
    if (timeout_ms == 0 || timeout_ms > 10000) {
        return {};
    }
#ifdef _WIN32
    WSADATA data{};
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
        return {"no-data", 0, "socket-init-failed"};
    }
    utils::ScopeExit winsock{[] {
        WSACleanup();
    }};
    SocketAddress target(address);
    if (!target.valid() || target.port() == 0 || (!target.is_ipv4() && !target.is_ipv6())) {
        return {};
    }
    // A true local listener is useful for tests and local endpoints. It never
    // enters the public TUN path. All non-loopback targets require a physical bind.
    auto route = target.is_loopback() ? std::optional<PhysicalRoute>{} : physical_route_for(target);
    if (!target.is_loopback() && !route) {
        return {"no-data", 0, "no-physical-route"};
    }
    SOCKET fd = socket(target.c_sockaddr()->sa_family, SOCK_STREAM, IPPROTO_TCP);
    if (fd == INVALID_SOCKET) {
        return {"no-data", 0, "socket-create-failed"};
    }
    utils::ScopeExit socket_guard{[fd] {
        closesocket(fd);
    }};
    if (route && !bind_physical_socket(fd, target, *route)) {
        return {"no-data", 0, "physical-bind-failed"};
    }
    u_long nonblocking = 1;
    if (ioctlsocket(fd, FIONBIO, &nonblocking) != 0) {
        return {"no-data", 0, "socket-config-failed"};
    }
    auto start = std::chrono::steady_clock::now();
    int connected = connect(fd, target.c_sockaddr(), target.c_socklen());
    if (connected != 0) {
        const int error = WSAGetLastError();
        if (error != WSAEWOULDBLOCK && error != WSAEINPROGRESS) {
            return error == WSAEACCES ? EndpointProbeResult{"no-data", 0, "physical-egress-denied"}
                                      : EndpointProbeResult{"unreachable", 0, "connect-failed"};
        }
        fd_set writable;
        fd_set errors;
        FD_ZERO(&writable);
        FD_ZERO(&errors);
        FD_SET(fd, &writable);
        FD_SET(fd, &errors);
        timeval timeout{long(timeout_ms / 1000), long(timeout_ms % 1000) * 1000};
        if (select(0, nullptr, &writable, &errors, &timeout) <= 0) {
            return {"unreachable", 0, "connect-timeout"};
        }
        int socket_error = 0;
        int length = sizeof(socket_error);
        if (getsockopt(fd, SOL_SOCKET, SO_ERROR, reinterpret_cast<char *>(&socket_error), &length) != 0
                || socket_error != 0 || !FD_ISSET(fd, &writable)) {
            return socket_error == WSAEACCES ? EndpointProbeResult{"no-data", 0, "physical-egress-denied"}
                                             : EndpointProbeResult{"unreachable", 0, "connect-failed"};
        }
    }
    const auto elapsed =
            std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - start);
    return {"ok", uint64_t(elapsed.count()), ""};
#else
    return {"no-data", 0, "unsupported-platform"};
#endif
}

} // namespace ag
