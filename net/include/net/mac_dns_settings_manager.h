#pragma once

#include <memory>
#include <span>
#include <string_view>

namespace ag {

class VpnMacDnsSettingsManagerImpl;
using VpnMacDnsSettingsManagerImplPtr = std::unique_ptr<VpnMacDnsSettingsManagerImpl>;

/**
 * Class for setting DNS server of macOS.
 */
class VpnMacDnsSettingsManager {
    VpnMacDnsSettingsManagerImplPtr m_pimpl;
    struct ConstructorAccess {};

public:
    VpnMacDnsSettingsManager(ConstructorAccess access, std::span<const std::string_view> dns_servers);
    ~VpnMacDnsSettingsManager();

    static std::unique_ptr<VpnMacDnsSettingsManager> create(std::span<const std::string_view> dns_servers) {
        auto manager = std::make_unique<VpnMacDnsSettingsManager>(ConstructorAccess{}, dns_servers);
        if (!manager->m_pimpl) {
            manager.reset();
        }
        return manager;
    }

    VpnMacDnsSettingsManager(const VpnMacDnsSettingsManager &) = delete;
    VpnMacDnsSettingsManager(VpnMacDnsSettingsManager &&) = delete;
    void operator=(const VpnMacDnsSettingsManager &) = delete;
    void operator=(VpnMacDnsSettingsManager &&) = delete;
};

} // namespace ag
