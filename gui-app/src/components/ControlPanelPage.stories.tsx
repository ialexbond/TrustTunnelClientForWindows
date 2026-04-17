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
 *
 * Adaptive: real Pro window is `minWidth: 800` (no maxWidth — bounded by
 * desktop). Cards use the same flex/flex-wrap values as OverviewSection,
 * so wrapping naturally matches the real layout at any width.
 *
 * Use Storybook viewport addon (or resize the browser) to verify wrapping
 * at 800/900/1100/1400 px.
 */
export const Loading: Story = {
  name: "Loading (Skeleton)",
  render: () => <ServerPanelSkeleton />,
};

/**
 * Loading at min window width (800px) — Pro app's enforced minimum.
 */
export const LoadingMinWidth: Story = {
  name: "Loading @ 800px (min)",
  render: () => (
    <div style={{ width: 800, margin: "0 auto", height: "100%", display: "flex", flexDirection: "column", border: "1px dashed var(--color-border)" }}>
      <ServerPanelSkeleton />
    </div>
  ),
};

/**
 * Loading at max interface width (1000px) — UI cap. Window can resize wider,
 * but content area + bottom TabNavigation are constrained to 1000px max.
 */
export const LoadingMaxWidth: Story = {
  name: "Loading @ 1000px (max)",
  render: () => (
    <div style={{ width: 1000, margin: "0 auto", height: "100%", display: "flex", flexDirection: "column", border: "1px dashed var(--color-border)" }}>
      <ServerPanelSkeleton />
    </div>
  ),
};
