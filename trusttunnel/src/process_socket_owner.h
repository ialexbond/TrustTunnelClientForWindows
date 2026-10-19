#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <span>

namespace ag {

enum class ProcessSocketFamily { UNKNOWN, IPV4, IPV6 };
enum class ProcessSocketProtocol { UNKNOWN, TCP, UDP };
enum class ProcessSocketContext { TUN, SOCKS };

struct ProcessSocketAddress {
    ProcessSocketFamily family = ProcessSocketFamily::UNKNOWN;
    std::array<uint8_t, 16> address{};
    uint16_t port = 0;
    uint32_t scope = 0;
};

struct ProcessSocketOwner {
    ProcessSocketAddress local;
    ProcessSocketAddress remote;
    uint32_t pid = 0;
};

// Select exactly the table family of the captured source socket.
std::optional<ProcessSocketFamily> process_socket_table_family(
        const ProcessSocketAddress &source, ProcessSocketProtocol protocol);

// A read-only snapshot is an ownership hint, not an authorization boundary.
// Exact source matches win; a unique-owner fallback tolerates differing TUN
// source addresses. Conflicting owners and missing TUN TCP destinations stay unknown.
// For SOCKS, destination is the requested target, not the peer in the OS table;
// resolve only a unique source socket owner without comparing that target.
uint32_t select_process_socket_owner(const ProcessSocketAddress &source,
        const std::optional<ProcessSocketAddress> &destination, ProcessSocketProtocol protocol,
        std::span<const ProcessSocketOwner> rows, ProcessSocketContext context = ProcessSocketContext::TUN);

} // namespace ag
