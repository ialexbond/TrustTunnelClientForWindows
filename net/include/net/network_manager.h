#pragma once

#include <string>
#include <vector>

#include "net/dns_manager.h"
#include "net/socket_manager.h"
#include "vpn/utils.h"

namespace ag {

/**
 * Network manager of VPN client operations
 */
struct VpnNetworkManager {
    DnsManager *dns;       // DNS manager (optional: needed only for the SOCKS listener)
    SocketManager *socket; // Socket manager
};

/**
 * Get a network manager
 */
VpnNetworkManager *vpn_network_manager_get();

/**
 * Destroy a network manager
 */
void vpn_network_manager_destroy(VpnNetworkManager *m);

/**
 * Update system DNS servers
 */
bool vpn_network_manager_update_system_dns(SystemDnsServers servers);

/**
 * Notify that a domain is about to be queried by an application
 * @param domain the domain name
 * @param timeout_ms the amount of time after which the record will be forgotten (negative means default)
 */
extern "C" WIN_EXPORT void vpn_network_manager_notify_app_request_domain(const char *domain, int timeout_ms);

/**
 * Check whether a domain belongs to queries from an application
 */
bool vpn_network_manager_check_app_request_domain(const char *domain);

/**
 * Set the outbound interface that will be used for outgoing connections. This is required to prevent
 * the VPN's own traffic from being routed into the VPN. The argument should normally be the index of
 * the default interface that the system would use for Internet connections.
 *
 * [Windows] The current default interface used for Internet connections can be found with `vpn_win_detect_active_if()`.
 * This function must be called with the correct interface index before creating a VPN instance with `vpn_open`.
 * If the outbound interface changes when a VPN instance is already running, this function must be called with
 * the new outbound interface _before_ notifying the running VPN instance about the network change with
 * `vpn_notify_network_change`.
 *
 * @param idx The outbound interface index. If zero, the system default routing will be used.
 */
extern "C" WIN_EXPORT void vpn_network_manager_set_outbound_interface(uint32_t idx);

/**
 * Get the outbound interface for outgoing connections
 */
uint32_t vpn_network_manager_get_outbound_interface();

} // namespace ag
