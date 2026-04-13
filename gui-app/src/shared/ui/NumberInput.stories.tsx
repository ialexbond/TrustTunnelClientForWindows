import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { NumberInput } from "./NumberInput";

const meta: Meta<typeof NumberInput> = {
  title: "Primitives/NumberInput",
  component: NumberInput,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof NumberInput>;

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState("");
    return <NumberInput value={value} onChange={setValue} placeholder="Enter a number" />;
  },
};

export const WithLabel: Story = {
  render: () => {
    const [value, setValue] = useState("");
    return <NumberInput value={value} onChange={setValue} label="Port" placeholder="1024-65535" />;
  },
};

export const WithHelperText: Story = {
  render: () => {
    const [value, setValue] = useState("");
    return (
      <NumberInput
        value={value}
        onChange={setValue}
        label="Port"
        placeholder="1024-65535"
        helperText="Enter a valid port number between 1024 and 65535"
      />
    );
  },
};

export const WithError: Story = {
  render: () => {
    const [value, setValue] = useState("abc");
    return (
      <NumberInput
        value={value}
        onChange={setValue}
        label="Port"
        placeholder="1024-65535"
        error="Please enter a valid number"
      />
    );
  },
};

export const WithMinMax: Story = {
  render: () => {
    const [value, setValue] = useState("80");
    return (
      <NumberInput
        value={value}
        onChange={setValue}
        label="SSH Port"
        placeholder="1024-65535"
        min={1024}
        max={65535}
        helperText="Blur to validate min/max range"
      />
    );
  },
};

export const Disabled: Story = {
  render: () => (
    <NumberInput value="22" onChange={() => {}} label="Port" disabled />
  ),
};
