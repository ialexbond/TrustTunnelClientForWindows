import type { Meta, StoryObj } from "@storybook/react";
import { TitleBar } from "./TitleBar";
import { WindowControls } from "./WindowControls";
import { TabNavigation } from "./TabNavigation";

/**
 * AppShell -- composition story showing the complete app layout:
 * TitleBar (32px) at top, content area in the middle, TabNavigation (56px) at bottom.
 *
 * This demonstrates how all layout components work together as the application shell.
 * Seamless design: all components are transparent, inheriting bg-primary from body.
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

/** Full shell: TitleBar + content placeholder + TabNavigation. All tabs always enabled. */
export const Default: Story = {
  render: () => (
    <>
      <TitleBar>
        <WindowControls />
      </TitleBar>
      <ContentPlaceholder label="Content Area" />
      <TabNavigation
        activeTab="control"
        onTabChange={(tab) => console.log("[Story] onTabChange:", tab)}
      />
    </>
  ),
};

/** Connection tab active -- shows elevated background on the active tab button. */
export const ConnectionActive: Story = {
  render: () => (
    <>
      <TitleBar>
        <WindowControls />
      </TitleBar>
      <ContentPlaceholder label="Connection Settings" />
      <TabNavigation
        activeTab="connection"
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
      <ContentPlaceholder label="About TrustTunnel" />
      <TabNavigation
        activeTab="about"
        onTabChange={(tab) => console.log("[Story] onTabChange:", tab)}
      />
    </>
  ),
};
