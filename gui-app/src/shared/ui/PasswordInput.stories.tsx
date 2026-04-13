import type { Meta, StoryObj } from "@storybook/react";
import { PasswordInput } from "./PasswordInput";

const meta: Meta<typeof PasswordInput> = {
  title: "Primitives/PasswordInput",
  component: PasswordInput,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof PasswordInput>;

export const Default: Story = {
  args: {
    placeholder: "Enter password...",
  },
};

export const WithLabel: Story = {
  args: {
    label: "Password",
    placeholder: "Enter your password",
  },
};

export const WithHelperText: Story = {
  args: {
    label: "Password",
    placeholder: "Enter your password",
    helperText: "Must be at least 8 characters",
  },
};

export const WithError: Story = {
  args: {
    label: "Password",
    placeholder: "Enter your password",
    error: "Password is too short",
    value: "abc",
    onChange: () => {},
  },
};

export const ShowPassword: Story = {
  args: {
    label: "Password",
    placeholder: "Click the eye icon to reveal",
    value: "super-secret-password",
    onChange: () => {},
  },
};

export const NoLockIcon: Story = {
  args: {
    label: "Password",
    placeholder: "Without lock icon",
    showIcon: false,
  },
};

export const Disabled: Story = {
  args: {
    label: "Password",
    placeholder: "Disabled",
    disabled: true,
    value: "hidden-password",
    onChange: () => {},
  },
};
