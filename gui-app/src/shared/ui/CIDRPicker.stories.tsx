import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { CIDRPicker } from "./CIDRPicker";

const meta: Meta<typeof CIDRPicker> = {
  title: "Primitives/CIDRPicker",
  component: CIDRPicker,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Structured IP/prefix picker for CIDR restrictions. Four octet NumberInputs + prefix Select (0-32). Empty state = no CIDR restriction. `0.0.0.0/0` = explicit allow-all.",
      },
    },
  },
  argTypes: {
    value: { control: "text" },
    disabled: { control: "boolean" },
    label: { control: "text" },
    helperText: { control: "text" },
  },
};
export default meta;

type Story = StoryObj<typeof meta>;

/** Default empty state — no CIDR restriction. Helper text shows `без ограничений`. */
export const Empty: Story = {
  render: (args) => {
    const [value, setValue] = useState("");
    return (
      <div style={{ width: 360 }}>
        <CIDRPicker {...args} value={value} onChange={setValue} />
      </div>
    );
  },
  args: {
    label: "CIDR restriction",
  },
};

/** Valid CIDR — 10.0.0.0/24. Helper text shows computed range. */
export const ValidCidr: Story = {
  render: (args) => {
    const [value, setValue] = useState("10.0.0.0/24");
    return (
      <div style={{ width: 360 }}>
        <CIDRPicker {...args} value={value} onChange={setValue} />
      </div>
    );
  },
  args: {
    label: "CIDR restriction",
  },
};

/** Allow-all (0.0.0.0/0). Explicit rule written to rules.toml. Helper text shows localized `все адреса`. */
export const AllowAll: Story = {
  render: (args) => {
    const [value, setValue] = useState("0.0.0.0/0");
    return (
      <div style={{ width: 360 }}>
        <CIDRPicker {...args} value={value} onChange={setValue} />
      </div>
    );
  },
  args: {
    label: "CIDR restriction",
  },
};

/** Maximum specificity — single host (/32). */
export const SingleHost: Story = {
  render: (args) => {
    const [value, setValue] = useState("192.168.1.100/32");
    return (
      <div style={{ width: 360 }}>
        <CIDRPicker {...args} value={value} onChange={setValue} />
      </div>
    );
  },
  args: {
    label: "Pin to single host",
  },
};

/** Disabled state — during backend save in-flight. */
export const Disabled: Story = {
  render: () => (
    <div style={{ width: 360 }}>
      <CIDRPicker value="10.0.0.0/24" onChange={() => {}} disabled label="CIDR (read-only)" />
    </div>
  ),
};

/** Custom helper text — overrides auto-description. */
export const CustomHelperText: Story = {
  render: (args) => {
    const [value, setValue] = useState("10.0.0.0/24");
    return (
      <div style={{ width: 360 }}>
        <CIDRPicker
          {...args}
          value={value}
          onChange={setValue}
          helperText="Customize CIDR for your internal network segment"
        />
      </div>
    );
  },
  args: {
    label: "CIDR restriction",
  },
};

/**
 * Light theme — verifies tokens resolve correctly.
 * Wraps content in `data-theme="light"` to force light palette.
 */
export const LightTheme: Story = {
  render: () => {
    const [value, setValue] = useState("10.0.0.0/24");
    return (
      <div
        data-theme="light"
        style={{ padding: "24px", backgroundColor: "var(--color-bg-primary)", width: 400 }}
      >
        <CIDRPicker value={value} onChange={setValue} label="CIDR restriction" />
      </div>
    );
  },
};

/** Dark theme (explicit) — dark mode contrast verification. */
export const DarkTheme: Story = {
  render: () => {
    const [value, setValue] = useState("10.0.0.0/24");
    return (
      <div
        data-theme="dark"
        style={{ padding: "24px", backgroundColor: "var(--color-bg-primary)", width: 400 }}
      >
        <CIDRPicker value={value} onChange={setValue} label="CIDR restriction" />
      </div>
    );
  },
};
