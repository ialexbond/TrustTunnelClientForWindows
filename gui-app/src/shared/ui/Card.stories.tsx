import type { Meta, StoryObj } from "@storybook/react";
import { Card, CardHeader } from "./Card";
import { Shield } from "lucide-react";
import { Button } from "./Button";

const meta: Meta<typeof Card> = {
  title: "Primitives/Card",
  component: Card,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj<typeof Card>;

export const Default: Story = {
  render: () => (
    <Card className="w-72">
      <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
        A simple card with default padding.
      </p>
    </Card>
  ),
};

export const WithHeader: Story = {
  render: () => (
    <Card className="w-72">
      <CardHeader
        title="Security"
        description="Manage your security settings"
        icon={<Shield className="w-4 h-4" />}
        action={<Button size="sm" variant="ghost">Edit</Button>}
      />
      <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
        Card content goes here.
      </p>
    </Card>
  ),
};

export const WithContent: Story = {
  render: () => (
    <Card className="w-72">
      <CardHeader title="Configuration" />
      <div className="space-y-2">
        <div className="flex justify-between text-xs">
          <span style={{ color: "var(--color-text-muted)" }}>Protocol</span>
          <span style={{ color: "var(--color-text-primary)" }}>TrustTunnel</span>
        </div>
        <div className="flex justify-between text-xs">
          <span style={{ color: "var(--color-text-muted)" }}>Status</span>
          <span style={{ color: "var(--color-status-connected)" }}>Connected</span>
        </div>
      </div>
    </Card>
  ),
};

export const Empty: Story = {
  render: () => <Card className="w-72">{null}</Card>,
};
