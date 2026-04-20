import type { Meta, StoryObj } from "@storybook/react";
import { Tooltip } from "./Tooltip";
import { Button } from "./Button";

const meta: Meta<typeof Tooltip> = {
  title: "Primitives/Tooltip",
  component: Tooltip,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj<typeof Tooltip>;

export const Default: Story = {
  render: () => (
    <Tooltip text="This is a helpful tooltip" delay={0}>
      <Button variant="ghost" size="sm">Hover me</Button>
    </Tooltip>
  ),
};

export const Positions: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-8 p-16">
      <Tooltip text="Tooltip above" position="top" delay={0}>
        <Button variant="ghost" size="sm">Top</Button>
      </Tooltip>
      <Tooltip text="Tooltip below" position="bottom" delay={0}>
        <Button variant="ghost" size="sm">Bottom</Button>
      </Tooltip>
      <Tooltip text="Tooltip to the left" position="left" delay={0}>
        <Button variant="ghost" size="sm">Left</Button>
      </Tooltip>
      <Tooltip text="Tooltip to the right" position="right" delay={0}>
        <Button variant="ghost" size="sm">Right</Button>
      </Tooltip>
    </div>
  ),
};

export const LongText: Story = {
  render: () => (
    <Tooltip
      text="This is a much longer tooltip text that wraps across multiple lines to demonstrate how the tooltip handles longer content without breaking the layout."
      delay={0}
    >
      <Button variant="ghost" size="sm">Long tooltip</Button>
    </Tooltip>
  ),
};
