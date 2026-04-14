import type { Meta, StoryObj } from "@storybook/react";
import { TabNavigation } from "./TabNavigation";

/**
 * TabNavigation -- bottom tab bar (48px height, border-top, transparent background).
 *
 * 5 tabs as compact 64x40px rounded buttons with icon + label stacked vertically.
 * Active tab uses accent color + bg-elevated. Tabs requiring config (connection,
 * routing, settings) are disabled when hasConfig=false.
 *
 * i18n is initialized globally via preview.ts, so tab labels render in Russian
 * without additional story configuration.
 */
const meta: Meta<typeof TabNavigation> = {
  title: "Layout/TabNavigation",
  component: TabNavigation,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ backgroundColor: "var(--color-bg-primary)" }}>
        <Story />
      </div>
    ),
  ],
  args: {
    onTabChange: (tab: string) => console.log("[Story] onTabChange:", tab),
    hasConfig: true,
    activeTab: "control",
  },
};

export default meta;
type Story = StoryObj<typeof TabNavigation>;

/** Default: all tabs enabled, "control" active. */
export const Default: Story = {};

/** WithConfig: all 5 tabs enabled, "control" active. */
export const WithConfig: Story = {
  args: { hasConfig: true, activeTab: "control" },
};

/**
 * WithoutConfig: connection, routing, and settings tabs are disabled
 * (dimmed, opacity 0.4, cursor not-allowed). Control and About remain active.
 */
export const WithoutConfig: Story = {
  args: { hasConfig: false, activeTab: "control" },
};

/** Connection tab active (requires hasConfig). */
export const ConnectionActive: Story = {
  args: { hasConfig: true, activeTab: "connection" },
};

/** Routing tab active (requires hasConfig). */
export const RoutingActive: Story = {
  args: { hasConfig: true, activeTab: "routing" },
};

/** Settings tab active (requires hasConfig). */
export const SettingsActive: Story = {
  args: { hasConfig: true, activeTab: "settings" },
};

/** About tab active (always available). */
export const AboutActive: Story = {
  args: { hasConfig: true, activeTab: "about" },
};
