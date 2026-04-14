import type { Meta, StoryObj } from "@storybook/react";
import { TabNavigation } from "./TabNavigation";

/**
 * TabNavigation — horizontal 5-tab navigation bar for the Application Shell.
 *
 * Tabs requiring config (connection, routing, settings) are disabled when
 * hasConfig=false. The "Панель управления" and "О программе" tabs are always enabled.
 *
 * i18n is initialized globally via preview.ts (../src/shared/i18n), so tab labels
 * render in Russian without additional story configuration.
 */
const meta: Meta<typeof TabNavigation> = {
  title: "Layout/TabNavigation",
  component: TabNavigation,
  parameters: { layout: "fullscreen" },
  args: {
    onTabChange: () => {},
    hasConfig: true,
    activeTab: "control",
  },
};

export default meta;
type Story = StoryObj<typeof TabNavigation>;

/** All 5 tabs enabled, "Панель управления" active. */
export const AllEnabled: Story = {
  args: { hasConfig: true, activeTab: "control" },
};

/**
 * No config: connection, routing, and settings tabs are disabled (dimmed, cursor not-allowed).
 * Control panel and about tabs remain active.
 */
export const NoConfig: Story = {
  args: { hasConfig: false, activeTab: "control" },
};

/** "Подключение" tab active. */
export const ConnectionActive: Story = {
  args: { hasConfig: true, activeTab: "connection" },
};

/** "Маршрутизация" tab active. */
export const RoutingActive: Story = {
  args: { hasConfig: true, activeTab: "routing" },
};

/** "Настройки" tab active. */
export const SettingsActive: Story = {
  args: { hasConfig: true, activeTab: "settings" },
};

/** "О программе" tab active. */
export const AboutActive: Story = {
  args: { hasConfig: true, activeTab: "about" },
};
