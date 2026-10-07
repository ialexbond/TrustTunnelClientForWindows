#include <utility>

#include <event2/util.h>

#include "connection_statistics.h"
#include "vpn/utils.h"

namespace ag {

ConnectionStatisticsMonitor::ConnectionStatisticsMonitor(
        VpnEventLoop *event_loop, Handler handler, Millis throttling_period, uint64_t threshold_bytes)
        : m_event_loop(event_loop)
        , m_throttling_period(throttling_period)
        , m_threshold_bytes(threshold_bytes)
        , m_handler(std::move(handler)) {
}

void ConnectionStatisticsMonitor::register_conn(uint64_t id) {
    timeval now;
    event_base_gettimeofday_cached(vpn_event_loop_get_base(m_event_loop), &now);

    timeval period = ms_to_timeval(m_throttling_period.count());
    auto &stats = m_stats.emplace(id, Statistics{}).first->second;
    evutil_timeradd(&now, &period, &stats.raise_not_before);
}

void ConnectionStatisticsMonitor::unregister_conn(uint64_t id, bool do_report) {
    auto node = m_stats.extract(id);
    if (!do_report || node.empty()) {
        return;
    }

    const Statistics &stats = node.mapped();
    if (0 < stats.upload && 0 < stats.download) {
        raise_stats(id, node.mapped());
    }
}

void ConnectionStatisticsMonitor::update_download(uint64_t id, uint64_t inc) {
    auto iter = m_stats.find(id);
    if (iter == m_stats.end()) {
        return;
    }

    Statistics &stats = iter->second;
    stats.download += inc;
    if (should_be_notified(stats)) {
        raise_stats(id, stats);
    }
}

void ConnectionStatisticsMonitor::update_upload(uint64_t id, uint64_t inc) {
    auto iter = m_stats.find(id);
    if (iter == m_stats.end()) {
        return;
    }

    Statistics &stats = iter->second;
    stats.upload += inc;
    if (should_be_notified(stats)) {
        raise_stats(id, stats);
    }
}

bool ConnectionStatisticsMonitor::should_be_notified(const Statistics &stats) const {
    if (stats.upload < m_threshold_bytes && stats.download < m_threshold_bytes) {
        return false;
    }

    timeval now;
    event_base_gettimeofday_cached(vpn_event_loop_get_base(m_event_loop), &now);
    return evutil_timercmp(&now, &stats.raise_not_before, >);
}

void ConnectionStatisticsMonitor::raise_stats(uint64_t id, Statistics &stats) {
    timeval now;
    event_base_gettimeofday_cached(vpn_event_loop_get_base(m_event_loop), &now);
    timeval period = ms_to_timeval(m_throttling_period.count());
    evutil_timeradd(&now, &period, &stats.raise_not_before);

    m_handler(ConnectionStatistics{
            .id = id,
            .upload = std::exchange(stats.upload, 0),
            .download = std::exchange(stats.download, 0),
    });
}

} // namespace ag
