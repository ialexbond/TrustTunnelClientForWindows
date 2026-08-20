import { ServerPanel } from "../ServerPanel";
import { SshConnectForm } from "./SshConnectForm";
import { ServerPanelSkeleton } from "./ServerPanelSkeleton";
import { type ControlPanelState } from "./useControlPanelOrchestrator";

// ═══════════════════════════════════════════════════════
// ControlPanelView — presentation layer (PANEL-02, D-04)
// ═══════════════════════════════════════════════════════
//
// Props-only presentational component mirroring the in-repo
// `CertificateFingerprintCard` analog: holds the panel JSX (the SSH-form ↔
// ServerPanel switch + the first-connect skeleton render), driven entirely by
// the `ControlPanelState` produced by `useControlPanelOrchestrator`.
//
// The JSX was moved here VERBATIM from ControlPanelPage — byte-identical DOM,
// no extra wrapper div, no testid rename, no role change (Pitfall 1).

export function ControlPanelView({
  creds,
  loading,
  refreshKey,
  isFirstConnect,
  setIsFirstConnect,
  lastHost,
  lastUser,
  lastPort,
  serverInfoVersion,
  setServerInfoVersion,
  localSidecarAvailable,
  latestFromGitHubCP,
  sidecarUpdateVisible,
  handleConnect,
  handleDisconnect,
  handleSidecarUpdateApplied,
  handleSidecarUpdateSeen,
  onConfigExported,
  onSwitchToSetup,
  onNavigateToSettings,
}: ControlPanelState) {
  if (loading) {
    return null;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {!creds ? (
        <SshConnectForm
          onConnect={handleConnect}
          initialHost={lastHost}
          initialUser={lastUser}
          initialPort={lastPort}
        />
      ) : (
        <>
          {isFirstConnect && <ServerPanelSkeleton />}
          <div style={{ display: isFirstConnect ? "none" : "flex", flexDirection: "column", height: "100%" }}>
            <ServerPanel
              key={refreshKey}
              host={creds.host}
              port={creds.port}
              sshUser={creds.user}
              sshPassword={creds.password}
              sshKeyPath={creds.keyPath}
              onSwitchToSetup={onSwitchToSetup}
              onClearConfig={() => {}}
              onDisconnect={handleDisconnect}
              onPanelReady={() => setIsFirstConnect(false)}
              // H-05: on retry, re-arm the first-connect skeleton so it RE-SHOWS
              // during the reload instead of the display:none guard latching off
              // permanently after the first connect.
              onPanelRetry={() => setIsFirstConnect(true)}
              onServerInfoVersionChange={setServerInfoVersion}
              hasSidecarUpdate={sidecarUpdateVisible}
              currentVersion={serverInfoVersion}
              sidecarAvailable={localSidecarAvailable}
              latestVersion={latestFromGitHubCP}
              onSidecarUpdateApplied={handleSidecarUpdateApplied}
              onSidecarUpdateSeen={handleSidecarUpdateSeen}
              onConfigExported={(path) => {
                onConfigExported(path);
                if (onNavigateToSettings) onNavigateToSettings();
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
