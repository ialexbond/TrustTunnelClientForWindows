#include "vpn/vpn_easy.h"

#include <memory>
#include <optional>
#include <variant>

#include <magic_enum/magic_enum.hpp>
#include <toml++/toml.h>

#include "common/logger.h"
#include "common/net_utils.h"
#include "net/os_tunnel.h"
#include "net/tls.h"
#include "vpn/platform.h"
#include "vpn/event_loop.h"
#include "vpn/standalone/client.h"
#include "vpn/standalone/config.h"

static ag::Logger g_logger{"VPN_SIMPLE"};

static ag::UniquePtr<X509_STORE, &X509_STORE_free> g_store;

static void vpn_windows_verify_certificate(ag::VpnVerifyCertificateEvent *event, bool skip_verification) {
    event->result = skip_verification ? 0 : !!ag::tls_verify_cert(event->cert, event->chain, g_store.get());
}

static constexpr auto CONNECT_TIMEOUT = ag::Secs{5};

static INIT_ONCE g_init_once = INIT_ONCE_STATIC_INIT;
static HMODULE g_wintun_handle;

class EasyEventLoop {
public:
    bool start() {
        if (!m_ev_loop) {
            m_ev_loop.reset(ag::vpn_event_loop_create());
        }

        if (!m_ev_loop)  {
            errlog(g_logger, "Failed to create event loop");
            return false;
        }

        infolog(g_logger, "Starting event loop...");

        m_executor_thread = std::thread([this]() {
            int ret = vpn_event_loop_run(m_ev_loop.get());
            if (ret != 0) {
                errlog(g_logger, "Event loop run returned {}", ret);
            }
        });

        if (!vpn_event_loop_dispatch_sync(m_ev_loop.get(), nullptr, nullptr)) {
            errlog(g_logger, "Event loop did not start");
            vpn_event_loop_stop(m_ev_loop.get());
            if (m_executor_thread.joinable()) {
                m_executor_thread.join();
            }
            assert(0);
            return false;
        }

        infolog(g_logger, "Event loop has been started");

        return true;
    }

    void submit(std::function<void()> task) {
        if (m_ev_loop) {
            ag::event_loop::submit(m_ev_loop.get(), std::move(task)).release();
        }
    }

    void stop() {
        ag::vpn_event_loop_stop(m_ev_loop.get());
        if (m_executor_thread.joinable()) {
            m_executor_thread.join();
        }
    }
private:
    ag::UniquePtr<ag::VpnEventLoop, &ag::vpn_event_loop_destroy> m_ev_loop{ag::vpn_event_loop_create()};
    std::thread m_executor_thread;
};

struct vpn_easy_s {
    std::unique_ptr<ag::VpnStandaloneClient> client;
    std::unique_ptr<ag::VpnOsTunnel> tunnel;
};

