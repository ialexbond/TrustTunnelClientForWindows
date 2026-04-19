import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Search } from "lucide-react";
import { Select } from "./Select";

const meta: Meta<typeof Select> = {
  title: "Primitives/Select",
  component: Select,
  tags: ["autodocs"],
  args: {
    options: [
      { value: "option-1", label: "Option 1" },
      { value: "option-2", label: "Option 2" },
      { value: "option-3", label: "Option 3" },
    ],
  },
};

export default meta;
type Story = StoryObj<typeof Select>;

export const Default: Story = {
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div style={{ width: 280 }}>
        <Select
          {...args}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    );
  },
};

export const WithSelection: Story = {
  render: (args) => {
    const [value, setValue] = useState("option-2");
    return (
      <div style={{ width: 280 }}>
        <Select
          {...args}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          label="Selected option"
        />
      </div>
    );
  },
};

export const WithManyOptions: Story = {
  render: (args) => {
    const [value, setValue] = useState("");
    const manyOptions = Array.from({ length: 20 }, (_, i) => ({
      value: `item-${i + 1}`,
      label: `Item ${i + 1}`,
    }));
    return (
      <div style={{ width: 280 }}>
        <Select
          {...args}
          options={manyOptions}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          label="Many options (scroll)"
          placeholder="Pick an item..."
        />
      </div>
    );
  },
};

export const Disabled: Story = {
  render: (args) => (
    <div style={{ width: 280 }}>
      <Select
        {...args}
        value="option-1"
        onChange={() => {}}
        disabled
        label="Disabled select"
      />
    </div>
  ),
};

export const WithPlaceholder: Story = {
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div style={{ width: 280 }}>
        <Select
          {...args}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Choose an option..."
          label="Custom placeholder"
          description="Select one of the options below"
        />
      </div>
    );
  },
};

export const WithIcon: Story = {
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div style={{ width: 280 }}>
        <Select
          {...args}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          icon={<Search className="w-4 h-4" />}
          label="With icon"
          placeholder="Search options..."
        />
      </div>
    );
  },
};

/**
 * FIX-D: when a dropdown with many options has a value preselected far from
 * the top (here: "30" out of 0..32), opening it must scroll the picked option
 * into view. Previously the list always stayed scrolled to the top and the
 * user had to hunt for their previous choice — breaks "the app remembers what
 * I picked" expectation. Open this story and verify `30` is visible on first
 * click without scrolling.
 */
export const ScrollsToSelected: Story = {
  args: {
    options: Array.from({ length: 33 }, (_, i) => ({
      value: String(i),
      label: String(i),
    })),
  },
  render: (args) => {
    const [value, setValue] = useState("30");
    return (
      <div style={{ width: 140 }}>
        <Select
          {...args}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          label="CIDR-like prefix"
          placeholder="—"
        />
      </div>
    );
  },
};
