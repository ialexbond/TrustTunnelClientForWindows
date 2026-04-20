import type { Meta, StoryObj } from "@storybook/react";
import { Badge } from "./Badge";

const meta = {
  title: "Primitives/Badge",
  component: Badge,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: { type: "select" },
      options: ["success", "warning", "danger", "neutral", "dot"],
    },
    pulse: { control: "boolean" },
  },
  args: {
    children: "Badge",
    variant: "neutral",
    pulse: false,
  },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="flex items-center gap-3 flex-wrap">
      <Badge variant="success">Connected</Badge>
      <Badge variant="warning">Connecting</Badge>
      <Badge variant="danger">Error</Badge>
      <Badge variant="neutral">Neutral</Badge>
      <Badge variant="dot">Offline</Badge>
    </div>
  ),
};

export const Pulsing: Story = {
  render: () => (
    <div className="flex items-center gap-3 flex-wrap">
      <Badge variant="success" pulse>Live</Badge>
      <Badge variant="warning" pulse>Syncing</Badge>
    </div>
  ),
};

export const DotIndicator: Story = {
  render: () => (
    <div className="flex items-center gap-3 flex-wrap">
      <Badge variant="dot">Offline</Badge>
      <Badge variant="dot">Idle</Badge>
    </div>
  ),
};
