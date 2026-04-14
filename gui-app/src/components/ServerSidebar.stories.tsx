import type { Meta, StoryObj } from "@storybook/react";
import { ServerSidebar } from "./ServerSidebar";

/**
 * ServerSidebar — 200px left column shown only on the "Панель управления" tab.
 *
 * Status dots use design token vars (--color-status-connected, etc.) — no
 * hardcoded Tailwind color classes. Hover a connected server row to reveal
 * the disconnect button (Power icon, opacity-0 → opacity-100).
 *
 * i18n is initialized globally via preview.ts; sidebar labels render in Russian.
 */
const meta: Meta<typeof ServerSidebar> = {
  title: "Layout/ServerSidebar",
  component: ServerSidebar,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ height: 400, display: "flex" }}>
        <Story />
        <div style={{ flex: 1, backgroundColor: "var(--color-bg-primary)" }} />
      </div>
    ),
  ],
  args: {
    onSelect: () => {},
    onAddServer: () => {},
    onDisconnect: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof ServerSidebar>;

/** No servers — shows EmptyState with Server icon and "Нет серверов" heading. */
export const Empty: Story = {
  args: {
    servers: [],
    selectedId: null,
  },
};

/** Single connected server, selected. Shows green status dot. Hover to see disconnect button. */
export const SingleConnected: Story = {
  args: {
    servers: [
      { id: "1", host: "185.212.170.15", port: "22", status: "connected" as const },
    ],
    selectedId: "1",
  },
};

/**
 * Two servers with mixed statuses: connected (Frankfurt, selected) and disconnected (Helsinki).
 * Demonstrates multi-server layout and label/host:port two-line display.
 */
export const MixedStatuses: Story = {
  args: {
    servers: [
      {
        id: "1",
        host: "185.212.170.15",
        port: "22",
        label: "Frankfurt",
        status: "connected" as const,
      },
      {
        id: "2",
        host: "95.216.146.23",
        port: "22",
        label: "Helsinki",
        status: "disconnected" as const,
      },
    ],
    selectedId: "1",
  },
};

/** Server in error state — red status dot (--color-status-error). */
export const ErrorState: Story = {
  args: {
    servers: [
      { id: "1", host: "10.0.0.1", port: "22", status: "error" as const },
    ],
    selectedId: "1",
  },
};

/** Server connecting — amber dot with animate-pulse and spinner icon. */
export const Connecting: Story = {
  args: {
    servers: [
      { id: "1", host: "185.212.170.15", port: "22", status: "connecting" as const },
    ],
    selectedId: "1",
  },
};
