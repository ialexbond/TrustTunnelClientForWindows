import type { Meta, StoryObj } from "@storybook/react";
import { Skeleton } from "./Skeleton";

const meta = {
  title: "Primitives/Skeleton",
  component: Skeleton,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: { type: "select" }, options: ["line", "circle", "card"] },
    width: { control: { type: "text" } },
    height: { control: { type: "text" } },
    rounded: { control: "boolean" },
  },
  args: { variant: "line", width: 200, height: 16 },
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Variants: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Skeleton variant="line" width={200} height={16} />
      <Skeleton variant="circle" width={40} height={40} />
      <Skeleton variant="card" width={200} height={80} />
    </div>
  ),
};

export const TextBlock: Story = {
  name: "Text Block",
  render: () => (
    <div className="flex flex-col gap-2" style={{ width: 300 }}>
      <Skeleton variant="line" width="100%" height={16} />
      <Skeleton variant="line" width="80%" height={16} />
      <Skeleton variant="line" width="60%" height={16} />
    </div>
  ),
};
