#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#endif

#include "net/windows_network_guard.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cstring>
#include <future>
#include <span>
#include <string_view>

#include <nlohmann/json.hpp>

#include "common/socket_address.h"
#include "common/utils.h"

#ifdef _WIN32
#include <fwpmu.h>
#include <iphlpapi.h>
#include <netioapi.h>

#include "dns/common/event_loop.h"
#include "dns/net/socket.h"
#include "dns/upstream/bootstrapper.h"
#endif

namespace ag {

namespace {
std::atomic_bool g_strict_socket_protection{false};
}

void network_guard_set_strict_socket_protection(bool enabled) {
    g_strict_socket_protection = enabled;
}

bool network_guard_strict_socket_protection() {
    return g_strict_socket_protection;
}

bool network_guard_socket_protection_result(
        bool strict, uint32_t interface_index, bool physical, bool source_bound, bool interface_bound) {
    return strict ? interface_index != 0 && physical && source_bound && interface_bound
                  : source_bound || interface_bound;
}

bool network_guard_valid_policy(const NetworkGuardPolicy &policy) {
    if (policy.included_routes.empty() || policy.included_routes.size() + policy.excluded_routes.size() > 4096) {
        return false;
    }
    for (const auto *routes : {&policy.included_routes, &policy.excluded_routes}) {
        for (const auto &route : *routes) {
            auto split = utils::split2_by(route, '/');
            SocketAddress address(std::string(split.front()), 0);
            auto prefix = split[1].empty() ? std::optional<size_t>{address.addr().size() * 8}
                                           : utils::to_integer<size_t>(split[1]);
            if (!address.valid() || !prefix || *prefix > address.addr().size() * 8 || route.size() > 64) {
                return false;
            }
            if (!CidrRange(route).valid()) {
                return false;
            }
        }
    }
    return true;
}

std::vector<NetworkGuardRule> network_guard_base_plan(const NetworkGuardPolicy &policy) {
    std::vector<NetworkGuardRule> rules;
    if (!network_guard_valid_policy(policy)) {
        return rules;
    }
    for (const auto &range : policy.included_routes) {
        rules.push_back({.kind = NetworkGuardRuleKind::BLOCK,
                .ipv6 = range.find(':') != std::string::npos,
                .remote_range = range});
        // Keep system DNS from escaping through a LAN router when the VPN core
        // (and its dynamic DNS restriction) dies. Restrict only the captured scope.
        for (uint8_t protocol : {uint8_t(6), uint8_t(17)}) {
            for (uint16_t port : {uint16_t(53), uint16_t(853)}) {
                rules.push_back({.kind = NetworkGuardRuleKind::DNS_BLOCK,
                        .ipv6 = range.find(':') != std::string::npos,
                        .remote_range = range,
                        .protocol = protocol,
                        .remote_port = port});
            }
        }
    }
    for (bool ipv6 : {false, true}) {
        rules.push_back({.kind = NetworkGuardRuleKind::CORE, .ipv6 = ipv6});
    }
    for (const auto &range : policy.excluded_routes) {
        // Default/normalized local exclusions must not turn into a DNS bypass.
        // Explicit public custom-route exceptions retain their intentional meaning.
        const CidrRange excluded(range);
        bool local = false;
        for (const char *prefix : {"127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16",
                     "224.0.0.0/4", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8"}) {
            local = local || CidrRange(prefix).contains(excluded);
        }
        rules.push_back({.kind = local ? NetworkGuardRuleKind::LOCAL : NetworkGuardRuleKind::EXCLUDED,
                .ipv6 = range.find(':') != std::string::npos,
                .remote_range = range});
    }
    // Preserve local network access. These ranges cannot represent a public unicast peer.
    // Multicast is restricted to local scopes, rather than the complete multicast space.
    for (const char *range : {"127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16",
                 "224.0.0.0/24", "239.255.255.250/32", "::1/128", "fc00::/7", "fe80::/10", "ff01::/16", "ff02::/16"}) {
        rules.push_back({.kind = NetworkGuardRuleKind::LOCAL,
                .ipv6 = std::string_view(range).find(':') != std::string_view::npos,
                .remote_range = range});
    }
    // DHCP client discovery is the only broadcast exemption, and both UDP ports are fixed.
    rules.push_back({.kind = NetworkGuardRuleKind::DHCP,
            .remote_range = "255.255.255.255/32",
            .protocol = 17,
            .local_port = 68,
            .remote_port = 67});
    auto count = rules.size();
    for (size_t i = 0; i < count; ++i) {
        auto rule = rules[i];
        rule.inbound = true;
        // An inbound DHCP server reply has the reverse UDP port pair.
        if (rule.kind == NetworkGuardRuleKind::DHCP) {
            rule.remote_range = "0.0.0.0/0";
            rule.local_port = 68;
            rule.remote_port = 67;
        }
        rules.push_back(std::move(rule));
    }
    return rules;
}

uint8_t network_guard_rule_weight(const NetworkGuardRule &rule) {
    switch (rule.kind) {
    case NetworkGuardRuleKind::CORE:
    case NetworkGuardRuleKind::TUNNEL:
        return 15;
    case NetworkGuardRuleKind::EXCLUDED:
        return 14;
    case NetworkGuardRuleKind::DNS_BLOCK:
        return 11;
    case NetworkGuardRuleKind::LOCAL:
    case NetworkGuardRuleKind::DHCP:
        return 10;
    case NetworkGuardRuleKind::BLOCK:
        return 1;
    }
    return 1;
}

bool network_guard_rule_blocks(const NetworkGuardRule &rule) {
    return rule.kind == NetworkGuardRuleKind::BLOCK || rule.kind == NetworkGuardRuleKind::DNS_BLOCK;
}

std::vector<NetworkGuardRule> network_guard_tunnel_plan(
        uint64_t interface_luid, const CidrRange &ipv4, const CidrRange &ipv6) {
    std::vector<NetworkGuardRule> rules;
    if (interface_luid == 0 || !ipv4.valid() || ipv4.get_address().size() != 4) {
        return rules;
    }
    for (const CidrRange *address : {&ipv4, &ipv6}) {
        if (!address->valid()) {
            continue;
        }
        size_t bytes = address->get_address().size();
        if (bytes != 4 && bytes != 16) {
            return {};
        }
        rules.push_back({.kind = NetworkGuardRuleKind::TUNNEL,
                .ipv6 = bytes == 16,
                .local_address = CidrRange(address->get_address(), bytes * 8).to_string(),
                .interface_luid = interface_luid,
                .persistent = false});
    }
    auto count = rules.size();
    for (size_t i = 0; i < count; ++i) {
        auto rule = rules[i];
        rule.inbound = true;
        rules.push_back(std::move(rule));
    }
    return rules;
}

bool network_guard_valid_hostname(const std::string &host) {
    if (host.empty() || host.size() > 253) {
        return false;
    }
    SocketAddress numeric(host, 0);
    if (numeric.valid()) {
        return true;
    }
    size_t label = 0;
    char previous = '.';
    for (unsigned char ch : host) {
        if (ch == '.') {
            if (label == 0 || previous == '-') {
                return false;
            }
            label = 0;
        } else {
            if (!((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-')
                    || (label == 0 && ch == '-') || ++label > 63) {
                return false;
            }
        }
        previous = char(ch);
    }
    return label != 0 && previous != '-';
}

NetworkGuardCommand network_guard_parse_command(std::string_view line) {
    if (line == "S") {
        return {NetworkGuardCommandKind::STATUS, {}};
    }
    if (line == "R") {
        return {NetworkGuardCommandKind::RELEASE, {}};
    }
    if (line.starts_with("A ") && line.size() > 2 && line.size() <= 32770
            && std::none_of(line.begin() + 2, line.end(), [](unsigned char ch) {
                   return ch < 32;
               })) {
        return {NetworkGuardCommandKind::ARM, std::string(line.substr(2))};
    }
    return {};
}

bool network_guard_valid_gui_ready(std::string_view line) {
    return line == "TRUSTTUNNEL_GUI_READY_V2";
}

bool run_network_guard_transaction(const NetworkGuardTransaction &transaction) {
    if (!transaction.begin()) {
        return false;
    }
    if (!transaction.apply() || !transaction.commit()) {
        transaction.abort();
        return false;
    }
    return true;
}

std::string NetworkGuardResult::to_json() const {
    nlohmann::json value{{"version", 2}, {"armed", armed}};
    if (!success) {
        value["error"] = error;
    }
    return value.dump();
}

std::string NetworkGuardResolveResult::to_json() const {
    nlohmann::json value{{"version", 2}, {"addresses", addresses}};
    if (error) {
        value["error"] = error;
    }
    return value.dump();
}

#ifdef _WIN32

namespace {

// Dedicated Pro objects: never enumerate/delete a foreign provider, sublayer or filter.
const GUID LEGACY_PROVIDER = {0x9bdb91ef, 0x433b, 0x45d6, {0x96, 0x6d, 0x81, 0xe6, 0x43, 0x95, 0x77, 0x5c}};
const GUID PROVIDER = {0x811c1a8b, 0xf10c, 0x4398, {0x99, 0x7d, 0x18, 0x7a, 0x66, 0x8b, 0x97, 0x42}};
const GUID LEGACY_SUBLAYER = {0x407a7508, 0xdb88, 0x45f5, {0xab, 0xb8, 0x5b, 0x63, 0x4e, 0x7d, 0x1c, 0x67}};
const GUID SUBLAYER = {0x91e271ac, 0x6c35, 0x4f2e, {0xad, 0xe8, 0x66, 0x90, 0x83, 0xa7, 0xc2, 0xd0}};
constexpr char OWNER[] = "TrustTunnelClientPro.NetworkGuard.2";
constexpr char LEGACY_OWNER[] = "TrustTunnelClientPro.NetworkGuard.1";
static_assert(sizeof(OWNER) == sizeof(LEGACY_OWNER));
constexpr UINT16 SUBLAYER_WEIGHT = 0x100;

GUID filter_key(size_t index, bool legacy = false) {
    GUID key = {legacy ? 0xb6d5da00UL : 0xc7e6eb00UL, 0x843d, 0x4263, {0xaf, 0x3e, 0x64, 0x7d, 0x30, 0x13, 0xe3, 0x95}};
    key.Data1 += static_cast<ULONG>(index);
    return key;
}

struct Engine {
    HANDLE handle = nullptr;
    explicit Engine(bool dynamic = false) {
        FWPM_SESSION0 session{};
        session.flags = dynamic ? FWPM_SESSION_FLAG_DYNAMIC : 0;
        session.txnWaitTimeoutInMSec = 3000;
        if (FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, &session, &handle) != ERROR_SUCCESS) {
            handle = nullptr;
        }
    }
    ~Engine() {
        if (handle) {
            FwpmEngineClose0(handle);
        }
    }
};

struct AppId {
    FWP_BYTE_BLOB *blob = nullptr;
    AppId() {
        std::array<wchar_t, 32768> path{};
        DWORD size = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
        if (size > 0 && size < path.size()) {
            FwpmGetAppIdFromFileName0(path.data(), &blob);
        }
    }
    ~AppId() {
        FwpmFreeMemory0(reinterpret_cast<void **>(&blob));
    }
};

FWP_BYTE_BLOB owner_blob(bool legacy = false) {
    return {sizeof(OWNER), reinterpret_cast<UINT8 *>(const_cast<char *>(legacy ? LEGACY_OWNER : OWNER))};
}

std::string policy_data(const NetworkGuardPolicy &policy, bool legacy = false) {
    std::string data(legacy ? LEGACY_OWNER : OWNER, sizeof(OWNER));
    data += nlohmann::json{{"included", policy.included_routes}, {"excluded", policy.excluded_routes}}.dump();
    return data;
}

std::optional<NetworkGuardPolicy> parse_policy(const FWP_BYTE_BLOB &data, bool legacy = false) {
    if (!data.data || data.size <= sizeof(OWNER) || data.size > 1024 * 1024
            || std::memcmp(data.data, legacy ? LEGACY_OWNER : OWNER, sizeof(OWNER)) != 0) {
        return std::nullopt;
    }
    auto value = nlohmann::json::parse(data.data + sizeof(OWNER), data.data + data.size, nullptr, false);
    if (value.is_discarded() || !value.is_object() || !value.contains("included") || !value.contains("excluded")
            || !value["included"].is_array() || !value["excluded"].is_array()) {
        return std::nullopt;
    }
    NetworkGuardPolicy policy{{}, {}};
    for (auto [key, routes] :
            {std::pair{"included", &policy.included_routes}, std::pair{"excluded", &policy.excluded_routes}}) {
        for (const auto &route : value[key]) {
            if (!route.is_string()) {
                return std::nullopt;
            }
            routes->push_back(route.get<std::string>());
        }
    }
    return network_guard_valid_policy(policy) ? std::optional(std::move(policy)) : std::nullopt;
}

bool is_owner(const FWP_BYTE_BLOB &data, bool legacy = false) {
    return data.size == sizeof(OWNER) && data.data
            && std::memcmp(data.data, legacy ? LEGACY_OWNER : OWNER, sizeof(OWNER)) == 0;
}

bool transaction(HANDLE engine, const std::function<bool()> &apply) {
    return run_network_guard_transaction({
            .begin =
                    [engine] {
                        return FwpmTransactionBegin0(engine, 0) == ERROR_SUCCESS;
                    },
            .apply = apply,
            .commit =
                    [engine] {
                        return FwpmTransactionCommit0(engine) == ERROR_SUCCESS;
                    },
            .abort =
                    [engine] {
                        FwpmTransactionAbort0(engine);
                    },
    });
}

struct Filter {
    FWPM_FILTER0 value{};
    std::vector<FWPM_FILTER_CONDITION0> conditions;
    FWP_V4_ADDR_AND_MASK v4{};
    FWP_V6_ADDR_AND_MASK v6{};
    UINT64 luid = 0;
    std::string data;

    Filter(const NetworkGuardRule &rule, size_t index, FWP_BYTE_BLOB *app_id,
            const NetworkGuardPolicy *policy = nullptr, bool legacy = false) {
        value.filterKey = filter_key(index, legacy);
        value.displayData.name = const_cast<wchar_t *>(L"TrustTunnel Client Pro network protection");
        value.providerKey = const_cast<GUID *>(legacy ? &LEGACY_PROVIDER : &PROVIDER);
        value.providerData = owner_blob(legacy);
        if (policy && index == 0) {
            data = policy_data(*policy, legacy);
            value.providerData = {static_cast<UINT32>(data.size()), reinterpret_cast<UINT8 *>(data.data())};
        }
        value.subLayerKey = legacy ? LEGACY_SUBLAYER : SUBLAYER;
        value.layerKey = rule.inbound
                ? (rule.ipv6 ? FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6 : FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4)
                : (rule.ipv6 ? FWPM_LAYER_ALE_AUTH_CONNECT_V6 : FWPM_LAYER_ALE_AUTH_CONNECT_V4);
        // Do not set CLEAR_ACTION_RIGHT: another firewall's block must remain effective.
        // New rules are always session-owned. PERSISTENT is used only to validate
        // a legacy filter before deleting it; no legacy construction is added to WFP.
        value.flags = legacy ? FWPM_FILTER_FLAG_PERSISTENT : 0;
        value.weight.type = FWP_UINT8;
        value.weight.uint8 = network_guard_rule_weight(rule);
        value.action.type = network_guard_rule_blocks(rule) ? FWP_ACTION_BLOCK : FWP_ACTION_PERMIT;
        if (rule.kind == NetworkGuardRuleKind::CORE) {
            add(FWPM_CONDITION_ALE_APP_ID, {.type = FWP_BYTE_BLOB_TYPE, .byteBlob = app_id});
        }
        if (!rule.remote_range.empty() || !rule.local_address.empty()) {
            CidrRange range(rule.remote_range.empty() ? rule.local_address : rule.remote_range);
            GUID field = rule.remote_range.empty() ? FWPM_CONDITION_IP_LOCAL_ADDRESS : FWPM_CONDITION_IP_REMOTE_ADDRESS;
            if (rule.ipv6) {
                std::memcpy(v6.addr, range.get_address().data(), sizeof(v6.addr));
                v6.prefixLength = static_cast<UINT8>(range.get_prefix_len());
                add(field, {.type = FWP_V6_ADDR_MASK, .v6AddrMask = &v6});
            } else {
                UINT32 address = 0;
                UINT32 mask = 0;
                std::memcpy(&address, range.get_address().data(), sizeof(address));
                std::memcpy(&mask, range.get_mask().data(), sizeof(mask));
                v4 = {ntohl(address), ntohl(mask)};
                add(field, {.type = FWP_V4_ADDR_MASK, .v4AddrMask = &v4});
            }
        }
        if (rule.interface_luid) {
            luid = rule.interface_luid;
            add(FWPM_CONDITION_IP_LOCAL_INTERFACE, {.type = FWP_UINT64, .uint64 = &luid});
        }
        if (rule.protocol) {
            add(FWPM_CONDITION_IP_PROTOCOL, {.type = FWP_UINT8, .uint8 = rule.protocol});
        }
        if (rule.local_port) {
            add(FWPM_CONDITION_IP_LOCAL_PORT, {.type = FWP_UINT16, .uint16 = rule.local_port});
        }
        if (rule.remote_port) {
            add(FWPM_CONDITION_IP_REMOTE_PORT, {.type = FWP_UINT16, .uint16 = rule.remote_port});
        }
        value.numFilterConditions = static_cast<UINT32>(conditions.size());
        value.filterCondition = conditions.data();
    }

    void add(const GUID &field, FWP_CONDITION_VALUE0 condition) {
        conditions.push_back({.fieldKey = field, .matchType = FWP_MATCH_EQUAL, .conditionValue = condition});
    }
};

bool equal_value(const FWP_CONDITION_VALUE0 &a, const FWP_CONDITION_VALUE0 &b) {
    if (a.type != b.type) {
        return false;
    }
    switch (a.type) {
    case FWP_UINT8:
        return a.uint8 == b.uint8;
    case FWP_UINT16:
        return a.uint16 == b.uint16;
    case FWP_UINT64:
        return a.uint64 && b.uint64 && *a.uint64 == *b.uint64;
    case FWP_BYTE_BLOB_TYPE:
        return a.byteBlob && b.byteBlob && a.byteBlob->size == b.byteBlob->size
                && std::memcmp(a.byteBlob->data, b.byteBlob->data, a.byteBlob->size) == 0;
    case FWP_V4_ADDR_MASK:
        return a.v4AddrMask && b.v4AddrMask && a.v4AddrMask->addr == b.v4AddrMask->addr
                && a.v4AddrMask->mask == b.v4AddrMask->mask;
    case FWP_V6_ADDR_MASK:
        return a.v6AddrMask && b.v6AddrMask && a.v6AddrMask->prefixLength == b.v6AddrMask->prefixLength
                && std::memcmp(a.v6AddrMask->addr, b.v6AddrMask->addr, 16) == 0;
    default:
        return false;
    }
}

bool equal_filter(const FWPM_FILTER0 &a, const FWPM_FILTER0 &b, bool legacy = false) {
    if (!a.providerKey || !b.providerKey || *a.providerKey != *b.providerKey || a.subLayerKey != b.subLayerKey
            || a.providerData.size != b.providerData.size
            || std::memcmp(a.providerData.data, b.providerData.data, a.providerData.size) != 0
            || (a.flags & ~(legacy ? FWPM_FILTER_FLAG_DISABLED : 0)) != b.flags || a.layerKey != b.layerKey
            || a.action.type != b.action.type || a.weight.type != FWP_UINT8 || a.weight.uint8 != b.weight.uint8
            || a.numFilterConditions != b.numFilterConditions) {
        return false;
    }
    for (UINT32 i = 0; i < a.numFilterConditions; ++i) {
        const auto &actual = a.filterCondition[i];
        auto expected =
                std::find_if(b.filterCondition, b.filterCondition + b.numFilterConditions, [&](const auto &condition) {
                    return actual.fieldKey == condition.fieldKey;
                });
        if (expected == b.filterCondition + b.numFilterConditions || actual.matchType != FWP_MATCH_EQUAL
                || !equal_value(actual.conditionValue, expected->conditionValue)) {
            return false;
        }
    }
    return true;
}

bool exact_owned_filter_count(HANDLE engine, size_t expected, bool legacy = false) {
    size_t base_count = 0;
    const GUID &provider = legacy ? LEGACY_PROVIDER : PROVIDER;
    const GUID &sublayer = legacy ? LEGACY_SUBLAYER : SUBLAYER;
    for (const GUID &layer : {FWPM_LAYER_ALE_AUTH_CONNECT_V4, FWPM_LAYER_ALE_AUTH_CONNECT_V6,
                 FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4, FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6}) {
        FWPM_FILTER_ENUM_TEMPLATE0 query{};
        query.providerKey = const_cast<GUID *>(&provider);
        query.layerKey = layer;
        query.enumType = FWP_FILTER_ENUM_FULLY_CONTAINED;
        query.flags = FWP_FILTER_ENUM_FLAG_INCLUDE_DISABLED;
        query.actionMask = UINT32_MAX;
        HANDLE enumeration = nullptr;
        if (FwpmFilterCreateEnumHandle0(engine, &query, &enumeration) != ERROR_SUCCESS) {
            return false;
        }
        utils::ScopeExit close{[&] {
            FwpmFilterDestroyEnumHandle0(engine, enumeration);
        }};
        for (;;) {
            FWPM_FILTER0 **entries = nullptr;
            UINT32 count = 0;
            if (FwpmFilterEnum0(engine, enumeration, 128, &entries, &count) != ERROR_SUCCESS) {
                return false;
            }
            bool valid = true;
            for (UINT32 i = 0; i < count; ++i) {
                const auto &entry = *entries[i];
                GUID base_key = filter_key(0, legacy);
                ULONG index = entry.filterKey.Data1 - base_key.Data1;
                base_key.Data1 = entry.filterKey.Data1;
                bool base = entry.filterKey == base_key && index < expected;
                if (entry.subLayerKey != sublayer) {
                    valid = false;
                } else if (base) {
                    ++base_count;
                } else {
                    // The current core can own only these nonblocking dynamic TUN permits.
                    bool known = false;
                    for (size_t index = 0; index < 4; ++index) {
                        known = known || entry.filterKey == filter_key(0x10000 + index, legacy);
                    }
                    valid = valid && !legacy && known && is_owner(entry.providerData)
                            && entry.action.type == FWP_ACTION_PERMIT && entry.flags == 0
                            && entry.numFilterConditions == 2;
                    if (valid) {
                        bool address = false;
                        bool interface_match = false;
                        for (UINT32 index = 0; index < entry.numFilterConditions; ++index) {
                            address =
                                    address || entry.filterCondition[index].fieldKey == FWPM_CONDITION_IP_LOCAL_ADDRESS;
                            interface_match = interface_match
                                    || entry.filterCondition[index].fieldKey == FWPM_CONDITION_IP_LOCAL_INTERFACE;
                        }
                        valid = address && interface_match;
                    }
                }
            }
            FwpmFreeMemory0(reinterpret_cast<void **>(&entries));
            if (!valid || base_count > expected) {
                return false;
            }
            if (count < 128) {
                break;
            }
        }
    }
    return base_count == expected;
}

NetworkGuardResult inspect(
        HANDLE engine, FWP_BYTE_BLOB *app_id, NetworkGuardPolicy *stored = nullptr, bool legacy = false) {
    const GUID &provider_key = legacy ? LEGACY_PROVIDER : PROVIDER;
    const GUID &sublayer_key = legacy ? LEGACY_SUBLAYER : SUBLAYER;
    FWPM_PROVIDER0 *provider = nullptr;
    DWORD error = FwpmProviderGetByKey0(engine, &provider_key, &provider);
    bool absent = error == FWP_E_PROVIDER_NOT_FOUND;
    if (!absent && error != ERROR_SUCCESS) {
        return {};
    }
    UINT32 expected_flags = legacy ? FWPM_PROVIDER_FLAG_PERSISTENT : 0;
    bool valid = absent
            || ((provider->flags & ~(legacy ? FWPM_PROVIDER_FLAG_DISABLED : 0)) == expected_flags
                    && is_owner(provider->providerData, legacy));
    if (provider) {
        FwpmFreeMemory0(reinterpret_cast<void **>(&provider));
    }
    FWPM_SUBLAYER0 *sublayer = nullptr;
    error = FwpmSubLayerGetByKey0(engine, &sublayer_key, &sublayer);
    bool sublayer_absent = error == FWP_E_SUBLAYER_NOT_FOUND;
    if (!sublayer_absent && error != ERROR_SUCCESS) {
        return {};
    }
    valid = valid
            && (sublayer_absent ? absent
                                : !absent && sublayer->providerKey && *sublayer->providerKey == provider_key
                                    && sublayer->flags == (legacy ? FWPM_SUBLAYER_FLAG_PERSISTENT : 0)
                                    && sublayer->weight == SUBLAYER_WEIGHT && is_owner(sublayer->providerData, legacy));
    if (sublayer) {
        FwpmFreeMemory0(reinterpret_cast<void **>(&sublayer));
    }
    GUID first_key = filter_key(0, legacy);
    FWPM_FILTER0 *first = nullptr;
    error = FwpmFilterGetByKey0(engine, &first_key, &first);
    bool armed = error == ERROR_SUCCESS;
    std::optional<NetworkGuardPolicy> policy = armed ? parse_policy(first->providerData, legacy) : std::nullopt;
    if (first) {
        FwpmFreeMemory0(reinterpret_cast<void **>(&first));
    }
    valid = valid
            && (armed ? !absent && !sublayer_absent && policy.has_value()
                      : error == FWP_E_FILTER_NOT_FOUND && (!legacy || absent));
    if (policy && stored) {
        *stored = *policy;
    }
    auto plan = policy ? network_guard_base_plan(*policy) : std::vector<NetworkGuardRule>{};
    for (size_t i = 0; i < plan.size(); ++i) {
        if (legacy) {
            plan[i].persistent = true;
        }
        FWPM_FILTER0 *filter = nullptr;
        GUID key = filter_key(i, legacy);
        error = FwpmFilterGetByKey0(engine, &key, &filter);
        if (error != ERROR_SUCCESS) {
            valid = false;
        } else {
            Filter expected(plan[i], i, app_id, &*policy, legacy);
            valid = valid && equal_filter(*filter, expected.value, legacy);
        }
        if (filter) {
            FwpmFreeMemory0(reinterpret_cast<void **>(&filter));
        }
    }
    valid = valid && (absent || exact_owned_filter_count(engine, plan.size(), legacy));
    return valid ? NetworkGuardResult{true, armed, nullptr}
                 : NetworkGuardResult{false, true, "network-guard-state-incomplete"};
}

bool ensure_static_objects(HANDLE engine) {
    FWPM_PROVIDER0 *existing = nullptr;
    DWORD error = FwpmProviderGetByKey0(engine, &PROVIDER, &existing);
    if (existing) {
        FwpmFreeMemory0(reinterpret_cast<void **>(&existing));
    }
    if (error == ERROR_SUCCESS) {
        return true;
    } // inspect already validated both objects.
    if (error != FWP_E_PROVIDER_NOT_FOUND) {
        return false;
    }
    FWPM_PROVIDER0 provider{};
    provider.providerKey = PROVIDER;
    provider.displayData.name = const_cast<wchar_t *>(L"TrustTunnel Client Pro session protection");
    provider.providerData = owner_blob();
    // Static metadata cannot block traffic and disappears when BFE/Windows restarts.
    if (FwpmProviderAdd0(engine, &provider, nullptr) != ERROR_SUCCESS) {
        return false;
    }
    FWPM_SUBLAYER0 sublayer{};
    sublayer.subLayerKey = SUBLAYER;
    sublayer.providerKey = const_cast<GUID *>(&PROVIDER);
    sublayer.displayData = provider.displayData;
    sublayer.providerData = owner_blob();
    sublayer.weight = SUBLAYER_WEIGHT;
    return FwpmSubLayerAdd0(engine, &sublayer, nullptr) == ERROR_SUCCESS;
}

bool add_base(HANDLE engine, FWP_BYTE_BLOB *app_id, const NetworkGuardPolicy &policy) {
    auto plan = network_guard_base_plan(policy);
    for (size_t i = 0; i < plan.size(); ++i) {
        Filter filter(plan[i], i, app_id, &policy);
        if (FwpmFilterAdd0(engine, &filter.value, nullptr, nullptr) != ERROR_SUCCESS) {
            return false;
        }
    }
    return true;
}

bool delete_base(HANDLE engine, const NetworkGuardPolicy &policy) {
    auto plan = network_guard_base_plan(policy);
    for (size_t i = 0; i < plan.size(); ++i) {
        GUID key = filter_key(i);
        if (FwpmFilterDeleteByKey0(engine, &key) != ERROR_SUCCESS) {
            return false;
        }
    }
    return true;
}

bool legacy_absent(HANDLE engine) {
    FWPM_PROVIDER0 *provider = nullptr;
    DWORD error = FwpmProviderGetByKey0(engine, &LEGACY_PROVIDER, &provider);
    if (provider) {
        FwpmFreeMemory0(reinterpret_cast<void **>(&provider));
    }
    return error == FWP_E_PROVIDER_NOT_FOUND;
}

} // namespace

NetworkGuardResult WindowsNetworkGuard::status() {
    Engine engine;
    AppId app;
    if (!engine.handle || !app.blob || FwpmTransactionBegin0(engine.handle, FWPM_TXN_READ_ONLY) != ERROR_SUCCESS) {
        return {};
    }
    auto result = legacy_absent(engine.handle)
            ? inspect(engine.handle, app.blob)
            : NetworkGuardResult{false, true, "network-guard-legacy-cleanup-required"};
    if (FwpmTransactionCommit0(engine.handle) != ERROR_SUCCESS) {
        return {};
    }
    return result;
}

NetworkGuardResult WindowsNetworkGuard::release() {
    Engine engine;
    AppId app;
    if (!engine.handle || !app.blob) {
        return {};
    }
    bool success = transaction(engine.handle, [&] {
        NetworkGuardPolicy policy;
        auto state = inspect(engine.handle, app.blob, &policy, true);
        if (!state.success || !state.armed) {
            return state.success;
        }
        auto plan = network_guard_base_plan(policy);
        for (size_t i = 0; i < plan.size(); ++i) {
            GUID key = filter_key(i, true);
            if (FwpmFilterDeleteByKey0(engine.handle, &key) != ERROR_SUCCESS) {
                return false;
            }
        }
        // Disabled legacy filters are removable after reboot, but unknown ownership
        // or a still-live legacy TUN session makes the whole cleanup roll back.
        return FwpmSubLayerDeleteByKey0(engine.handle, &LEGACY_SUBLAYER) == ERROR_SUCCESS
                && FwpmProviderDeleteByKey0(engine.handle, &LEGACY_PROVIDER) == ERROR_SUCCESS;
    });
    return success ? WindowsNetworkGuard::status() : NetworkGuardResult{};
}

struct WindowsNetworkGuardSession::Impl {
    std::unique_ptr<Engine> engine;
    std::unique_ptr<AppId> app;
    bool owns_base = false;
};

WindowsNetworkGuardSession::WindowsNetworkGuardSession()
        : m_impl(std::make_unique<Impl>()) {
    Engine setup;
    m_impl->app = std::make_unique<AppId>();
    if (!setup.handle || !m_impl->app->blob || !transaction(setup.handle, [&] {
            auto state = inspect(setup.handle, m_impl->app->blob);
            return state.success && !state.armed && legacy_absent(setup.handle) && ensure_static_objects(setup.handle);
        })) {
        return;
    }
    m_impl->engine = std::make_unique<Engine>(true);
    if (!m_impl->engine->handle) {
        m_impl->engine.reset();
    }
}

WindowsNetworkGuardSession::~WindowsNetworkGuardSession() = default;

NetworkGuardResult WindowsNetworkGuardSession::status() {
    if (!m_impl->engine || !m_impl->app->blob) {
        return {};
    }
    auto result = inspect(m_impl->engine->handle, m_impl->app->blob);
    if (result.success && result.armed != m_impl->owns_base) {
        return {false, true, "network-guard-session-conflict"};
    }
    return result;
}

NetworkGuardResult WindowsNetworkGuardSession::arm(const NetworkGuardPolicy &policy) {
    if (!network_guard_valid_policy(policy)) {
        return {false, true, "network-guard-invalid-routes"};
    }
    if (!m_impl->engine || !m_impl->app->blob) {
        return {};
    }
    bool success = transaction(m_impl->engine->handle, [&] {
        NetworkGuardPolicy previous;
        auto state = inspect(m_impl->engine->handle, m_impl->app->blob, &previous);
        if (!state.success || state.armed != m_impl->owns_base) {
            return false;
        }
        if (state.armed && previous == policy) {
            return true;
        }
        return (!state.armed || delete_base(m_impl->engine->handle, previous))
                && add_base(m_impl->engine->handle, m_impl->app->blob, policy);
    });
    if (success) {
        m_impl->owns_base = true;
    }
    return success ? NetworkGuardResult{true, true, nullptr} : NetworkGuardResult{};
}

NetworkGuardResult WindowsNetworkGuardSession::release() {
    if (!m_impl->engine || !m_impl->app->blob) {
        return {};
    }
    bool success = transaction(m_impl->engine->handle, [&] {
        NetworkGuardPolicy policy;
        auto state = inspect(m_impl->engine->handle, m_impl->app->blob, &policy);
        return state.success && state.armed == m_impl->owns_base
                && (!state.armed || delete_base(m_impl->engine->handle, policy));
    });
    if (success) {
        m_impl->owns_base = false;
    }
    return success ? NetworkGuardResult{true, false, nullptr} : NetworkGuardResult{};
}

struct WindowsNetworkGuardTunnel::Impl {
    std::unique_ptr<Engine> engine;
};

WindowsNetworkGuardTunnel::WindowsNetworkGuardTunnel()
        : m_impl(std::make_unique<Impl>()) {
}

WindowsNetworkGuardTunnel::~WindowsNetworkGuardTunnel() = default;

void WindowsNetworkGuardTunnel::reset() {
    m_impl->engine.reset();
}

bool WindowsNetworkGuardTunnel::activate(uint64_t luid, const CidrRange &ipv4, const CidrRange &ipv6) {
    reset();
    // This status is read-only. The GUI helper alone owns the session base rules.
    auto state = WindowsNetworkGuard::status();
    if (!state.success || !state.armed) {
        return state.success;
    }
    auto plan = network_guard_tunnel_plan(luid, ipv4, ipv6);
    if (plan.empty()) {
        return false;
    }
    auto engine = std::make_unique<Engine>(true);
    if (!engine->handle || !transaction(engine->handle, [&] {
            for (size_t i = 0; i < plan.size(); ++i) {
                Filter filter(plan[i], 0x10000 + i, nullptr);
                if (FwpmFilterAdd0(engine->handle, &filter.value, nullptr, nullptr) != ERROR_SUCCESS) {
                    return false;
                }
            }
            return true;
        })) {
        return false;
    }
    m_impl->engine = std::move(engine);
    return true;
}

NetworkGuardResolveResult WindowsNetworkGuard::resolve(const std::string &host) {
    if (!network_guard_valid_hostname(host)) {
        return {{}, "network-guard-invalid-host"};
    }
    if (SocketAddress numeric(host, 0); numeric.valid()) {
        return {{numeric.host_str()}, nullptr};
    }
    WSADATA data{};
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0) {
        return {{}, "network-guard-resolve-unavailable"};
    }
    utils::ScopeExit cleanup{[] {
        WSACleanup();
    }};
    ULONG size = 0;
    constexpr ULONG FLAGS = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST;
    if (GetAdaptersAddresses(AF_UNSPEC, FLAGS, nullptr, nullptr, &size) != ERROR_BUFFER_OVERFLOW) {
        return {{}, "network-guard-no-physical-dns"};
    }
    std::vector<UINT8> buffer(size);
    auto *adapters = reinterpret_cast<IP_ADAPTER_ADDRESSES *>(buffer.data());
    if (GetAdaptersAddresses(AF_UNSPEC, FLAGS, nullptr, adapters, &size) != ERROR_SUCCESS) {
        return {{}, "network-guard-no-physical-dns"};
    }
    const IP_ADAPTER_ADDRESSES *selected = nullptr;
    std::vector<std::string> servers;
    uint64_t metric = UINT64_MAX;
    for (auto *adapter = adapters; adapter; adapter = adapter->Next) {
        if (adapter->OperStatus != IfOperStatusUp || !adapter->FirstUnicastAddress || !adapter->FirstDnsServerAddress
                || (adapter->IfType != IF_TYPE_ETHERNET_CSMACD && adapter->IfType != IF_TYPE_IEEE80211
                        && adapter->IfType != 243 && adapter->IfType != 244)) {
            continue;
        }
        std::vector<std::string> candidate;
        for (auto *dns = adapter->FirstDnsServerAddress; dns; dns = dns->Next) {
            SocketAddress address(dns->Address.lpSockaddr);
            if (address.valid() && !address.is_loopback()) {
                address.set_port(53);
                candidate.push_back(address.str());
            }
        }
        uint64_t candidate_metric = std::min(adapter->Ipv4Metric, adapter->Ipv6Metric);
        if (!candidate.empty() && (!selected || candidate_metric < metric)) {
            selected = adapter;
            metric = candidate_metric;
            servers = std::move(candidate);
        }
    }
    if (!selected) {
        return {{}, "network-guard-no-physical-dns"};
    }
    // All sockets belong to this core executable, already covered by its narrow AppId permit.
    // The DNS library binds the chosen physical interface; no system resolver is invoked.
    dns::EventLoopPtr loop = dns::EventLoop::create();
    loop->start();
    dns::SocketFactory factory({.loop = *loop,
            .enable_route_resolver = false,
            .protect_fd = [selected](evutil_socket_t fd, const SocketAddress &peer) -> Error<dns::SocketError> {
                ULONG index = peer.is_ipv4() ? selected->IfIndex : selected->Ipv6IfIndex;
                SOCKADDR_INET source{};
                MIB_IPFORWARD_ROW2 route{};
                if (!index
                        || GetBestRoute2(nullptr, index, nullptr,
                                   reinterpret_cast<const SOCKADDR_INET *>(peer.c_storage()), 0, &route, &source)
                                != ERROR_SUCCESS) {
                    return make_error(dns::SocketError::AE_BIND_TO_IF_ERROR);
                }
                SocketAddress address(reinterpret_cast<sockaddr *>(&source));
                if (!address.valid() || bind(fd, address.c_sockaddr(), address.c_socklen()) != 0) {
                    return make_error(dns::SocketError::AE_BIND_TO_IF_ERROR);
                }
                UINT32 option_index = peer.is_ipv4() ? htonl(index) : index;
                if (setsockopt(fd, peer.is_ipv4() ? IPPROTO_IP : IPPROTO_IPV6,
                            peer.is_ipv4() ? IP_UNICAST_IF : IPV6_UNICAST_IF,
                            reinterpret_cast<const char *>(&option_index), sizeof(option_index))
                        != 0) {
                    return make_error(dns::SocketError::AE_BIND_TO_IF_ERROR);
                }
                return {};
            }});
    dns::UpstreamFactoryConfig upstream{.loop = *loop, .socket_factory = &factory};
    dns::Bootstrapper::Params params{
            .address_string = host,
            .default_port = 0,
            .bootstrap = servers,
            .timeout = Millis(4000),
            .upstream_config = upstream,
            // The protect callback binds both source address and the family-correct
            // physical interface. There is no unbound retry or OS resolver fallback.
            .outbound_interface = {},
    };
    auto bootstrapper = std::make_unique<dns::Bootstrapper>(params);
    NetworkGuardResolveResult result;
    if (bootstrapper->init()) {
        result.error = "network-guard-resolve-unavailable";
    } else {
        auto resolved =
                coro::to_future([](dns::EventLoop &event_loop,
                                        dns::Bootstrapper &resolver) -> coro::Task<dns::Bootstrapper::ResolveResult> {
                    co_await event_loop.co_submit();
                    co_return co_await resolver.get();
                }(*loop, *bootstrapper))
                        .get();
        if (resolved.error) {
            result.error = "network-guard-resolve-failed";
        } else {
            for (const auto &address : resolved.addresses) {
                std::string numeric = address.host_str();
                if (std::find(result.addresses.begin(), result.addresses.end(), numeric) == result.addresses.end()) {
                    result.addresses.push_back(std::move(numeric));
                }
                if (result.addresses.size() == 32) {
                    break;
                }
            }
            if (result.addresses.empty()) {
                result.error = "network-guard-resolve-failed";
            }
        }
    }
    bootstrapper.reset();
    loop->stop();
    loop->join();
    return result;
}

#else

NetworkGuardResult WindowsNetworkGuard::status() {
    return {};
}
NetworkGuardResult WindowsNetworkGuard::release() {
    return {};
}
NetworkGuardResolveResult WindowsNetworkGuard::resolve(const std::string &) {
    return {{}, "network-guard-unsupported-platform"};
}
struct WindowsNetworkGuardSession::Impl {};
WindowsNetworkGuardSession::WindowsNetworkGuardSession()
        : m_impl(std::make_unique<Impl>()) {
}
WindowsNetworkGuardSession::~WindowsNetworkGuardSession() = default;
NetworkGuardResult WindowsNetworkGuardSession::status() {
    return {};
}
NetworkGuardResult WindowsNetworkGuardSession::arm(const NetworkGuardPolicy &) {
    return {};
}
NetworkGuardResult WindowsNetworkGuardSession::release() {
    return {};
}
struct WindowsNetworkGuardTunnel::Impl {};
WindowsNetworkGuardTunnel::WindowsNetworkGuardTunnel()
        : m_impl(std::make_unique<Impl>()) {
}
WindowsNetworkGuardTunnel::~WindowsNetworkGuardTunnel() = default;
void WindowsNetworkGuardTunnel::reset() {
}
bool WindowsNetworkGuardTunnel::activate(uint64_t, const CidrRange &, const CidrRange &) {
    return false;
}

#endif

} // namespace ag
