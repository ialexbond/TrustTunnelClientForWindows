import type { Meta, StoryObj } from "@storybook/react";
import { userEvent, within, waitFor } from "storybook/test";
import { UsersSection } from "./UsersSection";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import { ConfirmDialogProvider } from "../../shared/ui/ConfirmDialogProvider";
import type { ServerState } from "./useServerState";
import type { ServerInfo } from "./useServerState";

/**
 * Phase 14 mockup-first stories (D-30/D-31).
 *
 * These 10 screen-level stories capture the desired visual state of the
 * Users tab BEFORE the full rewrite lands in Plan 05. The stories work with
 * the current UsersSection implementation (OverflowMenu + radio-circle) and
 * will continue to work once Plan 05 rewrites internals — because the public
 * props surface (`<UsersSection state={state} />`) is not changing.
 *
 * Stories are driven by `createMockServerState(overrides)` which returns a
 * synthetic ServerState with all handlers stubbed out. Tauri invoke is
 * mocked globally via `.storybook/tauri-mocks/` so SSH-bound actions
 * resolve to safe defaults.
 */

const baseServerInfo: ServerInfo = {
  installed: true,
  version: "1.4.0",
  serviceActive: true,
  users: [],
};

function noop(): void {
  /* stub */
}

async function asyncNoop(): Promise<void> {
  /* stub */
}

function createMockServerState(overrides: Partial<ServerState> = {}): ServerState {
  const base = {
    // Core server info
    serverInfo: baseServerInfo,
    loading: false,
    error: "",
    actionLoading: null,
    actionResult: null,
    setActionResult: noop,
    pushSuccess: noop,

    // Panel data (preloaded)
    configRaw: null,
    setConfigRaw: noop,
    certRaw: null,
    setCertRaw: noop,
    panelDataLoaded: true,

    // Users domain slice
    selectedUser: null,
    setSelectedUser: noop,
    newUsername: "",
    setNewUsername: noop,
    newPassword: "",
    setNewPassword: noop,
    showNewPw: false,
    setShowNewPw: noop,
    exportingUser: null,
    setExportingUser: noop,
    deleteLoading: false,
    setDeleteLoading: noop,
    continueLoading: false,
    setContinueLoading: noop,

    // Versions domain slice
    availableVersions: [],
    selectedVersion: "",
    setSelectedVersion: noop,
    showVersions: false,
    setShowVersions: noop,

    // Logs domain slice
    serverLogs: "",
    setServerLogs: noop,
    showLogs: false,
    setShowLogs: noop,
    logsLoading: false,
    setLogsLoading: noop,

    // Diagnostics domain slice
    diagResult: null,
    setDiagResult: noop,
    showDiag: false,
    setShowDiag: noop,
    diagLoading: false,
    setDiagLoading: noop,

    // Danger zone domain slice
    rebooting: false,
    setRebooting: noop,
    uninstallLoading: false,
    setUninstallLoading: noop,

    // Helpers
    sshParams: {
      host: "192.168.1.100",
      port: 22,
      user: "root",
      password: "***",
      keyPath: undefined as string | undefined,
    },
    loadServerInfo: asyncNoop,
    runAction: asyncNoop,
    usernameError: "",

    // Optimistic updates
    addUserToState: noop,
    removeUserFromState: noop,
    setServerInfo: noop,
    setActionLoading: noop,

    // Props pass-through
    host: "192.168.1.100",
    port: "22",
    onDisconnect: noop,
    onSwitchToSetup: noop,
    onClearConfig: noop,
    onConfigExported: noop,
    onPortChanged: noop,
    ...overrides,
  };
  return base as unknown as ServerState;
}

