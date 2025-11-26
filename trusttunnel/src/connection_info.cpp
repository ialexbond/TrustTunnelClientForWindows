#include "vpn/trusttunnel/connection_info.h"

#include <nlohmann/json.hpp>
#include <magic_enum/magic_enum.hpp>

namespace ag {

std::string ConnectionInfo::to_json(VpnConnectionInfoEvent *info) {
    nlohmann::json json;
    json["proto"] = info->proto == IPPROTO_TCP ? "TCP" : "UDP";
    if (info->src) {
        json["src"] = SocketAddress(*info->src).str();
    }
    if (info->dst) {
        json["dst"] = SocketAddress(*info->dst).str();
    }
    if (info->domain) {
        json["domain"] = info->domain;
    }
    json["action"] = magic_enum::enum_name(info->action);

    return json.dump();
}

} // namespace ag
