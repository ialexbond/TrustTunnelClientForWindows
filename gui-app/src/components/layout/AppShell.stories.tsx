/* eslint-disable no-console -- storybook stories use console.log to demo callbacks */
import type { Meta, StoryObj } from "@storybook/react";
import { TitleBar } from "./TitleBar";
import { WindowControls } from "./WindowControls";
import { TabNavigation } from "./TabNavigation";

/**
 * AppShell -- composition story showing the complete app layout:
 * TitleBar (32px) at top, content area in the middle, TabNavigation (56px) at bottom.
 *
 * All 5 tab states demonstrated. Seamless design: all components transparent,
 * inheriting bg-primary from body.
 */

/** Placeholder content area to simulate page content. */
function ContentPlaceholder({ label }: { label: string }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--color-text-muted)",
        fontSize: 13,
        borderTop: "1px solid var(--color-border)",
      }}
    >
      {label}
    </div>
  );
}

const meta: Meta = {
  title: "Layout/AppShell",
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div
        style={{
          height: 400,
          backgroundColor: "var(--color-bg-primary)",
          display: "flex",
          flexDirection: "column",
          borderRadius: "var(--radius-lg)",
          overflow: "hidden",
          border: "1px solid var(--color-border)",
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

/** Control tab active (default startup without config). */
export const Default: Story = {
  render: () => (
    <>
      <TitleBar>
        <WindowControls />
      </TitleBar>
      <ContentPlaceholder label="Панель управления" />
      <TabNavigation
        activeTab="control"
        onTabChange={(tab) => console.log("[Story] onTabChange:", tab)}
      />
    </>
  ),
};

/** Connection tab active (default startup with config). */
export const ConnectionActive: Story = {
  render: () => (
    <>
      <TitleBar>
        <WindowControls />
      </TitleBar>
      <ContentPlaceholder label="Подключение" />
      <TabNavigation
        activeTab="connection"
        onTabChange={(tab) => console.log("[Story] onTabChange:", tab)}
      />
    </>
  ),
};

/** Routing tab active. */
export const RoutingActive: Story = {
  render: () => (
    <>
      <TitleBar>
        <WindowControls />
      </TitleBar>
      <ContentPlaceholder label="Маршрутизация" />
      <TabNavigation
        activeTab="routing"
        onTabChange={(tab) => console.log("[Story] onTabChange:", tab)}
      />
    </>
  ),
};

/** Settings tab active. */
export const SettingsActive: Story = {
  render: () => (
    <>
      <TitleBar>
        <WindowControls />
      </TitleBar>
      <ContentPlaceholder label="Настройки" />
      <TabNavigation
        activeTab="settings"
        onTabChange={(tab) => console.log("[Story] onTabChange:", tab)}
      />
    </>
  ),
};

/** About tab active. */
export const AboutActive: Story = {
  render: () => (
    <>
      <TitleBar>
        <WindowControls />
      </TitleBar>
      <ContentPlaceholder label="О программе" />
      <TabNavigation
        activeTab="about"
        onTabChange={(tab) => console.log("[Story] onTabChange:", tab)}
      />
    </>
  ),
};
