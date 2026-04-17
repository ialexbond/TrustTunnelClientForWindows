/* eslint-disable no-console -- storybook stories use console.log to demo callbacks */
import type { Meta, StoryObj } from "@storybook/react";
import StatusPanel from "./StatusPanel";

const meta: Meta<typeof StatusPanel> = {
  title: "Screens/StatusPanel",
  component: StatusPanel,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
  argTypes: {
    status: {
      control: "select",
      options: ["connected", "connecting", "disconnecting", "recovering", "error", "disconnected"],
    },
    error: { control: "text" },
    connectedSince: { control: false },
  },
  args: {
    onConnect: () => console.log("[Story] onConnect"),
    onDisconnect: () => console.log("[Story] onDisconnect"),
    connectedSince: null,
    error: null,
  },
};

export default meta;
type Story = StoryObj<typeof StatusPanel>;

export const Disconnected: Story = {
  args: { status: "disconnected" },
};

export const Connected: Story = {
  args: {
    status: "connected",
    connectedSince: new Date(Date.now() - 3661000), // 1h 1m 1s ago
  },
};

export const Connecting: Story = {
  args: { status: "connecting" },
};

export const Disconnecting: Story = {
  args: { status: "disconnecting" },
};

export const Recovering: Story = {
  args: { status: "recovering" },
};

export const Error: Story = {
  args: {
    status: "error",
    error: "VPN-соединение потеряно. Проверьте подключение к серверу и нажмите Подключить.",
  },
};

export const AllStates: Story = {
  args: {
    error: "",
    status: "disconnected"
  },

  name: "All States (composite)",

  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
      <StatusPanel
        status="disconnected"
        error={null}
        connectedSince={null}
        onConnect={() => {}}
        onDisconnect={() => {}}
      />
      <StatusPanel
        status="connecting"
        error={null}
        connectedSince={null}
        onConnect={() => {}}
        onDisconnect={() => {}}
      />
      <StatusPanel
        status="connected"
        error={null}
        connectedSince={new Date(Date.now() - 7200000)}
        onConnect={() => {}}
        onDisconnect={() => {}}
      />
      <StatusPanel
        status="disconnecting"
        error={null}
        connectedSince={null}
        onConnect={() => {}}
        onDisconnect={() => {}}
      />
      <StatusPanel
        status="recovering"
        error={null}
        connectedSince={null}
        onConnect={() => {}}
        onDisconnect={() => {}}
      />
      <StatusPanel
        status="error"
        error="VPN authentication failed. Check server configuration."
        connectedSince={null}
        onConnect={() => {}}
        onDisconnect={() => {}}
      />
    </div>
  )
};
