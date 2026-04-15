import type { Meta, StoryObj } from "@storybook/react";
import { ControlPanelPage } from "./ControlPanelPage";
import { Skeleton } from "../shared/ui/Skeleton";

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
 * Replicates the skeleton layout from ControlPanelPage's ServerPanelSkeleton component.
 */
export const Loading: Story = {
  name: "Loading (Skeleton)",
  render: () => (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header skeleton — address + disconnect */}
      <div
        className="flex items-center justify-between px-4 py-2 shrink-0"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        <Skeleton variant="line" width="55%" height={14} />
        <Skeleton variant="line" width="18%" height={14} />
      </div>
      {/* Tab bar skeleton — 5 pills */}
      <div
        className="flex items-center shrink-0 gap-1 px-2 py-1"
        style={{ borderBottom: "1px solid var(--color-border)" }}
      >
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} variant="card" className="flex-1" height={32} />
        ))}
      </div>
      {/* Content skeleton */}
      <div className="flex-1 px-6 py-4 space-y-4">
        <Skeleton variant="card" height={80} />
        <Skeleton variant="line" width="40%" height={14} />
        <Skeleton variant="line" width="70%" height={14} />
        <Skeleton variant="line" width="55%" height={14} />
      </div>
    </div>
  ),
};
