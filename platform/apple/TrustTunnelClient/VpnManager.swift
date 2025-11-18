import Foundation
import NetworkExtension

enum VpnSessionState: Int {
    case disconnected;
    case connecting;
    case connected;
    case waiting_recovery;
    case recovering;
    case waiting_for_network;
}

func convertVpnState(_ status: NEVPNStatus) -> Int {
    switch status {
    case .disconnected, .invalid:
        return VpnSessionState.disconnected.rawValue
    case .connecting:
        return VpnSessionState.connecting.rawValue
    case .connected:
        return VpnSessionState.connected.rawValue
    case .reasserting:
        return VpnSessionState.recovering.rawValue
    default:
        return -1
    }
}

public final class VpnManager {
    private var apiQueue: DispatchQueue
    private var queue: DispatchQueue
    private var stopTimer: DispatchSourceTimer?
    private var vpnManager: NETunnelProviderManager?
    private var statusObserver: NSObjectProtocol?
    private let stateChangeCallback: (Int) -> Void
    private var readyContinuation: CheckedContinuation<NETunnelProviderManager, Never>?
    private var bundleIdentifier: String

    public init(bundleIdentifier: String, stateChangeCallback: @escaping (Int) -> Void) {
        self.apiQueue = DispatchQueue(label: "com.adguard.TrustTunnel.TrustTunnelClient.VpnManager.api", qos: .userInitiated)
        self.queue = DispatchQueue(label: "com.adguard.TrustTunnel.TrustTunnelClient.VpnManager", qos: .userInitiated);
        self.bundleIdentifier = bundleIdentifier
        self.stateChangeCallback = stateChangeCallback
        self.apiQueue.async {
            self.startObservingStatus(manager: self.getManager())
        }
    }
    
    deinit {
        stopObservingStatus()
    }
    
    func getManager() -> NETunnelProviderManager {
        if let manager = (queue.sync { self.vpnManager }) {
            return manager
        }
        
        let group = DispatchGroup()
        group.enter()
        let timerSource = DispatchSource.makeTimerSource(flags: [], queue: self.queue)
        timerSource.setCancelHandler {
            self.stopTimer = nil
            group.leave()
        }
        timerSource.setEventHandler {
            timerSource.cancel()
        }
        let timeout = DispatchTime.now() + .seconds(5)
        timerSource.schedule(deadline: timeout)
        timerSource.resume()
        

        NETunnelProviderManager.loadAllFromPreferences { managers, error in
            guard let managers else {return}
            // Try to find an existing configuration
            let existingManager = managers.first {
                ($0.protocolConfiguration as? NETunnelProviderProtocol)?
                    .providerBundleIdentifier == self.bundleIdentifier
            }

            self.queue.sync {
                if self.vpnManager != nil {
                    return
                }
                self.vpnManager = existingManager
            }
            timerSource.cancel()
        }
        group.wait()
        return self.queue.sync {
            return self.vpnManager ?? NETunnelProviderManager()
        }
    }

    private func startObservingStatus(manager: NETunnelProviderManager) {
        // Avoid duplicate observers
        guard statusObserver == nil else { return }
        statusObserver = NotificationCenter.default.addObserver(
            forName: .NEVPNStatusDidChange,
            object: manager.connection,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.queue.sync {
                if self.stopTimer != nil && (manager.connection.status == .disconnected || manager.connection.status == .invalid) {
                    self.cancelStopTimer()
                }
            }
            self.logCurrentStatus(prefix: "status change", manager: manager)
        }
        // Log initial status immediately
        logCurrentStatus(prefix: "initial", manager: manager)
    }

    private func stopObservingStatus() {
        if let token = statusObserver {
            NotificationCenter.default.removeObserver(token)
            statusObserver = nil
        }
    }

    private func logCurrentStatus(prefix: String, manager: NETunnelProviderManager) {
        let status = manager.connection.status
        NSLog("VPN \(prefix): \(string(for: status))")
        if let state = Optional(convertVpnState(manager.connection.status)), state >= 0 {
            stateChangeCallback(state)
        }
    }

    private func string(for status: NEVPNStatus) -> String {
        switch status {
        case .invalid: return "invalid"
        case .disconnected: return "disconnected"
        case .connecting: return "connecting"
        case .connected: return "connected"
        case .reasserting: return "reasserting"
        case .disconnecting: return "disconnecting"
        @unknown default: return "unknown(\(status.rawValue))"
        }
    }
    
    private func cancelStopTimer() {
        self.stopTimer?.cancel()
        self.stopTimer = nil
    }

    public func start(config: (String)) {
        apiQueue.async {
            let manager = self.getManager()
            let group = DispatchGroup()
            group.enter()

            manager.loadFromPreferences { error in
                if let error = error {
                    NSLog("Failed to load preferences: \(error)")
                    group.leave()
                    return
                }
                let configuration = (manager.protocolConfiguration as? NETunnelProviderProtocol) ??
                NETunnelProviderProtocol()
                configuration.providerBundleIdentifier = self.bundleIdentifier
                configuration.providerConfiguration = ["config": config as NSObject]
                configuration.serverAddress = "Trust Tunnel"
                manager.protocolConfiguration = configuration
                manager.localizedDescription = "TrustTunnel VPN"
                manager.isEnabled = true
                manager.saveToPreferences { error in
                    if let error = error {
                        NSLog("Failed to save preferences: \(error)")
                        group.leave()
                        return
                    }
                    manager.loadFromPreferences { error in
                        if let error = error {
                            NSLog("Failed to reload preferences: \(error)")
                            group.leave()
                            return
                        }
                        group.leave()
                    }
                }
            }
            group.wait()

            do {
                try manager.connection.startVPNTunnel()
                NSLog("VPN started")
            } catch {
                NSLog("Failed to start VPN tunnel: \(error)")
            }
        }
    }

    public func stop() {
        apiQueue.async {
            let group = DispatchGroup()
            let timerSource = DispatchSource.makeTimerSource(flags: [], queue: self.queue)
            timerSource.setCancelHandler {
                self.stopTimer = nil
                group.leave()
            }
            timerSource.setEventHandler {
                timerSource.cancel()
            }
            group.enter()
            let timeout = DispatchTime.now() + .seconds(15)
            timerSource.schedule(deadline: timeout)
            timerSource.resume()
            let manager = self.getManager()
            self.queue.sync {
                self.stopTimer = timerSource
                if manager.connection.status == .disconnected || manager.connection.status == .invalid {
                    self.cancelStopTimer()
                    return
                }
                // Log current status before stopping
                self.logCurrentStatus(prefix: "pre-stop", manager: manager)
            }
            manager.connection.stopVPNTunnel()
            group.wait()
            NSLog("Finished!")
        }
    }
}
