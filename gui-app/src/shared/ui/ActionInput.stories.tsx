import type { Meta, StoryObj } from "@storybook/react";
import { Copy, Eye } from "lucide-react";
import { ActionInput } from "./ActionInput";

const meta: Meta<typeof ActionInput> = {
  title: "Primitives/ActionInput",
  component: ActionInput,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof ActionInput>;

export const Default: Story = {
  args: {
    placeholder: "Enter value...",
  },
};

export const WithLabel: Story = {
  args: {
    label: "Server Address",
    placeholder: "192.168.1.1",
  },
};

export const WithHelperText: Story = {
  args: {
    label: "Server Address",
    placeholder: "192.168.1.1",
    helperText: "Enter the IP address or hostname of your server",
  },
};

export const WithError: Story = {
  args: {
    label: "Server Address",
    placeholder: "192.168.1.1",
    error: "Invalid IP address format",
    value: "not-an-ip",
    onChange: () => {},
  },
};

export const WithAction: Story = {
  args: {
    label: "Connection String",
    placeholder: "Paste connection string...",
    value: "vpn://user@server:8443",
    onChange: () => {},
    actions: [
      <Copy
        key="copy"
        size={14}
        style={{ cursor: "pointer" }}
        onClick={() => navigator.clipboard.writeText("vpn://user@server:8443")}
      />,
    ],
  },
};

export const WithMultipleActions: Story = {
  args: {
    label: "Config Value",
    placeholder: "Enter config...",
    value: "some-config-value",
    onChange: () => {},
    actions: [
      <Eye key="view" size={14} style={{ cursor: "pointer" }} />,
      <Copy key="copy" size={14} style={{ cursor: "pointer" }} />,
    ],
  },
};

export const Disabled: Story = {
  args: {
    label: "Server Address",
    placeholder: "Disabled",
    disabled: true,
    value: "192.168.1.1",
    onChange: () => {},
  },
};
