#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#endif

#include "net/windows_network_guard.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <string_view>
#include <thread>

#include <nlohmann/json.hpp>

#ifdef _WIN32
#include <windows.h>

#include <fwpmu.h>
#endif

namespace ag {

namespace {
constexpr char OWNER_V1[] = "TrustTunnelClientPro.NetworkGuard.1";
constexpr char OWNER_V2[] = "TrustTunnelClientPro.NetworkGuard.2";

bool has_owned_block(const LegacyGuardSnapshot &snapshot) {
    return std::any_of(snapshot.objects.begin(), snapshot.objects.end(), [](const auto &object) {
        return object.kind == LegacyGuardObjectKind::FILTER && object.blocking
                && network_guard_legacy_object_owned(object);
    });
}

class CleanupWatchdog {
public:
    CleanupWatchdog(std::chrono::milliseconds timeout, const std::function<void()> &on_timeout)
            : m_thread([this, timeout, on_timeout] {
                std::unique_lock lock(m_mutex);
                if (m_complete.wait_for(lock, timeout, [this] {
                        return m_finished;
                    })) {
                    return;
                }
                lock.unlock();
                on_timeout();
            }) {
    }

    ~CleanupWatchdog() {
        {
            std::lock_guard lock(m_mutex);
            m_finished = true;
        }
        m_complete.notify_one();
        // The cleanup action runs on the caller, never on this joined thread.
        m_thread.join();
    }

