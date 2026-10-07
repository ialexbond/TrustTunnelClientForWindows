#pragma once

#include <optional>
#include <string_view>
#include <vector>

#include "vpn/internal/server_upstream.h"
#include "vpn/internal/vpn_client.h"
#include "vpn/platform.h"

namespace ag {

struct HttpIcmpMultiplexerParameters {
    ServerUpstream *parent = nullptr;
    /** @return stream id if sent successfully, none otherwise */
    std::optional<uint64_t> (*send_connect_request_callback)(
            ServerUpstream *upstream, const TunnelAddress *dst_addr, std::string_view app_name) = nullptr;
    /** @return 0 in case of success, non-zero value otherwise */
    int (*send_data_callback)(ServerUpstream *upstream, uint64_t stream_id, U8View data) = nullptr;
    void (*consume_callback)(ServerUpstream *upstream, uint64_t stream_id, size_t size) = nullptr;
};

/**
 * Multiplexes ICMP traffic into a single HTTP stream
 */
class HttpIcmpMultiplexer {
public:
    explicit HttpIcmpMultiplexer(HttpIcmpMultiplexerParameters parameters);
    ~HttpIcmpMultiplexer();

    HttpIcmpMultiplexer() = delete;
    HttpIcmpMultiplexer(const HttpIcmpMultiplexer &) = delete;
    HttpIcmpMultiplexer &operator=(const HttpIcmpMultiplexer &) = delete;
    HttpIcmpMultiplexer(HttpIcmpMultiplexer &&) = delete;
    HttpIcmpMultiplexer &operator=(HttpIcmpMultiplexer &&) = delete;

    /**
     * Close multiplexer
     */
    void close();

    /**
     * @brief Get id of stream which is currently used for ICMP traffic
     */
    [[nodiscard]] std::optional<uint64_t> get_stream_id() const;

    /**
     * Send an ICMP request
     */
    bool send_request(const IcmpEchoRequest &request);

    /**
     * Process data from VPN endpoint
     * @return 0 if successful
     */
    int process_read_event(U8View data);

    /**
     * Handle response to stream creation request
     */
    void handle_response(const HttpHeaders *response);

private:
    enum State : uint32_t;

    HttpIcmpMultiplexerParameters m_params = {};
    State m_state = (State) 0;
    std::optional<uint64_t> m_stream_id;
    std::vector<uint8_t> m_reply_buffer;

    bool send_request_established(const IcmpEchoRequest &request);
    U8View process_reply_chunk(U8View data);
};

} // namespace ag
