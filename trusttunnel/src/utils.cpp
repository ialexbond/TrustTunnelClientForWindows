#include "utils.h"

#include <magic_enum/magic_enum.hpp>

namespace ag {

static Logger g_logger("TrustTunnelCliUtils");

std::optional<ag::LogLevel> TrustTunnelCliUtils::parse_loglevel(std::string_view level) {
    static const std::unordered_map<std::string_view, ag::LogLevel> LOG_LEVEL_MAP = {
            {"error", ag::LOG_LEVEL_ERROR},
            {"warn", ag::LOG_LEVEL_WARN},
            {"info", ag::LOG_LEVEL_INFO},
            {"debug", ag::LOG_LEVEL_DEBUG},
            {"trace", ag::LOG_LEVEL_TRACE},
    };

    if (auto it = LOG_LEVEL_MAP.find(level); it != LOG_LEVEL_MAP.end()) {
        return it->second;
    }
    return std::nullopt;
}

bool TrustTunnelCliUtils::apply_cmd_args(TrustTunnelConfig &config, const cxxopts::ParseResult &args) {
    if (args.count("s") > 0) {
        bool x = args["s"].as<bool>();
        if (x != config.location.skip_verification) {
            infolog(g_logger, "Skip verification value was overwritten: old={}, new={}",
                    config.location.skip_verification, x);
        }
        config.location.skip_verification = x;
    }
    if (args.count("loglevel") > 0) {
        if (auto loglevel = parse_loglevel(args["loglevel"].as<std::string>())) {
            if (loglevel != config.loglevel) {
                infolog(g_logger, "Log Level value was overwritten: old={}, new={}",
                        magic_enum::enum_name(config.loglevel), magic_enum::enum_name(*loglevel));
                config.loglevel = *loglevel;
            }
        } else {
            errlog(g_logger, "Unexpected log level: {}", args["loglevel"].as<std::string>());
            return false;
        }
    }
    return true;
}

void TrustTunnelCliUtils::detect_bound_if(TrustTunnelConfig &config) {
    if (!std::holds_alternative<TrustTunnelConfig::TunListener>(config.listener)) {
        return;
    }
    auto &tun = std::get<TrustTunnelConfig::TunListener>(config.listener);
    if (!tun.bound_if.empty()) {
        return;
    }
#ifdef __linux__
    constexpr std::string_view CMD = "ip -o route show to default";
    infolog(g_logger, "{} {}", (geteuid() == 0) ? '#' : '$', CMD);
    Result result = tunnel_utils::fsystem_with_output(CMD);
    if (result.has_error()) {
        errlog(g_logger, "Failed to detect outbound interface automatically: {}", result.error()->str());
        return;
    }

    dbglog(g_logger, "Detect command output: {}", result.value());
    std::vector parts = utils::split_by(result.value(), ' ');
    auto found = std::find(parts.begin(), parts.end(), "dev");
    if (found == parts.end() || std::next(found) == parts.end()) {
        warnlog(g_logger, "Failed to detect outbound interface name");
        return;
    }
    tun.bound_if = *std::next(found);
#endif
#ifdef _WIN32
    uint32_t if_index = vpn_win_detect_active_if();
    if (if_index == 0) {
        warnlog(g_logger, "Failed to detect active network interface");
        return;
    }
    char if_name[IF_NAMESIZE]{};
    if_indextoname(if_index, if_name);
    tun.bound_if = if_name;
#endif // _WIN32
#ifdef __APPLE__
    tun.bound_if = "en0";
#endif // __APPLE__
    infolog(g_logger, "Using automatically detected outbound interface: {}", tun.bound_if);
}

} // namespace ag
