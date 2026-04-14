import type { Meta, StoryObj } from "@storybook/react";
import { TabNavigation } from "./TabNavigation";

/**
 * TabNavigation -- bottom tab bar (56px height, border-top, transparent background).
 *
 * 5 tabs as fixed 120x44px rounded buttons with icon + label stacked vertically.
 * Active tab uses accent color + bg-elevated. All tabs always enabled.
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
    activeTab: "control",
  },
};

export default meta;
type Story = StoryObj<typeof TabNavigation>;

/** Default: all tabs enabled, "control" active. */
export const Default: Story = {};

/** Connection tab active. */
export const ConnectionActive: Story = {
  args: { activeTab: "connection" },
};

/** Routing tab active. */
export const RoutingActive: Story = {
  args: { activeTab: "routing" },
};

/** Settings tab active. */
export const SettingsActive: Story = {
  args: { activeTab: "settings" },
};

/** About tab active. */
export const AboutActive: Story = {
  args: { activeTab: "about" },
};
