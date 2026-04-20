import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { Copy, Shuffle } from "lucide-react";
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

export const WithClearable: Story = {
  render: () => {
    const [value, setValue] = useState("p@ssw0rd123");
    return (
      <ActionPasswordInput
        value={value}
        onChange={(e) => setValue(e.target.value)}
        clearable
        onClear={() => setValue("")}
        onVisibilityToggle={() => {
          // Demo hook for activity log callback — D-28
        }}
        placeholder="Password"
        label="Password (clearable + visibility)"
      />
    );
  },
};

export const WithClearableAndRegenerate: Story = {
  render: () => {
    const [value, setValue] = useState("Xk8mN2pQrS9tVwYz");
    return (
      <ActionPasswordInput
        value={value}
        onChange={(e) => setValue(e.target.value)}
        clearable
        onClear={() => setValue("")}
        onVisibilityToggle={() => {
          // Demo hook for activity log callback — D-28
        }}
        placeholder="Password"
        label="Full set: regen + clear + eye"
        showLockIcon={false}
        actions={[
          <button
            key="gen"
            type="button"
            onClick={() => {
              const charset =
                "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
              setValue(
                Array.from({ length: 16 }, () =>
                  charset[Math.floor(Math.random() * charset.length)]
                ).join("")
              );
            }}
            style={{ cursor: "pointer", background: "transparent", border: 0, padding: 0 }}
            aria-label="Regenerate password"
          >
            <Shuffle size={14} />
          </button>,
        ]}
      />
    );
  },
};
