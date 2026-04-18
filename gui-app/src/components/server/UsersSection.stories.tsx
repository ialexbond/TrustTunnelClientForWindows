import type { Meta, StoryObj } from "@storybook/react";
import { userEvent, within, waitFor } from "storybook/test";
import { UsersSection } from "./UsersSection";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import { ConfirmDialogProvider } from "../../shared/ui/ConfirmDialogProvider";
import type { ServerState } from "./useServerState";
import type { ServerInfo } from "./useServerState";

/**
 * UsersSection screen-level stories — Phase 14.1.
 *
 * Phase 14.1 заменил inline UsersAddForm на UserModal (Plus → Add, Gear → Edit).
 * CardHeader удалён — раздел теперь содержит только список + bottom-кнопку Add.
 *
 * Stories тестируют публичную поверхность `<UsersSection state={state} />`
 * с моком ServerState. Tauri invoke замокан глобально через `.storybook/tauri-mocks/`.
 *
 * Тёмная/светлая тема переключается через Storybook toolbar — не нужны отдельные
 * LightTheme/DarkTheme stories.
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
    serverInfo: baseServerInfo,
    loading: false,
    error: "",
    actionLoading: null,
    actionResult: null,
    setActionResult: noop,
    pushSuccess: noop,

    configRaw: null,
    setConfigRaw: noop,
    certRaw: null,
    setCertRaw: noop,
    panelDataLoaded: true,

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

    availableVersions: [],
    selectedVersion: "",
    setSelectedVersion: noop,
    showVersions: false,
    setShowVersions: noop,

    serverLogs: "",
    setServerLogs: noop,
    showLogs: false,
    setShowLogs: noop,
    logsLoading: false,
    setLogsLoading: noop,

    diagResult: null,
    setDiagResult: noop,
    showDiag: false,
    setShowDiag: noop,
    diagLoading: false,
    setDiagLoading: noop,

    rebooting: false,
    setRebooting: noop,
    uninstallLoading: false,
    setUninstallLoading: noop,

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

    addUserToState: noop,
    removeUserFromState: noop,
    setServerInfo: noop,
    setActionLoading: noop,

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

/** Empty state: no users yet — EmptyState placeholder + bottom Add button. */
export const Empty: Story = {
  args: {
    state: createMockServerState({
      serverInfo: { ...baseServerInfo, users: [] },
    }),
  },
};

/**
 * Single user: Trash action disabled (D-21).
 * Protocol requires at least one VPN client — last user cannot be deleted.
 */
export const SingleUser: Story = {
  args: {
    state: createMockServerState({
      serverInfo: { ...baseServerInfo, users: ["swift-fox"] },
    }),
  },
};

/** Multiple users — 3 row icons each (FileText, Settings/Gear, Trash). */
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

/** UserConfigModal opens when FileText icon clicked (D-03/D-07). */
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

/** ConfirmDialog opens when Trash icon clicked (D-22). */
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
