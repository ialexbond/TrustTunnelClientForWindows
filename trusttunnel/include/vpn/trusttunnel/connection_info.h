#pragma once

#include "vpn/vpn.h"

#include <string>

namespace ag {

class ConnectionInfo {
public:
    static std::string to_json(VpnConnectionInfoEvent *info);
};

} // namespace ag
