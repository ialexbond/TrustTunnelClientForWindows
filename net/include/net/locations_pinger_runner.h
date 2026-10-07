#pragma once

#include "net/locations_pinger.h"
#include "vpn/platform.h"

namespace ag {

/**
 * Helper entity which can be used for running a locations pinger in a standalone manner, without
 * a need for creating an event base loop.
 */
struct LocationsPingerRunner;

extern "C" {

/**
 * Create a locations pinger runner
 * @param info the pinger info
 * @param handler the pinger handler
 */
WIN_EXPORT LocationsPingerRunner *locations_pinger_runner_create(
        const LocationsPingerInfo *info, LocationsPingerHandler handler);

/**
 * Starts given locations ping. Runs synchronously until `stop` is called or all the locations are pinged.
 */
WIN_EXPORT void locations_pinger_runner_run(LocationsPingerRunner *runner);

/**
 * Free resources. Also stops pinging if running.
 */
WIN_EXPORT void locations_pinger_runner_free(LocationsPingerRunner *runner);

} // extern "C"
} // namespace ag
