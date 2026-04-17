/* eslint-disable no-console -- storybook stories use console.log to demo callbacks */
import type { Meta, StoryObj } from "@storybook/react";
import { ServerTabs } from "./ServerTabs";
import type { ServerState } from "./server/useServerState";

function createMockServerState(overrides?: Partial<ServerState>): ServerState {
  return {
    // Server info
    serverInfo: {
      installed: true,
      version: "3.1.0",
      serviceActive: true,
      users: ["admin", "user1"],
      listenPort: 443,
      protocol: "xray-vless-reality",
      cipher: "ECDHE-RSA-AES256-GCM-SHA384",
      dns: "1.1.1.1",
      mtu: 1420,
    },
    loading: false,
    error: null,
    actionLoading: null,
    actionResult: null,
    setActionResult: () => {},
    pushSuccess: () => {},

    // Users
    selectedUser: null,
    setSelectedUser: () => {},
    newUsername: "",
    setNewUsername: () => {},
    newPassword: "",
    setNewPassword: () => {},
    showNewPw: false,
    setShowNewPw: () => {},
    exportingUser: null,
    setExportingUser: () => {},
    confirmDeleteUser: null,
    setConfirmDeleteUser: () => {},
    deleteLoading: false,
    setDeleteLoading: () => {},
    continueLoading: false,
    setContinueLoading: () => {},

    // Panel data
    configRaw: "[Interface]\nAddress = 10.0.0.1/24\nListenPort = 443",
    setConfigRaw: () => {},
    certRaw: "-----BEGIN CERTIFICATE-----\nMIIBkTCB...\n-----END CERTIFICATE-----",
    setCertRaw: () => {},
    panelDataLoaded: true,

    // Versions
    availableVersions: [],
    selectedVersion: null,
    setSelectedVersion: () => {},
    showVersions: false,
    setShowVersions: () => {},

    // Logs
    serverLogs: "",
    setServerLogs: () => {},
    showLogs: false,
    setShowLogs: () => {},
    logsLoading: false,
    setLogsLoading: () => {},

    // Diagnostics
    diagResult: null,
    setDiagResult: () => {},
    showDiag: false,
    setShowDiag: () => {},
    diagLoading: false,
    setDiagLoading: () => {},

    // Reboot
    rebooting: false,
    setRebooting: () => {},

    // Danger zone
    confirmReboot: false,
    setConfirmReboot: () => {},
    confirmUninstall: false,
    setConfirmUninstall: () => {},
    uninstallLoading: false,
    setUninstallLoading: () => {},

    // Helpers
    sshParams: { host: "192.168.1.100", port: "22", username: "root", authMethod: "password" as const, password: "***" },
    loadServerInfo: async () => {},
    runAction: async () => {},
    usernameError: null,

    // Optimistic updates
    addUserToState: () => {},
    removeUserFromState: () => {},
    setServerInfo: () => {},
    setActionLoading: () => {},

    // Props pass-through
    host: "192.168.1.100",
    port: "22",
    onDisconnect: () => console.log("[Story] onDisconnect"),
    onSwitchToSetup: () => console.log("[Story] onSwitchToSetup"),
    onClearConfig: () => console.log("[Story] onClearConfig"),
    onConfigExported: () => console.log("[Story] onConfigExported"),
    onPortChanged: () => console.log("[Story] onPortChanged"),
    ...overrides,
  } as ServerState;
}

/**
 * ServerTabs — 5-tab server management panel (Status, Users, Config, Security, Tools).
 *
 * DangerZone lives inside Tools tab as a collapsible Accordion (closed by default).
 * Tab switching uses cross-fade (opacity + visibility transition, not display:none).
 * Tabs are interactive — click to switch, state managed internally.
 */
const meta: Meta<typeof ServerTabs> = {
  title: "Screens/ServerTabs",
  component: ServerTabs,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          height: 600,
          backgroundColor: "var(--color-bg-primary)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ServerTabs>;

/** Default: Status tab active with mock server data. Click tabs to see cross-fade. */
export const Default: Story = {
  args: { state: createMockServerState() },
};

/** Loading state: server info still loading. */
export const Loading: Story = {
  args: {
    state: createMockServerState({
      loading: true,
      serverInfo: null,
      panelDataLoaded: false,
    }),
  },
};

/** Error state: SSH connection error. */
export const Error: Story = {
  args: {
    state: createMockServerState({
      error: "SSH connection refused: timeout after 10s",
      serverInfo: null,
    }),
  },
};
