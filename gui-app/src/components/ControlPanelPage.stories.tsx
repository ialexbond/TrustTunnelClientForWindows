/* eslint-disable no-console -- storybook stories use console.log to demo callbacks */
import type { Meta, StoryObj } from "@storybook/react";
import { ControlPanelPage, ServerPanelSkeleton } from "./ControlPanelPage";

const meta: Meta<typeof ControlPanelPage> = {
  title: "Screens/ControlPanelPage",
  component: ControlPanelPage,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
        <Story />
      </div>
    ),
  ],
  args: {
    onConfigExported: () => console.log("[Story] config exported"),
    onSwitchToSetup: () => console.log("[Story] switch to setup"),
    onNavigateToSettings: () => console.log("[Story] navigate to settings"),
  },
};

export default meta;
type Story = StoryObj<typeof ControlPanelPage>;

/**
 * No-credentials state: Tauri invoke mock returns null (from .storybook/tauri-mocks/api-core.ts),
 * so the page shows SshConnectForm (Card-centered login layout).
 * This is the primary verifiable state in Storybook.
 *
 * To see the connected state (header + ServerPanel), run the app via `cargo tauri dev`
 * and connect to a real SSH server.
 */
export const NoCredentials: Story = {
  name: "No Credentials (SshConnectForm)",
};

/**
 * Loading state: ServerPanelSkeleton shown during first SSH connection.
 * Uses the actual ServerPanelSkeleton component — single source of truth.
 */
export const Loading: Story = {
  name: "Loading (Skeleton)",
  render: () => <ServerPanelSkeleton />,
};
