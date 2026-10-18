#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "common/cidr_range.h"

namespace ag {

enum class NetworkGuardRuleKind { BLOCK, DNS_BLOCK, CORE, LOCAL, DHCP, EXCLUDED, TUNNEL };

struct NetworkGuardPolicy {
    std::vector<std::string> included_routes = {"0.0.0.0/0", "::/0"};
    std::vector<std::string> excluded_routes;
    bool operator==(const NetworkGuardPolicy &) const = default;
};

// This plan is consumed directly by the WFP adapter and by the offline tests.
// Permits are soft permits: they never bypass another provider's security policy.
struct NetworkGuardRule {
    NetworkGuardRuleKind kind = NetworkGuardRuleKind::BLOCK;
    bool ipv6 = false;
    std::string remote_range;
    std::string local_address;
    uint64_t interface_luid = 0;
    uint8_t protocol = 0;
    uint16_t local_port = 0;
    uint16_t remote_port = 0;
    bool persistent = true;
    bool inbound = false;
};

std::vector<NetworkGuardRule> network_guard_base_plan(const NetworkGuardPolicy &policy = {});
bool network_guard_valid_policy(const NetworkGuardPolicy &policy);
uint8_t network_guard_rule_weight(const NetworkGuardRule &rule);
bool network_guard_rule_blocks(const NetworkGuardRule &rule);
// Set only by the normal Windows client startup after checking persistent state.
// Diagnostic helpers never change this process-local mode or persistent policy.
void network_guard_set_strict_socket_protection(bool enabled);
bool network_guard_strict_socket_protection();
bool network_guard_socket_protection_result(
        bool strict, uint32_t interface_index, bool physical, bool source_bound, bool interface_bound);
std::vector<NetworkGuardRule> network_guard_tunnel_plan(
        uint64_t interface_luid, const CidrRange &ipv4, const CidrRange &ipv6);
bool network_guard_valid_hostname(const std::string &host);

// The same transaction coordinator is used for the real WFP calls and fault injection.
struct NetworkGuardTransaction {
    std::function<bool()> begin;
    std::function<bool()> apply;
    std::function<bool()> commit;
    std::function<void()> abort;
};
bool run_network_guard_transaction(const NetworkGuardTransaction &transaction);

struct NetworkGuardResult {
    bool success = false;
    bool armed = true; // Unknown or partial state must never be reported as unprotected.
    const char *error = "network-guard-unavailable";
    std::string to_json() const;
};

struct NetworkGuardResolveResult {
    std::vector<std::string> addresses;
    const char *error = nullptr;
    std::string to_json() const;
};

class WindowsNetworkGuard {
public:
    static NetworkGuardResult status();
    static NetworkGuardResult arm(const NetworkGuardPolicy &policy);
    // Only an explicit user disconnect/uninstall calls release, after the core exits.
    // Diagnostic helpers, normal startup, destructors and crash recovery never release it.
    static NetworkGuardResult release();
    // Core-owned sockets, numeric physical-adapter DNS servers, no OS resolver fallback.
    static NetworkGuardResolveResult resolve(const std::string &host);
};

class WindowsNetworkGuardTunnel {
public:
    WindowsNetworkGuardTunnel();
    ~WindowsNetworkGuardTunnel();
    WindowsNetworkGuardTunnel(const WindowsNetworkGuardTunnel &) = delete;
    WindowsNetworkGuardTunnel &operator=(const WindowsNetworkGuardTunnel &) = delete;
    // Must succeed before the TUN's routes/DNS become visible. A disabled guard is a no-op.
    bool activate(uint64_t interface_luid, const CidrRange &ipv4, const CidrRange &ipv6);
    void reset();

private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace ag
