import type { Meta, StoryObj } from "@storybook/react";
import { Copy } from "lucide-react";
import { ActionPasswordInput } from "./ActionPasswordInput";

const meta: Meta<typeof ActionPasswordInput> = {
  title: "Primitives/ActionPasswordInput",
  component: ActionPasswordInput,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof ActionPasswordInput>;

export const Default: Story = {
  args: {
    placeholder: "Enter password...",
  },
};

export const WithLabel: Story = {
  args: {
    label: "VPN Password",
    placeholder: "Enter VPN password",
  },
};

export const WithHelperText: Story = {
  args: {
    label: "VPN Password",
    placeholder: "Enter VPN password",
    helperText: "Password used to authenticate with VPN gateway",
  },
};

export const WithError: Story = {
  args: {
    label: "VPN Password",
    placeholder: "Enter VPN password",
    error: "Authentication failed — check your password",
    value: "wrongpass",
    onChange: () => {},
  },
};

export const WithAction: Story = {
  args: {
    label: "Secret Key",
    placeholder: "Enter secret key...",
    value: "my-secret-vpn-key",
    onChange: () => {},
    actions: [
      <Copy
        key="copy"
        size={14}
        style={{ cursor: "pointer" }}
        onClick={() => navigator.clipboard.writeText("my-secret-vpn-key")}
      />,
    ],
  },
};

export const ShowPassword: Story = {
  args: {
    label: "Secret Key",
    placeholder: "Click eye to reveal",
    value: "super-secret-password-value",
    onChange: () => {},
  },
};

export const NoLockIcon: Story = {
  args: {
    label: "Password",
    placeholder: "Without lock icon",
    showLockIcon: false,
  },
};

export const Disabled: Story = {
  args: {
    label: "VPN Password",
    placeholder: "Disabled",
    disabled: true,
    value: "hidden-secret",
    onChange: () => {},
  },
};