const meta: Meta<typeof UsersSection> = {
  title: "Screens/UsersSection",
  component: UsersSection,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <SnackBarProvider>
        <ConfirmDialogProvider>
          <div
            style={{
              maxWidth: 560,
              backgroundColor: "var(--color-bg-primary)",
              padding: 16,
            }}
          >
            <Story />
          </div>
        </ConfirmDialogProvider>
      </SnackBarProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

/** Empty state: no users yet — EmptyState copy + add form always visible. */
export const Empty: Story = {
  args: {
    state: createMockServerState({
      serverInfo: { ...baseServerInfo, users: [] },
    }),
  },
};

/**
 * Single user: Trash action must be disabled (D-21).
 * Protocol requires at least one VPN client — the last user cannot be deleted.
 */
export const SingleUser: Story = {
  args: {
    state: createMockServerState({
      serverInfo: { ...baseServerInfo, users: ["swift-fox"] },
    }),
  },
};

/** Multiple users, nothing selected — row hover visible on interaction. */
export const MultipleUsers: Story = {
  args: {
    state: createMockServerState({
      serverInfo: {
        ...baseServerInfo,
        users: ["swift-fox", "bold-eagle42", "calm-raven"],
      },
    }),
  },
};

/**
 * Multiple users, one selected — accent tint on row,
 * Continue-as-user CTA enabled with the selected name.
 */
export const SelectedUser: Story = {
  args: {
    state: createMockServerState({
      serverInfo: {
        ...baseServerInfo,
        users: ["swift-fox", "bold-eagle42", "calm-raven"],
      },
      selectedUser: "bold-eagle42",
    }),
  },
};

/** Long username — verifies truncation with ellipsis inside row. */
export const LongUsername: Story = {
  args: {
    state: createMockServerState({
      serverInfo: {
        ...baseServerInfo,
        users: ["a-very-long-generated-username-example-1234567890"],
      },
    }),
  },
};

/**
 * Add form pre-filled (D-13) — inputs hold generated credentials,
 * demonstrating regenerate/clear icon layout.
 */
export const AddFormPrefilled: Story = {
  args: {
    state: createMockServerState({
      serverInfo: { ...baseServerInfo, users: ["swift-fox"] },
      newUsername: "bold-eagle42",
      newPassword: "Xk8mN2pQrS9tVwYz",
    }),
  },
};

/** Add in progress — inputs disabled, Add button shows spinner. */
export const AddInProgress: Story = {
  args: {
    state: createMockServerState({
      serverInfo: { ...baseServerInfo, users: ["swift-fox"] },
      newUsername: "calm-raven",
      newPassword: "Xk8mN2pQrS9tVwYz",
      actionLoading: "add_user",
    }),
  },
};

/**
 * Password pre-filled demonstration.
 *
 * The actual visibility toggle is owned by ActionPasswordInput internal
 * state; this story shows the form populated so the visibility-toggle
 * eye icon is reachable. Click the eye in the Storybook preview to flip
 * between hidden/visible.
 */
export const PasswordVisible: Story = {
  args: {
    state: createMockServerState({
      serverInfo: { ...baseServerInfo, users: [] },
      newUsername: "swift-fox",
      newPassword: "Xk8mN2pQrS9tVwYz",
    }),
  },
};

/**
 * Add error: username collides with existing user — inline validation
 * surfaces via `usernameError` i18n key below the name input.
 */
export const AddError: Story = {
  args: {
    state: createMockServerState({
      serverInfo: { ...baseServerInfo, users: ["swift-fox"] },
      newUsername: "swift-fox",
      newPassword: "ValidPass123",
      usernameError: "server.users.username_exists",
    }),
  },
};

/** Same layout as MultipleUsers, rendered under light theme tokens. */
export const LightTheme: Story = {
  args: {
    state: createMockServerState({
      serverInfo: {
        ...baseServerInfo,
        users: ["swift-fox", "bold-eagle42"],
      },
    }),
  },
  decorators: [
    (Story) => (
      <SnackBarProvider>
        <ConfirmDialogProvider>
          <div
            data-theme="light"
            style={{
              maxWidth: 560,
              backgroundColor: "var(--color-bg-primary)",
              padding: 16,
            }}
          >
            <Story />
          </div>
        </ConfirmDialogProvider>
      </SnackBarProvider>
    ),
  ],
};

/** Demonstrates UserConfigModal opening when FileText icon is clicked (D-03/D-07). */
export const WithUserConfigModal: Story = {
  args: {
    state: createMockServerState({
      serverInfo: { ...baseServerInfo, users: ["swift-fox", "bold-eagle42"] },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const buttons = await canvas.findAllByLabelText(/показать конфиг|show config/i);
    if (buttons.length > 0) {
      await userEvent.click(buttons[0]);
    }
    await waitFor(() => {
      const modalRoot = document.body.querySelector(
        '[aria-label*="скопировать"i], [aria-label*="copy"i]',
      );
      if (!modalRoot) throw new Error("UserConfigModal did not open");
    });
  },
};

/** Demonstrates ConfirmDialog opening when Trash icon is clicked (D-22). */
export const WithDeleteConfirm: Story = {
  args: {
    state: createMockServerState({
      serverInfo: { ...baseServerInfo, users: ["swift-fox", "bold-eagle42"] },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const buttons = await canvas.findAllByLabelText(/удалить|delete/i);
    const enabled = buttons.find((b) => !(b as HTMLButtonElement).disabled);
    if (enabled) await userEvent.click(enabled);
    await waitFor(() => {
      const dialog = document.body.querySelector('[role="dialog"], [role="alertdialog"]');
      const titleNode = Array.from(document.body.querySelectorAll("h2, h3")).find((n) =>
        /удал|delete/i.test(n.textContent ?? ""),
      );
      if (!dialog && !titleNode) throw new Error("ConfirmDialog did not open");
    });
  },
};
