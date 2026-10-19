#include <gtest/gtest.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <type_traits>

#include "net/windows_network_guard.h"

namespace ag {
namespace {

LegacyGuardObject owned(LegacyGuardObjectKind kind, uint32_t version, uint64_t id = 1, bool blocking = true) {
    const std::string marker = "TrustTunnelClientPro.NetworkGuard." + std::to_string(version);
    return {.kind = kind,
            .version = version,
            .provider_key_matches = true,
            .sublayer_key_matches = true,
            .object_key_matches = true,
            .owner_data = marker + '\0',
            .filter_id = id,
            .blocking = blocking};
}

// No test opens WFP or modifies host networking. This fake exercises the same
// ownership/deletion coordinator used by the actual cleanup-only adapter.
struct FakeCleanup {
    std::vector<LegacyGuardObject> objects;
    std::vector<LegacyGuardObjectKind> deletion_order;
    std::vector<uint64_t> deleted_filter_ids;
    std::set<uint64_t> failed_filter_ids;
    bool metadata_failure = false;
    bool enumeration_failure = false;
    bool verification_failure = false;
    size_t inspections = 0;
    LegacyGuardCleanupAdapter adapter{
            [this] {
                ++inspections;
                return LegacyGuardSnapshot{!enumeration_failure && !(verification_failure && inspections > 1), objects};
            },
            [this](const auto &object) {
                deletion_order.push_back(object.kind);
                if (object.kind == LegacyGuardObjectKind::FILTER) {
                    deleted_filter_ids.push_back(object.filter_id);
                }
                if ((object.kind == LegacyGuardObjectKind::FILTER && failed_filter_ids.contains(object.filter_id))
                        || (object.kind != LegacyGuardObjectKind::FILTER && metadata_failure)) {
                    return false;
                }
                std::erase_if(objects, [&](const auto &current) {
                    return current.version == object.version && current.kind == object.kind
                            && (object.kind != LegacyGuardObjectKind::FILTER || current.filter_id == object.filter_id);
                });
                return true;
            }};
};

TEST(WindowsNetworkGuardTest, AbsentNamespacesAreAnIdempotentCleanupSuccess) {
    FakeCleanup fake;
    auto result = network_guard_cleanup(fake.adapter, true);
    EXPECT_TRUE(result.success);
    EXPECT_FALSE(result.armed);
    EXPECT_TRUE(fake.deletion_order.empty());
    EXPECT_EQ("{\"armed\":false,\"version\":2}", result.to_json());
    EXPECT_TRUE(network_guard_cleanup(fake.adapter, true).success);
}

TEST(WindowsNetworkGuardTest, StatusNeverCallsTheDeletionAdapter) {
    FakeCleanup fake;
    fake.objects = {owned(LegacyGuardObjectKind::FILTER, 1)};
    auto result = network_guard_cleanup(fake.adapter, false);
    EXPECT_TRUE(result.success);
    EXPECT_TRUE(result.armed);
    EXPECT_TRUE(fake.deletion_order.empty());
    EXPECT_EQ(1, fake.inspections);
}

TEST(WindowsNetworkGuardTest, PartialOrOrphanedNamespaceDoesNotNeedCompletePolicyOrMetadata) {
    FakeCleanup fake;
    fake.objects = {owned(LegacyGuardObjectKind::FILTER, 1, 17), owned(LegacyGuardObjectKind::FILTER, 2, 91)};
    auto result = network_guard_cleanup(fake.adapter, true);
    EXPECT_TRUE(result.success);
    EXPECT_FALSE(result.armed);
    EXPECT_TRUE(fake.objects.empty());
}

TEST(WindowsNetworkGuardTest, InvalidPolicyAndReplacedExecutableDoNotPreventOwnedCleanup) {
    FakeCleanup fake;
    auto filter = owned(LegacyGuardObjectKind::FILTER, 1);
    filter.owner_data += "{invalid or obsolete policy, old executable path, different conditions";
    fake.objects = {filter};
    // There is intentionally no comparison to the current executable AppID,
    // policy, rule count, disabled flag or filter conditions in the coordinator.
    EXPECT_TRUE(network_guard_cleanup(fake.adapter, true).success);
    EXPECT_TRUE(fake.objects.empty());
}

TEST(WindowsNetworkGuardTest, BothVersionsDeleteFiltersBeforeMetadata) {
    FakeCleanup fake;
    for (uint32_t version : {1, 2}) {
        fake.objects.push_back(owned(LegacyGuardObjectKind::PROVIDER, version));
        fake.objects.push_back(owned(LegacyGuardObjectKind::SUBLAYER, version));
        fake.objects.push_back(owned(LegacyGuardObjectKind::FILTER, version, version));
    }
    EXPECT_TRUE(network_guard_cleanup(fake.adapter, true).success);
    EXPECT_EQ(
            (std::vector{LegacyGuardObjectKind::FILTER, LegacyGuardObjectKind::FILTER, LegacyGuardObjectKind::SUBLAYER,
                    LegacyGuardObjectKind::SUBLAYER, LegacyGuardObjectKind::PROVIDER, LegacyGuardObjectKind::PROVIDER}),
            fake.deletion_order);
}

TEST(WindowsNetworkGuardTest, MixedPermitBlockFailureRetainsEveryPermitRegardlessOfEnumerationOrder) {
    for (bool permit_first : {false, true}) {
        FakeCleanup fake;
        auto permit = owned(LegacyGuardObjectKind::FILTER, 1, 10, false);
        auto block = owned(LegacyGuardObjectKind::FILTER, 1, 20, true);
        fake.objects = permit_first ? std::vector{permit, block} : std::vector{block, permit};
        fake.objects.push_back(owned(LegacyGuardObjectKind::SUBLAYER, 1));
        fake.objects.push_back(owned(LegacyGuardObjectKind::PROVIDER, 1));
        fake.failed_filter_ids.insert(20);
        auto result = network_guard_cleanup(fake.adapter, true);
        EXPECT_FALSE(result.success);
        EXPECT_TRUE(result.armed);
        EXPECT_EQ((std::vector<uint64_t>{20}), fake.deleted_filter_ids);
        EXPECT_EQ(4, fake.objects.size());
        EXPECT_EQ(1, fake.deletion_order.size());
    }
}

TEST(WindowsNetworkGuardTest, PartialBlockFailureCannotRemoveCorePermitsOrMetadataInEitherNamespace) {
    FakeCleanup fake;
    fake.objects = {owned(LegacyGuardObjectKind::FILTER, 1, 10, false), owned(LegacyGuardObjectKind::FILTER, 1, 20),
            owned(LegacyGuardObjectKind::FILTER, 2, 30), owned(LegacyGuardObjectKind::FILTER, 2, 40, false),
            owned(LegacyGuardObjectKind::SUBLAYER, 1), owned(LegacyGuardObjectKind::PROVIDER, 2)};
    fake.failed_filter_ids.insert(30);
    auto result = network_guard_cleanup(fake.adapter, true);
    EXPECT_FALSE(result.success);
    EXPECT_TRUE(result.armed);
    EXPECT_EQ((std::vector<uint64_t>{20, 30}), fake.deleted_filter_ids);
    ASSERT_EQ(5, fake.objects.size());
    EXPECT_EQ(2, std::count_if(fake.objects.begin(), fake.objects.end(), [](const auto &object) {
        return object.kind == LegacyGuardObjectKind::FILTER && !object.blocking;
    }));
}

TEST(WindowsNetworkGuardTest, FailedBlockVerificationRetainsAllPermitsAndMetadata) {
    FakeCleanup fake;
    fake.objects = {owned(LegacyGuardObjectKind::FILTER, 1, 10, false), owned(LegacyGuardObjectKind::FILTER, 1, 20),
            owned(LegacyGuardObjectKind::SUBLAYER, 1), owned(LegacyGuardObjectKind::PROVIDER, 1)};
    fake.verification_failure = true;
    auto result = network_guard_cleanup(fake.adapter, true);
    EXPECT_FALSE(result.success);
    EXPECT_TRUE(result.armed);
    EXPECT_EQ((std::vector<uint64_t>{20}), fake.deleted_filter_ids);
    EXPECT_EQ(3, fake.objects.size());
}

TEST(WindowsNetworkGuardTest, IncompleteInitialEnumerationRetainsPermitsEvenAfterKnownBlocksAreRemoved) {
    FakeCleanup fake;
    fake.objects = {owned(LegacyGuardObjectKind::FILTER, 1, 10, false), owned(LegacyGuardObjectKind::FILTER, 1, 20),
            owned(LegacyGuardObjectKind::SUBLAYER, 1)};
    fake.enumeration_failure = true;
    auto result = network_guard_cleanup(fake.adapter, true);
    EXPECT_FALSE(result.success);
    EXPECT_TRUE(result.armed);
    EXPECT_EQ((std::vector<uint64_t>{20}), fake.deleted_filter_ids);
    EXPECT_EQ(2, fake.objects.size());
}

TEST(WindowsNetworkGuardTest, BlockAppearingAtVerificationRetainsPermitsAndMetadata) {
    FakeCleanup fake;
    fake.objects = {owned(LegacyGuardObjectKind::FILTER, 1, 10, false), owned(LegacyGuardObjectKind::FILTER, 1, 20),
            owned(LegacyGuardObjectKind::SUBLAYER, 1)};
    auto real_inspect = fake.adapter.inspect;
    fake.adapter.inspect = [&] {
        if (fake.inspections == 1) {
            fake.objects.push_back(owned(LegacyGuardObjectKind::FILTER, 2, 30));
        }
        return real_inspect();
    };
    auto result = network_guard_cleanup(fake.adapter, true);
    EXPECT_FALSE(result.success);
    EXPECT_TRUE(result.armed);
    EXPECT_EQ((std::vector<uint64_t>{20}), fake.deleted_filter_ids);
    EXPECT_EQ(3, fake.objects.size());
}

TEST(WindowsNetworkGuardTest, SuccessfulBlockRemovalIsVerifiedBeforeAnyPermitIsRemoved) {
    FakeCleanup fake;
    fake.objects = {owned(LegacyGuardObjectKind::FILTER, 1, 10, false), owned(LegacyGuardObjectKind::FILTER, 2, 30),
            owned(LegacyGuardObjectKind::FILTER, 1, 20), owned(LegacyGuardObjectKind::FILTER, 2, 40, false)};
    bool removed_permit_before_verification = false;
    auto real_remove = fake.adapter.remove;
    fake.adapter.remove = [&](const auto &object) {
        if (object.kind == LegacyGuardObjectKind::FILTER && !object.blocking && fake.inspections < 2) {
            removed_permit_before_verification = true;
        }
        return real_remove(object);
    };
    auto result = network_guard_cleanup(fake.adapter, true);
    EXPECT_TRUE(result.success);
    EXPECT_FALSE(result.armed);
    EXPECT_FALSE(removed_permit_before_verification);
    EXPECT_EQ((std::vector<uint64_t>{30, 20, 10, 40}), fake.deleted_filter_ids);
}

TEST(WindowsNetworkGuardTest, ForeignNamespaceOrOwnerNeverGetsDeleted) {
    for (int mismatch = 0; mismatch < 7; ++mismatch) {
        FakeCleanup fake;
        auto foreign = owned(LegacyGuardObjectKind::FILTER, 1);
        switch (mismatch) {
        case 0:
            foreign.version = 3;
            break;
        case 1:
            foreign.provider_key_matches = false;
            break;
        case 2:
            foreign.sublayer_key_matches = false;
            break;
        case 3:
            foreign.object_key_matches = false;
            break;
        case 4:
            foreign.owner_data = "AnotherProduct";
            break;
        case 5:
            foreign.owner_data = "TrustTunnelClientPro.NetworkGuard.1";
            break;
        case 6:
            foreign.owner_data = "TrustTunnelClientPro.NetworkGuard.2" + std::string(1, '\0');
            break;
        }
        fake.objects = {foreign};
        auto result = network_guard_cleanup(fake.adapter, true);
        EXPECT_TRUE(result.success) << mismatch;
        EXPECT_FALSE(result.armed) << mismatch;
        EXPECT_TRUE(fake.deletion_order.empty()) << mismatch;
        EXPECT_EQ(1, fake.objects.size()) << mismatch;
    }
}

TEST(WindowsNetworkGuardTest, ForeignReferencesMayRetainMetadataWithoutRestoringRemovedBlocks) {
    FakeCleanup fake;
    fake.objects = {owned(LegacyGuardObjectKind::FILTER, 1), owned(LegacyGuardObjectKind::PROVIDER, 1),
            owned(LegacyGuardObjectKind::SUBLAYER, 1)};
    fake.metadata_failure = true;
    auto result = network_guard_cleanup(fake.adapter, true);
    EXPECT_FALSE(result.success);
    EXPECT_FALSE(result.armed);
    EXPECT_STREQ("network-guard-cleanup-incomplete", result.error);
    EXPECT_EQ(2, fake.objects.size());
}

TEST(WindowsNetworkGuardTest, OneFailedDeletionDoesNotRollBackOrSkipOtherOwnedFilters) {
    FakeCleanup fake;
    fake.objects = {owned(LegacyGuardObjectKind::FILTER, 1, 1), owned(LegacyGuardObjectKind::FILTER, 1, 2),
            owned(LegacyGuardObjectKind::FILTER, 2, 3)};
    fake.failed_filter_ids.insert(1);
    auto result = network_guard_cleanup(fake.adapter, true);
    EXPECT_FALSE(result.success);
    EXPECT_TRUE(result.armed);
    ASSERT_EQ(1, fake.objects.size());
    EXPECT_EQ(1, fake.objects.front().filter_id);
    fake.failed_filter_ids.clear();
    EXPECT_TRUE(network_guard_cleanup(fake.adapter, true).success);
}

TEST(WindowsNetworkGuardTest, EnumerationFailureStillRemovesPositivelyIdentifiedPartialResults) {
    FakeCleanup fake;
    fake.objects = {owned(LegacyGuardObjectKind::FILTER, 1)};
    fake.enumeration_failure = true;
    auto result = network_guard_cleanup(fake.adapter, true);
    EXPECT_FALSE(result.success);
    EXPECT_TRUE(result.armed);
    EXPECT_TRUE(fake.objects.empty());
}

TEST(WindowsNetworkGuardTest, FailedVerificationNeverReportsUnqualifiedSuccess) {
    FakeCleanup fake;
    fake.objects = {owned(LegacyGuardObjectKind::FILTER, 1)};
    fake.verification_failure = true;
    auto result = network_guard_cleanup(fake.adapter, true);
    EXPECT_FALSE(result.success);
    EXPECT_TRUE(result.armed);
}

TEST(WindowsNetworkGuardTest, MetadataRequiresAnExactMarkerButFiltersAllowStoredPolicyTail) {
    for (auto kind :
            {LegacyGuardObjectKind::FILTER, LegacyGuardObjectKind::SUBLAYER, LegacyGuardObjectKind::PROVIDER}) {
        auto object = owned(kind, 2);
        EXPECT_TRUE(network_guard_legacy_object_owned(object));
        object.owner_data += "trailing policy bytes";
        EXPECT_EQ(kind == LegacyGuardObjectKind::FILTER, network_guard_legacy_object_owned(object));
    }
}

TEST(WindowsNetworkGuardTest, FastCleanupCancelsWatchdogWithoutEarlyTimeoutOrWaitingForDeadline) {
    std::atomic_int timeouts = 0;
    const auto caller = std::this_thread::get_id();
    const auto start = std::chrono::steady_clock::now();
    auto result = network_guard_cleanup_with_deadline(
            std::chrono::seconds(2),
            [&] {
                EXPECT_EQ(caller, std::this_thread::get_id());
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
                EXPECT_EQ(0, timeouts.load());
                return NetworkGuardResult{true, false, nullptr};
            },
            [&] {
                ++timeouts;
            });
    EXPECT_TRUE(result.success);
    EXPECT_EQ(0, timeouts.load());
    EXPECT_LT(std::chrono::steady_clock::now() - start, std::chrono::seconds(1));
}

TEST(WindowsNetworkGuardTest, HungFakeCleanupTriggersExactlyOneDeadlineOnAnotherThread) {
    std::mutex mutex;
    std::condition_variable released;
    std::atomic_int timeouts = 0;
    const auto caller = std::this_thread::get_id();
    std::thread::id timeout_thread;
    const auto start = std::chrono::steady_clock::now();
    auto result = network_guard_cleanup_with_deadline(
            std::chrono::milliseconds(30),
            [&] {
                std::unique_lock lock(mutex);
                const bool fired = released.wait_for(lock, std::chrono::seconds(2), [&] {
                    return timeouts.load() > 0;
                });
                EXPECT_TRUE(fired);
                return NetworkGuardResult{false, true, "fake-action-timeout"};
            },
            [&] {
                {
                    std::lock_guard lock(mutex);
                    timeout_thread = std::this_thread::get_id();
                    ++timeouts;
                }
                released.notify_one();
            });
    EXPECT_FALSE(result.success);
    EXPECT_EQ(1, timeouts.load());
    EXPECT_NE(caller, timeout_thread);
    EXPECT_GE(std::chrono::steady_clock::now() - start, std::chrono::milliseconds(20));
    EXPECT_LT(std::chrono::steady_clock::now() - start, std::chrono::seconds(1));
}

TEST(WindowsNetworkGuardTest, FailingOrThrowingCleanupCancelsDeadlineAndJoinsOnlyWatchdog) {
    std::atomic_int timeouts = 0;
    auto result = network_guard_cleanup_with_deadline(
            std::chrono::seconds(2),
            [] {
                return NetworkGuardResult{false, true, "fake-cleanup-failed"};
            },
            [&] {
                ++timeouts;
            });
    EXPECT_FALSE(result.success);
    EXPECT_EQ(0, timeouts.load());
    EXPECT_THROW(network_guard_cleanup_with_deadline(
                         std::chrono::seconds(2),
                         []() -> NetworkGuardResult {
                             throw std::runtime_error("fake failure");
                         },
                         [&] {
                             ++timeouts;
                         }),
            std::runtime_error);
    EXPECT_EQ(0, timeouts.load());
}

template <typename T>
concept HasArm = requires { &T::arm; };
template <typename T>
concept HasCreate = requires { &T::create; };

TEST(WindowsNetworkGuardTest, CleanupAPIHasNoArmingOrCreationOperation) {
    static_assert(!HasArm<WindowsNetworkGuard>);
    static_assert(!HasCreate<WindowsNetworkGuard>);
    static_assert(!HasArm<LegacyGuardCleanupAdapter>);
    static_assert(!HasCreate<LegacyGuardCleanupAdapter>);
    EXPECT_FALSE(HasArm<WindowsNetworkGuard>);
}

} // namespace
} // namespace ag
