internal import TOMLDecoder

internal struct TunConfig: Codable {
    let mtu_size: Int
    let included_routes: [String]
    let excluded_routes: [String]
}

internal struct VpnConfig: Codable {
    struct Listener: Codable {
        let tun: TunConfig
    }
    let listener: Listener
    let dns_upstreams: [String]
}

internal func parseVpnConfig(from config: String) throws -> VpnConfig {
    let decoder = TOMLDecoder()
    return try decoder.decode(VpnConfig.self, from: config)
}