static std::optional<ag::VpnStandaloneClient::ListenerHelper> make_tun_listener(
        const ag::VpnStandaloneConfig::TunListener &config,
        const std::vector<ag::VpnStandaloneConfig::Endpoint> &endpoints,
        const std::unique_ptr<ag::VpnOsTunnel> &tunnel) {
    std::vector<const char *> included_routes;
    included_routes.reserve(config.included_routes.size());
    for (const auto &route : config.included_routes) {
        included_routes.emplace_back(route.c_str());
    }

    std::vector<std::string> complete_excluded_routes = config.excluded_routes;
    for (const auto &endpoint : endpoints) {
        auto result = ag::utils::split_host_port(endpoint.address);
        if (result.has_error()) {
            continue;
        }
        auto [host_view, port_view] = result.value();
        complete_excluded_routes.emplace_back(host_view.data(), host_view.size());
    }

    std::vector<const char *> excluded_routes;
    excluded_routes.reserve(complete_excluded_routes.size());
    for (const auto &route : complete_excluded_routes) {
        excluded_routes.emplace_back(route.c_str());
    }

    BOOL init_once_pending = FALSE;
    if (!InitOnceBeginInitialize(&g_init_once, 0, &init_once_pending, nullptr)) {
        errlog(g_logger, "InitOnceBeginInitialize: {}", GetLastError());
        return std::nullopt;
    }
    if (init_once_pending) {
        g_wintun_handle = LoadLibraryEx(
                L"wintun", nullptr, LOAD_LIBRARY_SEARCH_APPLICATION_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        if (g_wintun_handle == nullptr) {
            errlog(g_logger, "Failed to load wintun: {}", ag::sys::strerror(GetLastError()));
            InitOnceComplete(&g_init_once, INIT_ONCE_INIT_FAILED, nullptr);
            return std::nullopt;
        }
    }
    InitOnceComplete(&g_init_once, 0, nullptr);

    const ag::VpnOsTunnelSettings *defaults = ag::vpn_os_tunnel_settings_defaults();
    ag::VpnOsTunnelSettings tunnel_settings = {
            .ipv4_address = defaults->ipv4_address,
            .ipv6_address = defaults->ipv6_address,
            .included_routes = {.data = included_routes.data(), .size = uint32_t(included_routes.size())},
            .excluded_routes = {.data = excluded_routes.data(), .size = uint32_t(excluded_routes.size())},
            .mtu = int(config.mtu_size),
            .dns_servers = defaults->dns_servers,
    };

    ag::VpnWinTunnelSettings win_settings = *ag::vpn_win_tunnel_settings_defaults();
    win_settings.wintun_lib = g_wintun_handle;

    ag::VpnError tunnel_result = tunnel->init(&tunnel_settings, &win_settings);
    if (tunnel_result.code) {
        errlog(g_logger, "Failed to initialize tunnel: ({}) {}", tunnel_result.code, tunnel_result.text);
        return std::nullopt;
    }

    ag::VpnTunListenerConfig listener_config = {.fd = -1, .tunnel = tunnel.get(), .mtu_size = config.mtu_size};
    return ag::VpnStandaloneClient::ListenerHelper(listener_config);
}

static std::optional<ag::VpnStandaloneClient::ListenerHelper> make_socks_listener(
        const ag::VpnStandaloneConfig::SocksListener &config) {
    ag::VpnSocksListenerConfig cfg = {
            .listen_address = ag::sockaddr_from_str(config.address.c_str()),
            .username = config.username.c_str(),
            .password = config.password.c_str(),
    };
    return ag::VpnStandaloneClient::ListenerHelper(cfg);
}

static ag::UniquePtr<X509_STORE, &X509_STORE_free> load_certificate(std::string_view pem_certificate) {
    ag::UniquePtr<BIO, &BIO_free> bio {BIO_new_mem_buf(pem_certificate.data(), (long) pem_certificate.size())};

    ag::UniquePtr<X509, &X509_free> cert{PEM_read_bio_X509(bio.get(), nullptr, nullptr, nullptr)};
    if (cert == nullptr) {
        return nullptr;
    }

    ag::UniquePtr<X509_STORE, &X509_STORE_free> store{ag::tls_create_ca_store()};
    if (store == nullptr) {
        return nullptr;
    }

    X509_STORE_add_cert(store.get(), cert.get());

    return store;
}

static vpn_easy_t *vpn_easy_start_internal(const char *toml_config, on_state_changed_t state_changed_cb, void *state_changed_cb_arg) {
    toml::parse_result parsed_config = toml::parse(toml_config);
    if (!parsed_config) {
        warnlog(g_logger, "Failed to parse the TOML config: {}", parsed_config.error().description());
        return nullptr;
    }

    auto standalone_config = ag::VpnStandaloneConfig::build_config(parsed_config);
    if (!standalone_config) {
        warnlog(g_logger, "Failed to build a standalone client config");
        return nullptr;
    }


    bool skip_verification = standalone_config->location.skip_verification;
    if (!skip_verification && standalone_config->location.certificate.has_value()) {
        g_store = load_certificate(*standalone_config->location.certificate);
    }

    ag::VpnCallbacks callbacks;
    if (std::holds_alternative<ag::VpnStandaloneConfig::TunListener>(standalone_config->listener)) {
        callbacks.protect_handler = [](ag::SocketProtectEvent *event) {
            event->result = !ag::vpn_win_socket_protect(event->fd, event->peer);
        };
    } else {
        callbacks.protect_handler = [](ag::SocketProtectEvent *event) {
            event->result = 0;
        };
    }
    callbacks.verify_handler = [skip_verification](ag::VpnVerifyCertificateEvent *event) {
        vpn_windows_verify_certificate(event, skip_verification);
    };
    callbacks.state_changed_handler = [state_changed_cb, state_changed_cb_arg](ag::VpnStateChangedEvent *event) {
        infolog(g_logger, "VPN state changed: {}", magic_enum::enum_name(event->state));
        if (state_changed_cb) {
            state_changed_cb(state_changed_cb_arg, event->state);
        }
    };

    auto vpn = std::make_unique<vpn_easy_t>();

    std::optional<ag::VpnStandaloneClient::ListenerHelper> listener_helper;
    if (auto *tun_config = std::get_if<ag::VpnStandaloneConfig::TunListener>(&standalone_config->listener)) {
        vpn->tunnel = ag::make_vpn_tunnel();
        listener_helper = make_tun_listener(*tun_config, standalone_config->location.endpoints, vpn->tunnel);
    } else if (auto *socks_config = std::get_if<ag::VpnStandaloneConfig::SocksListener>(&standalone_config->listener)) {
        listener_helper = make_socks_listener(*socks_config);
    }

    if (!listener_helper.has_value()) {
        errlog(g_logger, "Failed to initialize listener");
        return nullptr;
    }

    vpn->client = std::make_unique<ag::VpnStandaloneClient>(std::move(*standalone_config), std::move(callbacks));
    if (auto connect_error = vpn->client->connect(CONNECT_TIMEOUT, std::move(*listener_helper))) {
        errlog(g_logger, "Failed to connect: {}", connect_error->pretty_str());
        return nullptr;
    }

    return vpn.release();
}

static void vpn_easy_stop_internal(vpn_easy_t *vpn) {
    if (!vpn) {
        return;
    }
    if (vpn->client) {
        vpn->client->disconnect();
    }
    if (vpn->tunnel) {
        vpn->tunnel->deinit();
    }
    delete vpn;
}

class VpnEasyManager {
public:
    static VpnEasyManager& instance() {
        static VpnEasyManager inst;
        return inst;
    }

    void start_async(const std::string& config, on_state_changed_t callback, void *arg) {
        if (!m_loop) {
            EasyEventLoop loop;
            if (!loop.start()) {
                errlog(g_logger, "Can't start VPN because of event loop error");
                return;
            }
            m_loop = std::move(loop);
        }
        m_loop->submit([this, config = config, callback, arg]() {
            if (m_vpn) {
                warnlog(g_logger, "VPN has been already started");
                return;
            }
            m_vpn = vpn_easy_start_internal(config.data(), callback, arg);  // blocking
            if (!m_vpn) {
                errlog(g_logger, "Failed to start VPN!");
                return;
            }
        });
    }
    void stop_async() {
        if (!m_loop) {
            errlog(g_logger, "Can't stop VPN service because event loop is not running");
            return;
        }
        m_loop->submit([this]() {
            if (!m_vpn) {
                warnlog(g_logger, "VPN is not running");
                return;
            }
            auto *vpn = std::exchange(m_vpn, nullptr);
            vpn_easy_stop_internal(vpn);
        });
    }

    ~VpnEasyManager() {
        if (m_loop) {
            m_loop->stop();
        }
    }

private:
    VpnEasyManager() = default;
    vpn_easy_t *m_vpn = nullptr;
    std::optional<EasyEventLoop> m_loop;
};

void vpn_easy_start(const char *toml_config, on_state_changed_t state_changed_cb, void *state_changed_cb_arg) {
    VpnEasyManager::instance().start_async(toml_config, state_changed_cb, state_changed_cb_arg);
}

void vpn_easy_stop() {
    VpnEasyManager::instance().stop_async();
}