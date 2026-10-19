#include "process_socket_owner.h"

#include <algorithm>

namespace ag {

std::optional<ProcessSocketFamily> process_socket_table_family(
        const ProcessSocketAddress &source, ProcessSocketProtocol protocol) {
    if (source.port == 0 || (source.family != ProcessSocketFamily::IPV4 && source.family != ProcessSocketFamily::IPV6)
            || (protocol != ProcessSocketProtocol::TCP && protocol != ProcessSocketProtocol::UDP)) {
        return std::nullopt;
    }
    return source.family;
}

static bool same_address(const ProcessSocketAddress &a, const ProcessSocketAddress &b) {
    return a.family == b.family && a.address == b.address && a.scope == b.scope;
}

static bool wildcard_address(const ProcessSocketAddress &address) {
    return std::ranges::all_of(address.address, [](uint8_t byte) {
        return byte == 0;
    });
}

uint32_t select_process_socket_owner(const ProcessSocketAddress &source,
        const std::optional<ProcessSocketAddress> &destination, ProcessSocketProtocol protocol,
        std::span<const ProcessSocketOwner> rows, ProcessSocketContext context) {
    auto family = process_socket_table_family(source, protocol);
    const bool match_tcp_remote = protocol == ProcessSocketProtocol::TCP && context == ProcessSocketContext::TUN;
    if (!family || (context != ProcessSocketContext::TUN && context != ProcessSocketContext::SOCKS)
            || (match_tcp_remote
                    && (!destination || destination->family != *family || destination->port == 0))) {
        return 0;
    }

    // Keep all candidate owners, including system/unknown PIDs: ignoring them
    // could turn a shared endpoint into an apparently unique user process.
    auto select = [&](bool exact_source_only) -> std::optional<uint32_t> {
        std::optional<uint32_t> owner;
        for (const auto &row : rows) {
            if (row.local.family != *family || row.local.port != source.port) {
                continue;
            }
            if (match_tcp_remote
                    && (!same_address(row.remote, *destination) || row.remote.port != destination->port)) {
                continue;
            }
            bool source_matches = same_address(row.local, source)
                    || (protocol == ProcessSocketProtocol::UDP && wildcard_address(row.local));
            if (exact_source_only && !source_matches) {
                continue;
            }
            if (row.pid <= 4 || (owner && *owner != row.pid)) {
                return 0;
            }
            owner = row.pid;
        }
        return owner;
    };

    if (auto owner = select(true)) {
        return *owner;
    }
    return select(false).value_or(0);
}

} // namespace ag
