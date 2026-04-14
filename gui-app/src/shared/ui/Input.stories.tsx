import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Search } from "lucide-react";
import { Input } from "./Input";

const meta: Meta<typeof Input> = {
  title: "Primitives/Input",
  component: Input,
  tags: ["autodocs"],
  argTypes: {
    placeholder: { control: "text" },
    helperText: { control: "text" },
    error: { control: "text" },
    clearable: { control: "boolean" },
    disabled: { control: "boolean" },
    label: { control: "text" },
  },
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof Input>;

export const Default: Story = {
  args: {
    placeholder: "Enter value...",
  },
};

export const WithLabel: Story = {
  args: {
    label: "Username",
    placeholder: "Enter username",
  },
};

export const WithPlaceholder: Story = {
  args: {
    placeholder: "Type something here...",
  },
};

export const WithHelperText: Story = {
  args: {
    label: "Email",
    placeholder: "user@example.com",
    helperText: "We will never share your email with anyone.",
  },
};

export const WithError: Story = {
  args: {
    label: "Email",
    placeholder: "user@example.com",
    error: "Please enter a valid email address.",
    value: "not-an-email",
    onChange: () => {},
  },
};

export const Clearable: Story = {
  render: (args) => {
    const [value, setValue] = useState("Some text to clear");
    return (
      <Input
        {...args}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        clearable
        placeholder="Type and clear..."
      />
    );
  },
};

export const WithIcon: Story = {
  args: {
    placeholder: "Search...",
    icon: <Search size={14} />,
  },
};

export const Disabled: Story = {
  args: {
    placeholder: "Disabled input",
    disabled: true,
    value: "Cannot edit this",
    onChange: () => {},
  },
};

function ClearableInAllStates() {
  const [val, setVal] = useState("Clearable");
  return (
    <div>
      <p className="text-xs text-[var(--color-text-muted)] mb-2 uppercase tracking-wide">Clearable</p>
      <Input value={val} onChange={(e) => setVal(e.target.value)} clearable placeholder="Clearable" />
    </div>
  );
}

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-4 max-w-xs">
      <div>
        <p className="text-xs text-[var(--color-text-muted)] mb-2 uppercase tracking-wide">Default</p>
        <Input placeholder="Default state" />
      </div>
      <div>
        <p className="text-xs text-[var(--color-text-muted)] mb-2 uppercase tracking-wide">With value</p>
        <Input value="Some input value" onChange={() => {}} placeholder="With value" />
      </div>
      <div>
        <p className="text-xs text-[var(--color-text-muted)] mb-2 uppercase tracking-wide">Error</p>
        <Input
          value="Bad value"
          onChange={() => {}}
          error="This field is required"
          placeholder="Error state"
        />
      </div>
      <div>
        <p className="text-xs text-[var(--color-text-muted)] mb-2 uppercase tracking-wide">Disabled</p>
        <Input disabled placeholder="Disabled state" />
      </div>
      <div>
        <p className="text-xs text-[var(--color-text-muted)] mb-2 uppercase tracking-wide">With helper text</p>
        <Input placeholder="With helper" helperText="Helpful hint below the input" />
      </div>
      <ClearableInAllStates />
    </div>
  ),
};
