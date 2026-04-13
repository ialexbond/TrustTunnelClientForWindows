import type { Meta, StoryObj } from "@storybook/react";
import { StatusBadge } from "./StatusBadge";

const meta: Meta<typeof StatusBadge> = {
  title: "Primitives/StatusBadge",
  component: StatusBadge,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
  argTypes: {
    variant: {
      control: "select",
      options: ["connected", "connecting", "error", "disconnected"],
    },
    label: { control: "text" },
  },
};

export default meta;
type Story = StoryObj<typeof StatusBadge>;

export const Default: Story = {
  args: {
    variant: "disconnected",
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", alignItems: "flex-start" }}>
      <StatusBadge variant="disconnected" />
      <StatusBadge variant="connecting" />
      <StatusBadge variant="connected" />
      <StatusBadge variant="error" />
    </div>
  ),
};

export const Connected: Story = {
  args: {
    variant: "connected",
  },
};

export const Connecting: Story = {
  args: {
    variant: "connecting",
  },
};

export const Error: Story = {
  args: {
    variant: "error",
  },
};

export const Disconnected: Story = {
  args: {
    variant: "disconnected",
  },
};

export const WithCustomLabel: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", alignItems: "flex-start" }}>
      <StatusBadge variant="connected" label="VPN активен" />
      <StatusBadge variant="connecting" label="Инициализация..." />
      <StatusBadge variant="error" label="Соединение потеряно" />
      <StatusBadge variant="disconnected" label="Нет соединения" />
    </div>
  ),
};
