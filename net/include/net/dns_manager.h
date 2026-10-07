#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "net/utils.h"
#include "vpn/event_loop.h"

namespace ag {

struct DnsManager;
using DnsChangeSubscriptionId = uint32_t;

using DnsChangeNotification = void (*)(void *arg);

/**
 * Create a DNS manager
 */
DnsManager *dns_manager_create();

/**
 * Destroy a DNS manager
 */
void dns_manager_destroy(DnsManager *manager);

/**
 * Set DNS servers to be used by the manager
 * @param servers the servers
 * @return true if set successfully, false otherwise
 */
bool dns_manager_set_system_servers(DnsManager *manager, SystemDnsServers servers);

/**
 * Get the system DNS servers used by the manager
 */
SystemDnsServers dns_manager_get_system_servers(const DnsManager *manager);

/**
 * Subscribe to DNS servers change event.
 * The `notification` is raised through the `event_loop`.
 * @return Subscription ID
 */
DnsChangeSubscriptionId dns_manager_subscribe_servers_change(
        DnsManager *manager, VpnEventLoop *event_loop, DnsChangeNotification notification, void *notification_arg);

/**
 * Cancel the DNS servers change subscription
 */
void dns_manager_unsubscribe_servers_change(DnsManager *manager, DnsChangeSubscriptionId subscription_id);

} // namespace ag