    CleanupWatchdog(const CleanupWatchdog &) = delete;
    CleanupWatchdog &operator=(const CleanupWatchdog &) = delete;

private:
    std::mutex m_mutex;
    std::condition_variable m_complete;
    bool m_finished = false;
    std::thread m_thread;
};
} // namespace

NetworkGuardResult network_guard_cleanup_with_deadline(std::chrono::milliseconds timeout,
        const std::function<NetworkGuardResult()> &action, const std::function<void()> &on_timeout) {
    CleanupWatchdog watchdog(timeout, on_timeout);
    return action();
}

bool network_guard_legacy_object_owned(const LegacyGuardObject &object) {
    if ((object.version != 1 && object.version != 2) || !object.object_key_matches || !object.provider_key_matches
            || (object.kind != LegacyGuardObjectKind::PROVIDER && !object.sublayer_key_matches)) {
        return false;
    }
    std::string_view marker(object.version == 1 ? OWNER_V1 : OWNER_V2, sizeof(OWNER_V1));
    // The first filter stored the owner marker followed by the original policy.
    // A malformed/truncated policy must not trap a positively identified block.
    return object.kind == LegacyGuardObjectKind::FILTER ? object.owner_data.starts_with(marker)
                                                        : object.owner_data == marker;
}

NetworkGuardResult network_guard_cleanup(LegacyGuardCleanupAdapter &adapter, bool remove) {
    auto before = adapter.inspect();
    if (!remove) {
        return before.complete ? NetworkGuardResult{true, has_owned_block(before), nullptr} : NetworkGuardResult{};
    }
    bool success = before.complete;
    // Remove restrictions first, in either namespace and in any enumeration order.
    // Never remove a CORE/local permit while an owned block might still exist:
    // that would make an unsuccessful cleanup more restrictive than before.
    for (const auto &object : before.objects) {
        if (object.kind == LegacyGuardObjectKind::FILTER && object.blocking
                && network_guard_legacy_object_owned(object)) {
            success = adapter.remove(object) && success;
        }
    }
    auto without_blocks = adapter.inspect();
    if (!success || !without_blocks.complete || has_owned_block(without_blocks)) {
        return {false, !without_blocks.complete || has_owned_block(without_blocks), "network-guard-cleanup-incomplete"};
    }

    // Every block is confirmed absent before any nonblocking object is removed.
    // A metadata failure cannot roll back restrictions already removed safely.
    for (auto kind :
            {LegacyGuardObjectKind::FILTER, LegacyGuardObjectKind::SUBLAYER, LegacyGuardObjectKind::PROVIDER}) {
        for (const auto &object : without_blocks.objects) {
            if (object.kind == kind && (kind != LegacyGuardObjectKind::FILTER || !object.blocking)
                    && network_guard_legacy_object_owned(object)) {
                success = adapter.remove(object) && success;
            }
        }
    }
    auto after = adapter.inspect();
    const bool armed = !after.complete || has_owned_block(after);
    success = success && after.complete && !armed;
    return {success, armed, success ? nullptr : "network-guard-cleanup-incomplete"};
}

std::string NetworkGuardResult::to_json() const {
    nlohmann::json value{{"version", 2}, {"armed", armed}};
    if (!success) {
        value["error"] = error;
    }
    return value.dump();
}

#ifdef _WIN32
namespace {

struct Namespace {
    uint32_t version;
    GUID provider;
    GUID sublayer;
    ULONG filter_key_base;
};

// Exactly the two obsolete Pro namespaces. The ordinary VPN kill switch and
// every other product/provider are outside this cleanup.
constexpr std::array NAMESPACES{
        Namespace{1, {0x9bdb91ef, 0x433b, 0x45d6, {0x96, 0x6d, 0x81, 0xe6, 0x43, 0x95, 0x77, 0x5c}},
                {0x407a7508, 0xdb88, 0x45f5, {0xab, 0xb8, 0x5b, 0x63, 0x4e, 0x7d, 0x1c, 0x67}}, 0xb6d5da00UL},
        Namespace{2, {0x811c1a8b, 0xf10c, 0x4398, {0x99, 0x7d, 0x18, 0x7a, 0x66, 0x8b, 0x97, 0x42}},
                {0x91e271ac, 0x6c35, 0x4f2e, {0xad, 0xe8, 0x66, 0x90, 0x83, 0xa7, 0xc2, 0xd0}}, 0xc7e6eb00UL},
};

std::string owner_data(const FWP_BYTE_BLOB &blob) {
    if (!blob.data || blob.size < sizeof(OWNER_V1)) {
        return {};
    }
    // Only the owner prefix is needed; the saved policy can be very large.
    const size_t size = blob.size == sizeof(OWNER_V1) ? sizeof(OWNER_V1) : sizeof(OWNER_V1) + 1;
    return {reinterpret_cast<const char *>(blob.data), size};
}

bool filter_key_matches(const Namespace &space, GUID key) {
    ULONG offset = key.Data1 - space.filter_key_base;
    GUID expected{key.Data1, 0x843d, 0x4263, {0xaf, 0x3e, 0x64, 0x7d, 0x30, 0x13, 0xe3, 0x95}};
    return offset <= 0x1ffff && key == expected;
}

LegacyGuardObject filter_object(const Namespace &space, const FWPM_FILTER0 &filter) {
    return {.kind = LegacyGuardObjectKind::FILTER,
            .version = space.version,
            .provider_key_matches = filter.providerKey && *filter.providerKey == space.provider,
            .sublayer_key_matches = filter.subLayerKey == space.sublayer,
            .object_key_matches = filter_key_matches(space, filter.filterKey),
            .owner_data = owner_data(filter.providerData),
            .filter_id = filter.filterId,
            .blocking = filter.action.type == FWP_ACTION_BLOCK};
}

LegacyGuardObject provider_object(const Namespace &space, const FWPM_PROVIDER0 &provider) {
    return {.kind = LegacyGuardObjectKind::PROVIDER,
            .version = space.version,
            .provider_key_matches = provider.providerKey == space.provider,
            .object_key_matches = provider.providerKey == space.provider,
            .owner_data = owner_data(provider.providerData)};
}

LegacyGuardObject sublayer_object(const Namespace &space, const FWPM_SUBLAYER0 &sublayer) {
    return {.kind = LegacyGuardObjectKind::SUBLAYER,
            .version = space.version,
            .provider_key_matches = sublayer.providerKey && *sublayer.providerKey == space.provider,
            .sublayer_key_matches = sublayer.subLayerKey == space.sublayer,
            .object_key_matches = sublayer.subLayerKey == space.sublayer,
            .owner_data = owner_data(sublayer.providerData)};
}

class CleanupEngine {
public:
    CleanupEngine() {
        FWPM_SESSION0 session{};
        session.txnWaitTimeoutInMSec = 1000;
        if (FwpmEngineOpen0(nullptr, RPC_C_AUTHN_WINNT, nullptr, &session, &m_engine) != ERROR_SUCCESS) {
            m_engine = nullptr;
        }
    }
    ~CleanupEngine() {
        if (m_engine) {
            FwpmEngineClose0(m_engine);
        }
    }

