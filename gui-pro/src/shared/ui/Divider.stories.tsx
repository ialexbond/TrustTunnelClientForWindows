import type { Meta, StoryObj } from "@storybook/react";
import { Divider } from "./Divider";

const meta = {
  title: "Primitives/Divider",
  component: Divider,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  argTypes: {
    orientation: {
      control: { type: "select" },
      options: ["horizontal", "vertical"],
    },
  },
  args: {
    orientation: "horizontal",
  },
} satisfies Meta<typeof Divider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  args: { orientation: "horizontal" },
  render: (args) => (
    <div style={{ width: 320, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ color: "var(--color-text-primary)", margin: 0 }}>Section above</p>
      <Divider {...args} />
      <p style={{ color: "var(--color-text-primary)", margin: 0 }}>Section below</p>
    </div>
  ),
};

export const Vertical: Story = {
  args: { orientation: "vertical" },
  render: (args) => (
    <div style={{ height: 48, display: "flex", alignItems: "center", gap: 12, padding: 16 }}>
      <span style={{ color: "var(--color-text-primary)" }}>Left</span>
      <Divider {...args} />
      <span style={{ color: "var(--color-text-primary)" }}>Right</span>
    </div>
  ),
};

export const BothOrientations: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, padding: 16 }}>
      <div style={{ width: 320 }}>
        <p style={{ color: "var(--color-text-muted)", fontSize: 11, marginBottom: 8 }}>Horizontal</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span style={{ color: "var(--color-text-primary)" }}>Above</span>
          <Divider orientation="horizontal" />
          <span style={{ color: "var(--color-text-primary)" }}>Below</span>
        </div>
      </div>
      <div>
        <p style={{ color: "var(--color-text-muted)", fontSize: 11, marginBottom: 8 }}>Vertical</p>
        <div style={{ height: 40, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ color: "var(--color-text-primary)" }}>Left</span>
          <Divider orientation="vertical" />
          <span style={{ color: "var(--color-text-primary)" }}>Right</span>
        </div>
      </div>
    </div>
  ),
};
