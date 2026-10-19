#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace ag {

struct NetworkGuardResult {
    bool success = false;
    bool armed = true;
    const char *error = "network-guard-unavailable";
    std::string to_json() const;
};

enum class LegacyGuardObjectKind { FILTER, SUBLAYER, PROVIDER };

// Ownership evidence extracted by the Windows adapter. Policy contents, process
// path, disabled state and completeness are irrelevant to obsolete block removal.
struct LegacyGuardObject {
    LegacyGuardObjectKind kind = LegacyGuardObjectKind::FILTER;
    uint32_t version = 0;
    bool provider_key_matches = false;
    bool sublayer_key_matches = false;
    bool object_key_matches = false;
    std::string owner_data;
    uint64_t filter_id = 0;
    bool blocking = false;
};

struct LegacyGuardSnapshot {
    bool complete = false;
    std::vector<LegacyGuardObject> objects;
};

// No add/arm operation exists. Production and offline failure tests use the
// same ownership and deletion coordinator.
struct LegacyGuardCleanupAdapter {
    std::function<LegacyGuardSnapshot()> inspect;
    std::function<bool(const LegacyGuardObject &)> remove;
};

bool network_guard_legacy_object_owned(const LegacyGuardObject &object);
NetworkGuardResult network_guard_cleanup(LegacyGuardCleanupAdapter &adapter, bool remove);

// Used only by the cleanup CLI. The action stays on the calling thread; the
// watchdog can terminate that process if an SDK call stops returning. Tests inject
// a harmless timeout callback and never run actual WFP cleanup.
NetworkGuardResult network_guard_cleanup_with_deadline(std::chrono::milliseconds timeout,
        const std::function<NetworkGuardResult()> &action, const std::function<void()> &on_timeout);

class WindowsNetworkGuard {
public:
    // Read-only legacy inspection; the normal VPN startup never calls this.
    static NetworkGuardResult status();
    // Cleanup only. Never creates restrictions or resets unrelated networking.
    static NetworkGuardResult release();
};

} // namespace ag