    LegacyGuardSnapshot inspect() {
        LegacyGuardSnapshot snapshot{m_engine != nullptr, {}};
        if (!m_engine) {
            return snapshot;
        }
        for (const auto &space : NAMESPACES) {
            FWPM_PROVIDER0 *provider = nullptr;
            DWORD result = FwpmProviderGetByKey0(m_engine, &space.provider, &provider);
            snapshot.complete &= result == ERROR_SUCCESS || result == FWP_E_PROVIDER_NOT_FOUND;
            if (result == ERROR_SUCCESS && provider) {
                snapshot.objects.push_back(provider_object(space, *provider));
            }
            if (provider) {
                FwpmFreeMemory0(reinterpret_cast<void **>(&provider));
            }
            FWPM_SUBLAYER0 *sublayer = nullptr;
            result = FwpmSubLayerGetByKey0(m_engine, &space.sublayer, &sublayer);
            snapshot.complete &= result == ERROR_SUCCESS || result == FWP_E_SUBLAYER_NOT_FOUND;
            if (result == ERROR_SUCCESS && sublayer) {
                snapshot.objects.push_back(sublayer_object(space, *sublayer));
            }
            if (sublayer) {
                FwpmFreeMemory0(reinterpret_cast<void **>(&sublayer));
            }
            for (const GUID &layer : {FWPM_LAYER_ALE_AUTH_CONNECT_V4, FWPM_LAYER_ALE_AUTH_CONNECT_V6,
                         FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V4, FWPM_LAYER_ALE_AUTH_RECV_ACCEPT_V6}) {
                snapshot.complete = inspect_filters(space, layer, snapshot.objects) && snapshot.complete;
            }
        }
        return snapshot;
    }

    bool remove(const LegacyGuardObject &object) {
        if (!m_engine || expired() || !network_guard_legacy_object_owned(object)) {
            return false;
        }
        // Recheck ownership under a short transaction immediately before deletion.
        // Replacing a metadata object after enumeration cannot delete a new owner.
        if (FwpmTransactionBegin0(m_engine, 0) != ERROR_SUCCESS) {
            return false;
        }
        if (remove_current(object) && FwpmTransactionCommit0(m_engine) == ERROR_SUCCESS) {
            return true;
        }
        FwpmTransactionAbort0(m_engine);
        return false;
    }

private:
    HANDLE m_engine = nullptr;
    const std::chrono::steady_clock::time_point m_deadline = std::chrono::steady_clock::now() + std::chrono::seconds(6);

    bool expired() const {
        return std::chrono::steady_clock::now() >= m_deadline;
    }

