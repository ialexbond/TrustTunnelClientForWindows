import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Toggle } from "./Toggle";
import { Wifi } from "lucide-react";

const meta: Meta<typeof Toggle> = {
  title: "Primitives/Toggle",
  component: Toggle,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj<typeof Toggle>;

function ToggleDemo(props: Omit<React.ComponentProps<typeof Toggle>, "onChange">) {
  const [checked, setChecked] = useState(props.checked ?? false);
  return <Toggle {...props} checked={checked} onChange={setChecked} />;
}

export const Default: Story = {
  render: () => <ToggleDemo label="Enable feature" />,
};

export const Checked: Story = {
  render: () => <ToggleDemo label="Feature enabled" checked={true} />,
};

export const Disabled: Story = {
  render: () => <ToggleDemo label="Disabled toggle" disabled />,
};

export const WithLabel: Story = {
  render: () => (
    <ToggleDemo
      label="Kill Switch"
      description="Block all traffic when VPN disconnects"
      icon={<Wifi className="w-4 h-4" />}
    />
  ),
};

export const AllStates: Story = {
  render: () => (
    <div className="space-y-2 w-64">
      <ToggleDemo label="Off state" checked={false} />
      <ToggleDemo label="On state" checked={true} />
      <ToggleDemo label="Disabled off" checked={false} disabled />
      <ToggleDemo label="Disabled on" checked={true} disabled />
    </div>
  ),
};
