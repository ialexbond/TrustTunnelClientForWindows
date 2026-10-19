#include <algorithm>
#include <cstddef>
#include <cstring>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include <magic_enum/magic_enum.hpp>

#include "common/logger.h"
#include "common/net_utils.h"
#include "common/utils.h"
#include "net/network_manager.h"
#include "net/os_tunnel.h"
#include "net/tls.h"
#include "net/utils.h"
#include "process_socket_owner.h"
#include "vpn/trusttunnel/client.h"
#include "vpn/trusttunnel/config.h"
#include "vpn/vpn.h"

#ifdef _WIN32
#include <iphlpapi.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#endif

namespace ag {

#ifdef _WIN32
static std::string pid_to_exe_name(DWORD pid) {
    // Resolve each time: PIDs can be reused, and failed lookups may succeed later.
    std::string result;
    HANDLE hProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (hProcess != nullptr) {
        wchar_t path[MAX_PATH] = {};
        DWORD path_len = MAX_PATH;
        if (QueryFullProcessImageNameW(hProcess, 0, path, &path_len)) {
            int needed =
                    WideCharToMultiByte(CP_UTF8, 0, path, static_cast<int>(path_len), nullptr, 0, nullptr, nullptr);
            if (needed > 0) {
                result.resize(static_cast<size_t>(needed));
                WideCharToMultiByte(
                        CP_UTF8, 0, path, static_cast<int>(path_len), result.data(), needed, nullptr, nullptr);
            }
        }
        CloseHandle(hProcess);
    }

    return result;
}

static ProcessSocketAddress owner_socket_address(
        ProcessSocketFamily family, const void *address, DWORD port, DWORD scope = 0) {
    ProcessSocketAddress result{family};
    std::memcpy(result.address.data(), address, family == ProcessSocketFamily::IPV4 ? 4 : 16);
    result.port = ntohs(static_cast<uint16_t>(port));
    result.scope = scope;
    return result;
}

static ProcessSocketAddress owner_socket_address(const sockaddr *address) {
    if (address != nullptr && address->sa_family == AF_INET) {
        const auto *v4 = reinterpret_cast<const sockaddr_in *>(address);
        return owner_socket_address(ProcessSocketFamily::IPV4, &v4->sin_addr, v4->sin_port);
    }
    if (address != nullptr && address->sa_family == AF_INET6) {
        const auto *v6 = reinterpret_cast<const sockaddr_in6 *>(address);
        return owner_socket_address(ProcessSocketFamily::IPV6, &v6->sin6_addr, v6->sin6_port, v6->sin6_scope_id);
    }
    return {};
}

// Table size can grow between calls; a failed/truncated snapshot stays unknown.
static std::vector<uint8_t> read_process_socket_table(ULONG family, ProcessSocketProtocol protocol) {
    auto read = [&](void *buffer, DWORD *size) {
        return protocol == ProcessSocketProtocol::TCP
                ? GetExtendedTcpTable(buffer, size, FALSE, family, TCP_TABLE_OWNER_PID_ALL, 0)
                : GetExtendedUdpTable(buffer, size, FALSE, family, UDP_TABLE_OWNER_PID, 0);
    };
    for (int attempt = 0; attempt < 3; ++attempt) {
        DWORD size = 0;
        DWORD error = read(nullptr, &size);
        if (error != ERROR_INSUFFICIENT_BUFFER || size < sizeof(DWORD)) {
            return {};
        }
        std::vector<uint8_t> buffer(size);
        error = read(buffer.data(), &size);
        if (error == ERROR_INSUFFICIENT_BUFFER) {
            continue;
        }
        if (error != NO_ERROR || size > buffer.size() || size < sizeof(DWORD)) {
            return {};
        }
        buffer.resize(size);
        return buffer;
    }
    return {};
}

template <typename Table, typename Convert>
static std::vector<ProcessSocketOwner> process_socket_rows(const std::vector<uint8_t> &buffer, Convert convert) {
    constexpr size_t HEADER_SIZE = offsetof(Table, table);
    if (buffer.size() < HEADER_SIZE) {
        return {};
    }
    const auto *table = reinterpret_cast<const Table *>(buffer.data());
    if (table->dwNumEntries > (buffer.size() - HEADER_SIZE) / sizeof(table->table[0])) {
        return {};
    }
    std::vector<ProcessSocketOwner> result;
    result.reserve(table->dwNumEntries);
    for (DWORD i = 0; i < table->dwNumEntries; ++i) {
        result.push_back(convert(table->table[i]));
    }
    return result;
}

static std::string resolve_app_name_from_socket(
        const sockaddr *src, const VpnAddress *dst, int proto, ProcessSocketContext context) {
    ProcessSocketAddress source = owner_socket_address(src);
    ProcessSocketProtocol protocol = proto == IPPROTO_TCP ? ProcessSocketProtocol::TCP
            : proto == IPPROTO_UDP                       ? ProcessSocketProtocol::UDP
                                                       : ProcessSocketProtocol::UNKNOWN;
    auto family = process_socket_table_family(source, protocol);
    if (!family) {
        return {};
    }
    std::optional<ProcessSocketAddress> destination;
    if (dst != nullptr && dst->type == VPN_AT_ADDR) {
        destination = owner_socket_address(reinterpret_cast<const sockaddr *>(&dst->addr));
    }
    if (protocol == ProcessSocketProtocol::TCP && context == ProcessSocketContext::TUN && !destination) {
        return {};
    }
    const auto buffer = read_process_socket_table(
            *family == ProcessSocketFamily::IPV4 ? AF_INET : AF_INET6, protocol);
    std::vector<ProcessSocketOwner> rows;
    if (protocol == ProcessSocketProtocol::TCP && *family == ProcessSocketFamily::IPV4) {
        rows = process_socket_rows<MIB_TCPTABLE_OWNER_PID>(buffer, [](const auto &row) {
            return ProcessSocketOwner{
                    owner_socket_address(ProcessSocketFamily::IPV4, &row.dwLocalAddr, row.dwLocalPort),
                    owner_socket_address(ProcessSocketFamily::IPV4, &row.dwRemoteAddr, row.dwRemotePort), row.dwOwningPid};
        });
    } else if (protocol == ProcessSocketProtocol::TCP) {
        rows = process_socket_rows<MIB_TCP6TABLE_OWNER_PID>(buffer, [](const auto &row) {
            return ProcessSocketOwner{
                    owner_socket_address(ProcessSocketFamily::IPV6, row.ucLocalAddr, row.dwLocalPort, row.dwLocalScopeId),
                    owner_socket_address(ProcessSocketFamily::IPV6, row.ucRemoteAddr, row.dwRemotePort, row.dwRemoteScopeId),
                    row.dwOwningPid};
        });
    } else if (*family == ProcessSocketFamily::IPV4) {
        rows = process_socket_rows<MIB_UDPTABLE_OWNER_PID>(buffer, [](const auto &row) {
            return ProcessSocketOwner{
                    owner_socket_address(ProcessSocketFamily::IPV4, &row.dwLocalAddr, row.dwLocalPort), {}, row.dwOwningPid};
        });
    } else {
        rows = process_socket_rows<MIB_UDP6TABLE_OWNER_PID>(buffer, [](const auto &row) {
            return ProcessSocketOwner{
                    owner_socket_address(ProcessSocketFamily::IPV6, row.ucLocalAddr, row.dwLocalPort, row.dwLocalScopeId),
                    {}, row.dwOwningPid};
        });
    }
    uint32_t pid = select_process_socket_owner(source, destination, protocol, rows, context);
    return pid == 0 ? std::string{} : pid_to_exe_name(pid);
}
#endif

TrustTunnelClient::TrustTunnelClient(TrustTunnelConfig &&config, VpnCallbacks &&callbacks)
        : m_config(std::move(config))
        , m_extra_loop(vpn_event_loop_create())
        , m_callbacks(std::move(callbacks)) {
    // Parse process filter lists (newline-separated process names, case-insensitive)
    auto parse_process_list = [](const std::string &content) {
        std::unordered_set<std::string> result;
        std::istringstream stream(content);
        std::string line;
        while (std::getline(stream, line)) {
            auto start = line.find_first_not_of(" \t\r\n");
            auto end = line.find_last_not_of(" \t\r\n");
            if (start != std::string::npos) {
                std::string name = line.substr(start, end - start + 1);
                std::transform(name.begin(), name.end(), name.begin(), ::tolower);
                result.insert(std::move(name));
            }
        }
        return result;
    };
    m_process_direct = parse_process_list(m_config.process_direct);
    m_process_proxy = parse_process_list(m_config.process_proxy);
    m_process_block = parse_process_list(m_config.process_block);

    if (!m_process_direct.empty() || !m_process_proxy.empty() || !m_process_block.empty()) {
        infolog(m_logger, "Process filters: {} direct, {} proxy, {} block", m_process_direct.size(),
                m_process_proxy.size(), m_process_block.size());
    }

    if (!m_config.log_file_path.empty()) {
        m_logfile_handler.emplace(m_config.log_file_path);
        m_logtofile.emplace(m_logfile_handler->get_file());
        ag::Logger::set_callback(m_logtofile.value());
    }
    ag::Logger::set_log_level(m_config.loglevel);
    m_loop_thread = std::thread([loop = m_extra_loop.get()]() {
        vpn_event_loop_run(loop);
    });
};

TrustTunnelClient::~TrustTunnelClient() {
    vpn_event_loop_stop(m_extra_loop.get());
    if (m_loop_thread.joinable()) {
        m_loop_thread.join();
    }
}

Error<TrustTunnelClient::ConnectResultError> TrustTunnelClient::connect(ListenerSettings listener_settings) {
    return connect_impl(std::move(listener_settings));
}

int TrustTunnelClient::disconnect() {
    if (Vpn *vpn = m_vpn.exchange(nullptr)) {
        vpn_stop(vpn);
        // `_dispatch_sync` on a stopped loop blocks forever.
        // Call `_dispatch_sync` before `vpn_close` so handlers can observe a valid vpn pointer.
        if (vpn_event_loop_is_active(m_extra_loop.get())) {
            vpn_event_loop_dispatch_sync(m_extra_loop.get(), nullptr, nullptr);
        }
        vpn_close(vpn);
    }

    if (m_tunnel != nullptr) {
        std::exchange(m_tunnel, nullptr)->deinit();
    }

    return 0;
}

void TrustTunnelClient::notify_network_change(VpnNetworkState state) {
    if (m_vpn) {
        vpn_notify_network_change(m_vpn, state);
    }
}

void TrustTunnelClient::notify_sleep() {
    if (m_vpn) {
        vpn_notify_sleep(m_vpn, [](void *) {}, nullptr);
    }
}

void TrustTunnelClient::notify_wake() {
    if (m_vpn) {
        vpn_notify_wake(m_vpn);
    }
}

bool TrustTunnelClient::process_client_packets(VpnPackets packets) {
    return m_vpn && vpn_process_client_packets(m_vpn, packets);
}

Error<TrustTunnelClient::ConnectResultError> TrustTunnelClient::set_system_dns() {
#ifdef _WIN32
    uint32_t if_index = vpn_win_detect_active_if();
    if (if_index == 0) {
        return make_error(ConnectResultError{}, "Couldn't detect active network interface");
    }
    Result<SystemDnsServers, RetrieveInterfaceDnsError> result = retrieve_interface_dns_servers(if_index);
    if (result.has_error()) {
        return make_error(ConnectResultError{}, AG_FMT("Failed to collect DNS servers: {}", result.error()->str()));
    }
    if (!vpn_network_manager_update_system_dns(std::move(result.value()))) {
        return make_error(ConnectResultError{}, "Failed to update DNS servers");
    }
#elif !defined(__ANDROID__)
    Result<SystemDnsServers, RetrieveSystemDnsError> result = utils::retrieve_system_dns_servers();
    if (result.has_error()) {
        return make_error(ConnectResultError{}, AG_FMT("Failed to collect DNS servers: {}", result.error()->str()));
    }
    if (!vpn_network_manager_update_system_dns(std::move(result.value()))) {
        return make_error(ConnectResultError{}, "Failed to update DNS servers");
    }
#endif
    return {};
}

Error<TrustTunnelClient::ConnectResultError> TrustTunnelClient::connect_impl(ListenerSettings listener_settings) {
    VpnSettings settings = {
            .handler = {static_vpn_handler, this},
            .mode = m_config.mode,
            .exclusions = {m_config.exclusions.data(), (uint32_t) m_config.exclusions.size()},
            .killswitch_enabled = m_config.killswitch_enabled,
            .exclusions_tcp_early_ack_enabled = m_config.exclusions_tcp_early_ack_enabled,
            .exclusions_preresolve_enabled = m_config.exclusions_preresolve_enabled,
            .exclusions_preresolve_max_queries = m_config.exclusions_preresolve_max_queries,
            .exclusions_scannable_ports = m_config.exclusions_scannable_ports.c_str(),
    };

    if (m_config.ssl_session_storage_path.has_value()) {
        settings.ssl_sessions_storage_path = m_config.ssl_session_storage_path->c_str();
    }

    m_vpn = vpn_open(&settings);
    if (m_vpn == nullptr) {
        return make_error(ConnectResultError{}, "Failed on create VPN instance");
    }

    auto r = vpn_runner(std::move(listener_settings));

    if (r) {
        disconnect();
    }
    return r;
}

Error<TrustTunnelClient::ConnectResultError> TrustTunnelClient::vpn_runner(ListenerSettings listener_settings) {
    if (auto r = connect_to_server(); r) {
        return r;
    }
    VpnListener *listener = std::holds_alternative<TrustTunnelConfig::TunListener>(m_config.listener)
            ? make_tun_listener(std::move(listener_settings))
            : make_socks_listener(std::move(listener_settings));

    if (listener == nullptr) {
        return make_error(ConnectResultError{}, "Failed to create listener");
    }

    // Backward compatibility for legacy configs
    const auto &effective_dns = m_config.location.dns_upstreams.has_value() ? *m_config.location.dns_upstreams
                                                                            : m_config.legacy_dns_upstreams;

    std::vector<const char *> dns_upstreams;
    dns_upstreams.reserve(effective_dns.size());
    for (const std::string &upstream : effective_dns) {
        dns_upstreams.emplace_back(upstream.c_str());
    }

    VpnListenerConfig listener_config = {
            .dns_upstreams = {.data = dns_upstreams.data(), .size = uint32_t(dns_upstreams.size())},
    };
    VpnError error = vpn_listen(m_vpn, listener, &listener_config);
    if (error.code != 0) {
        return make_error(ConnectResultError{},
                AG_FMT("Failed to start listening: {} ({})", safe_to_string_view(error.text),
                        magic_enum::enum_name((VpnErrorCode) error.code)));
    }
    return {};
}

Error<TrustTunnelClient::ConnectResultError> TrustTunnelClient::connect_to_server() {
    std::vector<VpnEndpoint> endpoints;
    std::vector<VpnRelay> relays;
    std::vector<std::string> hostnames;
    std::vector<std::string> remote_ids;
    hostnames.reserve(m_config.location.endpoints.size());
    remote_ids.reserve(m_config.location.endpoints.size());
    endpoints.reserve(m_config.location.endpoints.size());

    auto copy_to_c_buffer = [](auto &dst, std::string_view src) {
        auto decoded = utils::decode_hex(src);
        size_t data_len = decoded.size();
        dst.size = data_len;
        if (data_len == 0) {
            return;
        }
        // NOLINTNEXTLINE(cppcoreguidelines-no-malloc,hicpp-no-malloc)
        dst.data = static_cast<uint8_t *>(std::malloc(data_len));
        std::memcpy(dst.data, decoded.data(), data_len);
    };

    // A single endpoint to resolve, paired with the parsed hostname/remote_id it belongs to.
    struct ResolveTarget {
        size_t host_index; // index into `hostnames` / `remote_ids`
        bool is_relay;
        std::string address;
    };
    std::vector<ResolveTarget> targets;
    targets.reserve(m_config.location.endpoints.size());

    for (const auto &endpoint : m_config.location.endpoints) {
        auto pipe_pos = endpoint.hostname.find('|');
        if (!endpoint.custom_sni.empty() && pipe_pos != std::string::npos) {
            return make_error(
                    ConnectResultError{}, "Both custom_sni and pipe syntax in hostname are specified, use only one");
        }
        if (!endpoint.custom_sni.empty()) {
            hostnames.emplace_back(endpoint.custom_sni);
            remote_ids.emplace_back(endpoint.hostname);
        } else if (pipe_pos != std::string::npos) {
            hostnames.emplace_back(endpoint.hostname.substr(0, pipe_pos));
            remote_ids.emplace_back(endpoint.hostname.substr(pipe_pos + 1));
        } else {
            hostnames.emplace_back(endpoint.hostname);
            remote_ids.emplace_back("");
        }
        bool is_relay = endpoint.address.starts_with("|");
        targets.push_back(ResolveTarget{
                .host_index = hostnames.size() - 1,
                .is_relay = is_relay,
                .address = is_relay ? endpoint.address.substr(1) : endpoint.address,
        });
    }

    // Resolve every endpoint address in parallel under a single overall deadline.
    std::vector<std::string> to_resolve;
    to_resolve.reserve(targets.size());
    for (const auto &target : targets) {
        to_resolve.push_back(target.address);
    }
    static constexpr size_t kResolveTimeoutSeconds = 15;
    auto resolved_all = resolve_endpoint_addresses(to_resolve, kResolveTimeoutSeconds);

    // Build the endpoints and relays from the resolved addresses.
    for (size_t i = 0; i < targets.size(); ++i) {
        const auto &target = targets[i];
        const auto &resolved = resolved_all[i];
        if (resolved.empty()) {
            warnlog(m_logger, "Failed to resolve {} address: {}", target.is_relay ? "relay" : "endpoint",
                    target.address);
            continue;
        }
        if (target.is_relay) {
            // Use only the first resolved address for relay
            auto &relay = relays.emplace_back(resolved.front());
            if (!m_config.location.client_random.empty()) {
                copy_to_c_buffer(relay.tls_client_random, m_config.location.client_random);
            }
            if (!m_config.location.client_random_mask.empty()) {
                copy_to_c_buffer(relay.tls_client_random_mask, m_config.location.client_random_mask);
            }
            continue;
        }
        for (const auto &addr : resolved) {
            auto &last_el = endpoints.emplace_back(VpnEndpoint{
                    .address = addr,
                    .name = hostnames[target.host_index].c_str(),
                    .remote_id = remote_ids[target.host_index].c_str(),
                    .has_ipv6 = m_config.location.has_ipv6,
            });
            if (!m_config.location.client_random.empty()) {
                copy_to_c_buffer(last_el.tls_client_random, m_config.location.client_random);
            }
            if (!m_config.location.client_random_mask.empty()) {
                copy_to_c_buffer(last_el.tls_client_random_mask, m_config.location.client_random_mask);
            }
        }
    }

    if (endpoints.empty() && relays.empty()) {
        return make_error(ConnectResultError{},
                "Failed to resolve any endpoint or relay addresses. Check network connectivity and configuration.");
    }

    VpnConnectParameters parameters = {
            .upstream_config =
                    {
                            .main_protocol = m_config.location.upstream_protocol,
                            .location =
                                    {
                                            .id = "hello-location",
                                            .endpoints = {endpoints.data(), uint32_t(endpoints.size())},
                                            .relays = {relays.data(), uint32_t(relays.size())},
                                    },
                            .username = m_config.location.username.c_str(),
                            .password = m_config.location.password.c_str(),
                            .recovery =
                                    {
                                            .attempts = UINT32_MAX,
                                    },
                            .anti_dpi = m_config.location.anti_dpi,
                    },
    };

    {
        VpnError err = vpn_connect(m_vpn, &parameters);
        if (err.code != 0) {
            return make_error(ConnectResultError{},
                    AG_FMT("Failed to initiate endpoint connection: {} ({})", safe_to_string_view(err.text),
                            magic_enum::enum_name((VpnErrorCode) err.code)));
        }
    }

    return {};
}

VpnListener *TrustTunnelClient::make_tun_listener(ListenerSettings listener_settings) {
    auto &config = std::get<TrustTunnelConfig::TunListener>(m_config.listener);

    if (auto *use_fd = std::get_if<UseTunnelFd>(&listener_settings)) {
        VpnTunListenerConfig listener_config = {
                .fd = use_fd->fd.release(),
                .mtu_size = config.mtu_size,
                .tcp_recv_buf_size = config.tcp_recv_buf_size,
                .tcp_send_buf_size = config.tcp_send_buf_size,
        };

        return vpn_create_tun_listener(m_vpn, &listener_config);
    }

    if (std::holds_alternative<UseProcessPackets>(listener_settings)) {
        VpnTunListenerConfig listener_config = {
                .fd = -1,
                .mtu_size = config.mtu_size,
                .tcp_recv_buf_size = config.tcp_recv_buf_size,
                .tcp_send_buf_size = config.tcp_send_buf_size,
        };

        return vpn_create_tun_listener(m_vpn, &listener_config);
    }

    assert(std::holds_alternative<AutoSetup>(listener_settings));

#if defined(ANDROID) || TARGET_OS_IPHONE
    errlog(m_logger, "Current platform doesn't support automatic tunnel creation");
    return nullptr;
#else

    // Legacy Pro profiles contain only the IPv4 default. Complete their capture at runtime,
    // without changing the profile or overriding an explicitly scoped IPv6 configuration.
#ifdef _WIN32
    const auto effective_config = config.with_windows_ipv6_protection(m_config.killswitch_enabled);
#else
    const auto &effective_config = config;
#endif
    std::vector<const char *> included_routes;
    included_routes.reserve(effective_config.included_routes.size());
    for (const auto &route : effective_config.included_routes) {
        included_routes.emplace_back(route.c_str());
    }

    std::vector<std::string> complete_excluded_routes = effective_config.excluded_routes;
    for (const auto &endpoint : m_config.location.endpoints) {
        auto resolved = resolve_endpoint_address(endpoint.address.c_str());
        if (resolved.empty()) {
            errlog(m_logger, "Failed to resolve endpoint address for excluded routes: {}", endpoint.address);
            return nullptr;
        }
        for (const auto &addr : resolved) {
            SocketAddress sa(addr);
            complete_excluded_routes.emplace_back(sa.host_str());
        }
    }

    std::vector<const char *> excluded_routes;
    excluded_routes.reserve(complete_excluded_routes.size());
    for (const auto &route : complete_excluded_routes) {
        excluded_routes.emplace_back(route.c_str());
    }

    const VpnOsTunnelSettings *defaults = vpn_os_tunnel_settings_defaults();
    VpnOsTunnelSettings tunnel_settings = {.ipv4_address = defaults->ipv4_address,
            .ipv6_address = defaults->ipv6_address,
            .included_routes = {.data = included_routes.data(), .size = uint32_t(included_routes.size())},
            .excluded_routes = {.data = excluded_routes.data(), .size = uint32_t(excluded_routes.size())},
            .mtu = int(config.mtu_size),
            .dns_servers = config.change_system_dns ? defaults->dns_servers : VpnAddressArray{},
            .device_name = !config.device_name.empty() ? config.device_name.c_str() : defaults->device_name,
            .use_existing = config.use_existing};

    m_tunnel = ag::make_vpn_tunnel();
    if (m_tunnel == nullptr) {
        errlog(m_logger, "Tunnel create error");
        return nullptr;
    }

#ifdef _WIN32
    m_wintun = LoadLibraryExA(
            WINTUN_DLL_NAME.data(), nullptr, LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (m_wintun == nullptr) {
        errlog(m_logger, "Failed to load wintun: {}", ag::sys::strerror(GetLastError()));
        return nullptr;
    }
    VpnWinTunnelSettings win_settings = *vpn_win_tunnel_settings_defaults();
    if (config.device_name.empty()) {
        // Fallback to hostname if no name is specified
        if (!m_config.location.endpoints.empty()) {
            static std::string fallback_name;
            fallback_name = AG_FMT("TrustTunnel ({})", m_config.location.endpoints[0].hostname);
            tunnel_settings.device_name = fallback_name.c_str();
        }
    }
    win_settings.wintun_lib = m_wintun;
    win_settings.block_untunneled = m_config.killswitch_enabled;
    win_settings.block_untunneled_exclude_ports = m_config.killswitch_allow_ports.c_str();
    VpnError res = m_tunnel->init(&tunnel_settings, &win_settings);
#else
#ifdef __linux__
    VpnError res = m_tunnel->init(&tunnel_settings, config.netns);
#else
    VpnError res = m_tunnel->init(&tunnel_settings);
#endif
#endif
    if (res.code != 0) {
        errlog(m_logger, "Failed to initialize tunnel: {}", res.text);
        std::exchange(m_tunnel, nullptr)->deinit();
        return nullptr;
    }

    VpnTunListenerConfig listener_config = {
            .fd = m_tunnel->get_fd(),
#ifdef _WIN32
            .tunnel = m_tunnel.get(),
#endif
            .mtu_size = config.mtu_size,
            .tcp_recv_buf_size = config.tcp_recv_buf_size,
            .tcp_send_buf_size = config.tcp_send_buf_size,
    };

    return vpn_create_tun_listener(m_vpn, &listener_config);
#endif // ANDROID
}

VpnListener *TrustTunnelClient::make_socks_listener(ListenerSettings listener_settings) {
    if (!std::holds_alternative<AutoSetup>(listener_settings)) {
        errlog(m_logger, "Socks listener can only be created with `AutoSetup` setting!");
        return nullptr;
    }
    const auto &cfg = std::get<TrustTunnelConfig::SocksListener>(m_config.listener);
    VpnSocksListenerConfig config = {
            .listen_address = sockaddr_from_str(cfg.address.c_str()),
            .username = cfg.username.c_str(),
            .password = cfg.password.c_str(),
    };
    return vpn_create_socks_listener(m_vpn, &config);
}

void TrustTunnelClient::static_vpn_handler(void *arg, VpnEvent what, void *data) {
    auto *client = (TrustTunnelClient *) (arg);
    if (client) {
        client->vpn_handler(nullptr, what, data);
    }
}

void TrustTunnelClient::vpn_handler(void *, VpnEvent what, void *data) {
    switch (what) {
    case VPN_EVENT_PROTECT_SOCKET: {
        // protect socket to avoid route loop
        auto *event = (SocketProtectEvent *) data;
        m_callbacks.protect_handler(event);
        break;
    }
    case VPN_EVENT_CLIENT_OUTPUT: {
        auto *event = (VpnClientOutputEvent *) data;
        if (m_callbacks.client_output_handler) {
            m_callbacks.client_output_handler(event);
        }
        break;
    }
    case VPN_EVENT_ENDPOINT_CONNECTION_STATS:
    case VPN_EVENT_DNS_UPSTREAM_UNAVAILABLE:
    case VPN_EVENT_TUNNEL_CONNECTION_STATS:
    case VPN_EVENT_TUNNEL_CONNECTION_CLOSED:
        // do nothing
        break;
    case VPN_EVENT_VERIFY_CERTIFICATE: {
        auto *event = (VpnVerifyCertificateEvent *) data;
        if (event->verification_type == VT_ENDPOINT) {
            if (m_config.location.skip_verification) {
                dbglog(m_logger, "Skipping certificate verification");
                event->result = VPN_VCR_SKIP_HOSTNAME_VERIFICATION;
            } else if (m_config.location.ca_store) {
                auto verification =
                        tls_verify_cert_detailed(event->cert, event->chain, m_config.location.ca_store.get());
                if (verification.error != nullptr) {
                    errlog(m_logger, "Failed to verify certificate: {}", verification.error);
                    event->result = verification.not_yet_valid ? VPN_VCR_CERT_NOT_YET_VALID : -1;
                } else {
                    dbglog(m_logger, "Certificate verified successfully");
                    event->result = 0;
                }
            } else {
                m_callbacks.verify_handler(event);
            }
        } else {
            m_callbacks.verify_handler(event);
        }
        break;
    }
    case VPN_EVENT_STATE_CHANGED: {
        auto *event = (VpnStateChangedEvent *) data;
        m_callbacks.state_changed_handler(event);
        break;
    }
    case VPN_EVENT_CONNECT_REQUEST: {
        // The task below carries a raw `Vpn *` captured now and dereferenced later, on another
        // thread. `disconnect()` drains this loop before `vpn_close`, which is what keeps that
        // pointer from outliving the VPN.
        struct TaskContext {
            VpnConnectionInfo *info;
            Vpn *vpn;
            std::string owned_appname; // keeps appname alive for the async task
        };
        auto *task_context = new TaskContext;
        const VpnConnectRequestEvent *event = (VpnConnectRequestEvent *) data;
        auto *info = new VpnConnectionInfo{event->id};

        // Log destination details
        std::string dst_str = "<unknown>";
        if (event->dst != nullptr) {
            if (event->dst->type == VPN_AT_HOST) {
                dst_str = std::string(event->dst->host.name.data, event->dst->host.name.size);
                tracelog(m_logger, "[ROUTE] ConnReq id={} dst=HOST:{} app={}", event->id, dst_str,
                        safe_to_string_view(event->app_name));
            } else if (event->dst->type == VPN_AT_ADDR) {
                SocketAddress sa;
                memcpy(&sa, &event->dst->addr, sizeof(SocketAddressStorage));
                dst_str = sa.str();
                tracelog(m_logger, "[ROUTE] ConnReq id={} dst=ADDR:{} app={}", event->id, dst_str,
                        safe_to_string_view(event->app_name));
            }
        }

        VpnConnectAction action = VPN_CA_DEFAULT;
        // Process-based routing
        std::string resolved_app;
        if (action == VPN_CA_DEFAULT
                && (!m_process_direct.empty() || !m_process_proxy.empty() || !m_process_block.empty())) {
            // Use app_name from event if available
            if (event->app_name != nullptr && event->app_name[0] != '\0') {
                resolved_app = event->app_name;
            }
#ifdef _WIN32
            // On Windows, app_name is typically empty because the TUN/lwip stack
            // doesn't provide process info. Resolve a unique owner from the
            // corresponding IPv4/IPv6 TCP/UDP snapshot; uncertainty keeps default policy.
            if (resolved_app.empty() && event->src != nullptr) {
                // SOCKS targets differ from the OS peer (the local SOCKS listener).
                const auto context = std::holds_alternative<TrustTunnelConfig::SocksListener>(m_config.listener)
                        ? ProcessSocketContext::SOCKS
                        : ProcessSocketContext::TUN;
                resolved_app = resolve_app_name_from_socket(event->src, event->dst, event->proto, context);
            }
#endif
            if (!resolved_app.empty()) {
                // Extract just the executable name (after last path separator)
                std::string app = resolved_app;
                if (auto pos = app.rfind('\\'); pos != std::string::npos) {
                    app = app.substr(pos + 1);
                }
                if (auto pos = app.rfind('/'); pos != std::string::npos) {
                    app = app.substr(pos + 1);
                }
                // Lowercase for case-insensitive comparison
                std::transform(app.begin(), app.end(), app.begin(), ::tolower);

                if (!m_process_block.empty() && m_process_block.contains(app)) {
                    action = VPN_CA_REJECT;
                    infolog(m_logger, "[ROUTE] BLOCKED process: {}", app);
                } else if (!m_process_direct.empty() && m_process_direct.contains(app)) {
                    action = VPN_CA_FORCE_BYPASS;
                    infolog(m_logger, "[ROUTE] DIRECT process: {}", app);
                } else if (!m_process_proxy.empty() && m_process_proxy.contains(app)) {
                    action = VPN_CA_FORCE_REDIRECT;
                    infolog(m_logger, "[ROUTE] PROXY process: {}", app);
                }
            }
        }

        // The core's domain policy runs after this preliminary application action.
        std::string_view log_app = resolved_app.empty() ? safe_to_string_view(event->app_name) : resolved_app;
        tracelog(m_logger, "[ROUTE] Requested action: {} -> {} (app={})", dst_str, magic_enum::enum_name(action),
                log_app);

        info->action = action;
        if (!resolved_app.empty()) {
            task_context->owned_appname = std::move(resolved_app);
        } else if (event->app_name != nullptr && event->app_name[0] != '\0') {
            task_context->owned_appname = event->app_name;
        } else {
            task_context->owned_appname = "trusttunnel_client";
        }
        info->appname = task_context->owned_appname.c_str();
        task_context->info = info;
        task_context->vpn = m_vpn;
        vpn_event_loop_submit(m_extra_loop.get(),
                {
                        .arg = (void *) task_context,
                        .action =
                                [](void *arg, TaskId) {
                                    auto *context = (TaskContext *) arg;
                                    auto *info = context->info;
                                    if (context->vpn) {
                                        vpn_complete_connect_request(context->vpn, info);
                                    }
                                },
                        .finalize =
                                [](void *arg) {
                                    auto *context = (TaskContext *) arg;
                                    delete (VpnConnectionInfo *) context->info;
                                    delete (TaskContext *) context;
                                },
                });
        break;
    }
    case VPN_EVENT_CONNECTION_INFO:
        auto *info = (VpnConnectionInfoEvent *) data;
        if (m_callbacks.connection_info_handler) {
            m_callbacks.connection_info_handler(info);
        }
        break;
    }
} // NOLINT(clang-analyzer-cplusplus.NewDeleteLeaks)

} // namespace ag
