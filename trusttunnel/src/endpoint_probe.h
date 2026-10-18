#pragma once

#include <cstdint>
#include <optional>
#include <span>
#include <string>

namespace ag {

struct EndpointProbeRoute {
    uint32_t interface_index = 0;
    uint8_t prefix_length = 0;
    uint64_t metric = 0;
    bool physical = false;
};

// Read-only route ordering, shared with the native regression tests.
std::optional<size_t> select_endpoint_probe_route(std::span<const EndpointProbeRoute> routes);

struct EndpointProbeResult {
    const char *status = "no-data";
    uint64_t ms = 0;
    const char *reason = "invalid-target";
    std::string to_json() const;
};

// Numeric address only. Opens one socket; never creates a tunnel, changes DNS,
// adds routes or opens a firewall session. A failed physical bind never falls back.
EndpointProbeResult probe_endpoint_tcp(const std::string &address, uint32_t timeout_ms);

} // namespace ag