    bool remove_current(const LegacyGuardObject &object) {
        const auto &space = NAMESPACES[object.version - 1];
        if (object.kind == LegacyGuardObjectKind::FILTER) {
            FWPM_FILTER0 *filter = nullptr;
            DWORD result = FwpmFilterGetById0(m_engine, object.filter_id, &filter);
            const bool valid = result == ERROR_SUCCESS && filter
                    && network_guard_legacy_object_owned(filter_object(space, *filter));
            if (filter) {
                FwpmFreeMemory0(reinterpret_cast<void **>(&filter));
            }
            return result == FWP_E_FILTER_NOT_FOUND
                    || (valid && FwpmFilterDeleteById0(m_engine, object.filter_id) == ERROR_SUCCESS);
        }
        if (object.kind == LegacyGuardObjectKind::SUBLAYER) {
            FWPM_SUBLAYER0 *sublayer = nullptr;
            DWORD result = FwpmSubLayerGetByKey0(m_engine, &space.sublayer, &sublayer);
            const bool valid = result == ERROR_SUCCESS && sublayer
                    && network_guard_legacy_object_owned(sublayer_object(space, *sublayer));
            if (sublayer) {
                FwpmFreeMemory0(reinterpret_cast<void **>(&sublayer));
            }
            return result == FWP_E_SUBLAYER_NOT_FOUND
                    || (valid && FwpmSubLayerDeleteByKey0(m_engine, &space.sublayer) == ERROR_SUCCESS);
        }
        FWPM_PROVIDER0 *provider = nullptr;
        DWORD result = FwpmProviderGetByKey0(m_engine, &space.provider, &provider);
        const bool valid = result == ERROR_SUCCESS && provider
                && network_guard_legacy_object_owned(provider_object(space, *provider));
        if (provider) {
            FwpmFreeMemory0(reinterpret_cast<void **>(&provider));
        }
        return result == FWP_E_PROVIDER_NOT_FOUND
                || (valid && FwpmProviderDeleteByKey0(m_engine, &space.provider) == ERROR_SUCCESS);
    }

    bool inspect_filters(const Namespace &space, const GUID &layer, std::vector<LegacyGuardObject> &objects) {
        if (expired()) {
            return false;
        }
        FWPM_FILTER_ENUM_TEMPLATE0 query{};
        query.providerKey = const_cast<GUID *>(&space.provider);
        query.layerKey = layer;
        query.enumType = FWP_FILTER_ENUM_FULLY_CONTAINED;
        query.flags = FWP_FILTER_ENUM_FLAG_INCLUDE_DISABLED;
        query.actionMask = UINT32_MAX;
        HANDLE enumeration = nullptr;
        if (FwpmFilterCreateEnumHandle0(m_engine, &query, &enumeration) != ERROR_SUCCESS) {
            return false;
        }
        bool complete = false;
        for (size_t page = 0; page < 1024 && !expired(); ++page) {
            FWPM_FILTER0 **entries = nullptr;
            UINT32 count = 0;
            DWORD result = FwpmFilterEnum0(m_engine, enumeration, 128, &entries, &count);
            if (result != ERROR_SUCCESS) {
                if (entries) {
                    FwpmFreeMemory0(reinterpret_cast<void **>(&entries));
                }
                break;
            }
            for (UINT32 i = 0; i < count; ++i) {
                objects.push_back(filter_object(space, *entries[i]));
            }
            FwpmFreeMemory0(reinterpret_cast<void **>(&entries));
            if (count < 128) {
                complete = true;
                break;
            }
        }
        FwpmFilterDestroyEnumHandle0(m_engine, enumeration);
        return complete;
    }
};

NetworkGuardResult inspect_or_cleanup(bool remove) {
    CleanupEngine engine;
    LegacyGuardCleanupAdapter adapter{[&] {
                                          return engine.inspect();
                                      },
            [&](const auto &object) {
                return engine.remove(object);
            }};
    return network_guard_cleanup(adapter, remove);
}
} // namespace

NetworkGuardResult WindowsNetworkGuard::status() {
    return inspect_or_cleanup(false);
}

NetworkGuardResult WindowsNetworkGuard::release() {
    return inspect_or_cleanup(true);
}
#else
NetworkGuardResult WindowsNetworkGuard::status() {
    return {true, false, nullptr};
}
NetworkGuardResult WindowsNetworkGuard::release() {
    return {true, false, nullptr};
}
#endif

} // namespace ag
