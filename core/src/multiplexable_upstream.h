#pragma once

#include <cassert>

#include "vpn/internal/server_upstream.h"

namespace ag {

/**
 * Extends `ServerUpstream` to make it usable by `upstream_multiplexer_t`
 */
class MultiplexableUpstream : public ServerUpstream {
public:
    MultiplexableUpstream(
            const VpnUpstreamProtocolConfig &protocol_config, int id, VpnClient *vpn, ServerHandler handler)
            : ServerUpstream(id, protocol_config)
            , m_id(id) {
        if (!ServerUpstream::init(vpn, handler)) {
            assert(0);
        }
    }

    ~MultiplexableUpstream() override = default;

    /**
     * Get total number of current connections
     */
    [[nodiscard]] virtual size_t connections_num() const = 0;

    /**
     * Create connection to peer. Result will be raised asynchronously with
     * `SERVER_EVENT_CONNECTION_OPENED` in case of success, or with `SERVER_EVENT_ERROR` in case of
     * error.
     * @param id the connection identifier
     * @param addr source and destination address pair
     * @param proto connection protocol
     * @param app_name name of the application that initiated this connection (optional)
     * @return true in case of success, false otherwise
     */
    [[nodiscard]] virtual bool open_connection(
            uint64_t id, const TunnelAddressPair *addr, int proto, std::string_view app_name) = 0;

    /**
     * Get upstream identifier
     */
    [[nodiscard]] int get_id() const {
        return m_id;
    }

    virtual void do_health_check() override {
        do_health_check(true);
    }

    virtual void do_health_check(bool need_result) = 0;

protected:
    int m_id = 0;

private:
    void deinit() final {
    }

    uint64_t open_connection(const TunnelAddressPair *, int, std::string_view) final {
        return NON_ID;
    }
};

} // namespace ag
