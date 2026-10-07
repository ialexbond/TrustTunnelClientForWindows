#pragma once

#include <event2/event.h>

#include "tcpip_common.h"

namespace ag {

/**
 * Initialize libevent LWIP port
 * @param base Event base
 * @return ERR_OK if success, ERR_ALREADY if LWIP was already initialized
 */
int libevent_lwip_init(TcpipCtx *ctx);

/**
 * Deinitialize libevent LWIP port
 */
void libevent_lwip_free();

} // namespace ag
