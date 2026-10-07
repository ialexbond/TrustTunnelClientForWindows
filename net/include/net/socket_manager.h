#pragma once

namespace ag {

struct SocketManager;

/**
 * Create a socket manager
 */
SocketManager *socket_manager_create();

/**
 * Destroy a socket manager
 */
void socket_manager_destroy(SocketManager *manager);

/**
 * Complete all registered pending events
 */
void socket_manager_complete_all(SocketManager *manager);

} // namespace ag
