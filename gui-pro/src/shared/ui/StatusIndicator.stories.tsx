import type { Meta, StoryObj } from "@storybook/react";
import { StatusIndicator } from "./StatusIndicator";

const meta = {
  title: "Primitives/StatusIndicator",
  component: StatusIndicator,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    status: { control: "select", options: ["success", "warning", "danger", "neutral", "info"] },
    size: { control: "select", options: ["sm", "md", "lg"] },
    pulse: { control: "boolean" },
    label: { control: "text" },
  },
} satisfies Meta<typeof StatusIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { status: "success", label: "Online" },
};

export const AllStatuses: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
      <StatusIndicator status="success" label="Connected" />
      <StatusIndicator status="warning" label="Connecting" />
      <StatusIndicator status="danger" label="Error" />
      <StatusIndicator status="neutral" label="Offline" />
      <StatusIndicator status="info" label="Info" />
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
      <StatusIndicator status="success" size="sm" label="Small" />
      <StatusIndicator status="success" size="md" label="Medium" />
      <StatusIndicator status="success" size="lg" label="Large" />
    </div>
  ),
};

export const WithPulse: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
      <StatusIndicator status="success" pulse label="Active" />
      <StatusIndicator status="warning" pulse label="Reconnecting" />
    </div>
  ),
};
