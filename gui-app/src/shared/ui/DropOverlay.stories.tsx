import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { DropOverlay } from "./DropOverlay";

const meta: Meta<typeof DropOverlay> = {
  title: "Primitives/DropOverlay",
  component: DropOverlay,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof DropOverlay>;

export const Default: Story = {
  args: {
    isDragging: false,
  },
  render: (args) => (
    <div
      style={{
        width: "100%",
        height: "400px",
        background: "var(--color-bg-primary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--color-text-secondary)",
        position: "relative",
      }}
    >
      <p>Drag a file over this area to see the overlay</p>
      <DropOverlay {...args} />
    </div>
  ),
};

export const Active: Story = {
  args: {
    isDragging: true,
  },
  render: (args) => (
    <div
      style={{
        width: "100%",
        height: "400px",
        background: "var(--color-bg-primary)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--color-text-secondary)",
        position: "relative",
      }}
    >
      <p>Underlying content</p>
      <DropOverlay {...args} />
    </div>
  ),
};

export const Interactive: Story = {
  render: () => {
    const [isDragging, setIsDragging] = useState(false);

    return (
      <div
        style={{
          width: "100%",
          height: "400px",
          background: "var(--color-bg-primary)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-text-secondary)",
          border: "2px dashed var(--color-border)",
          position: "relative",
        }}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={() => setIsDragging(false)}
      >
        <p>Drag a file here to trigger the overlay</p>
        <DropOverlay isDragging={isDragging} />
      </div>
    );
  },
};
