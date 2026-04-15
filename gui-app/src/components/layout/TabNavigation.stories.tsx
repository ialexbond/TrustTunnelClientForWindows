import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { TabNavigation } from "./TabNavigation";
import type { AppTab } from "../../shared/types";

/**
 * TabNavigation — bottom tab bar (64px height, transparent background).
 *
 * 5 tabs distributed evenly (flex-1) with icon + label stacked vertically.
 * Active tab: accent color + animated pill indicator (translateX via getBoundingClientRect).
 * Pill animates smoothly between tabs (300ms ease-out).
 *
 * Use the **Interactive** story to click tabs and see the pill move.
 */
const meta: Meta<typeof TabNavigation> = {
  title: "Layout/TabNavigation",
  component: TabNavigation,
  tags: ["autodocs"],
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

/** Interactive: click tabs to see pill indicator animate between positions. */
export const Interactive: Story = {
  render: () => {
    const [activeTab, setActiveTab] = useState<AppTab>("control");
    return <TabNavigation activeTab={activeTab} onTabChange={setActiveTab} />;
  },
};

/** Default: "control" tab active (static). */
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
