#pragma once

#include <chrono>
#include <cstdint>
#include <functional>
#include <unordered_map>

#include "common/defs.h"
#include "vpn/event_loop.h"

namespace ag {

struct ConnectionStatistics {
    /** Connection ID */
    uint64_t id;
    /** Number of uploaded bytes since the last notification */
    uint64_t upload;
    /** Number of downloaded bytes since the last notification */
    uint64_t download;
};

class ConnectionStatisticsMonitor {
public:
    using Handler = std::function<void(ConnectionStatistics)>;

    static constexpr auto DEFAULT_THROTTLING_PERIOD = Millis{100};
    static constexpr uint64_t DEFAULT_THRESHOLD_BYTES = 100 * 1024;

    ConnectionStatisticsMonitor(VpnEventLoop *event_loop, Handler handler,
            Millis throttling_period = DEFAULT_THROTTLING_PERIOD, uint64_t threshold_bytes = DEFAULT_THRESHOLD_BYTES);

    ~ConnectionStatisticsMonitor() = default;

    ConnectionStatisticsMonitor(const ConnectionStatisticsMonitor &) = delete;
    ConnectionStatisticsMonitor &operator=(const ConnectionStatisticsMonitor &) = delete;
    ConnectionStatisticsMonitor(ConnectionStatisticsMonitor &&) = default;
    ConnectionStatisticsMonitor &operator=(ConnectionStatisticsMonitor &&) = default;

    /**
     * Start monitoring a connection
     */
    void register_conn(uint64_t id);
    /**
     * Stop monitoring a connection
     * @param do_report if true and there are unreported statistics, it will be raised via handler
     */
    void unregister_conn(uint64_t id, bool do_report);
    /**
     * Increase downloaded bytes counter
     */
    void update_download(uint64_t id, uint64_t inc);
    /**
     * Increase uploaded bytes counter
     */
    void update_upload(uint64_t id, uint64_t inc);

private:
    struct Statistics {
        uint64_t upload = 0;
        uint64_t download = 0;
        timeval raise_not_before = {};
    };

    std::unordered_map<uint64_t, Statistics> m_stats;
    VpnEventLoop *m_event_loop;
    Millis m_throttling_period;
    uint64_t m_threshold_bytes;
    Handler m_handler;

    [[nodiscard]] bool should_be_notified(const Statistics &stats) const;
    void raise_stats(uint64_t id, Statistics &stats);
};

} // namespace ag
