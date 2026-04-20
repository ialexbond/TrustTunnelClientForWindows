import type { Meta, StoryObj } from "@storybook/react";
import { Settings, Trash2, Copy, RefreshCw } from "lucide-react";
import { IconButton } from "./IconButton";

const meta: Meta<typeof IconButton> = {
  title: "Primitives/IconButton",
  component: IconButton,
  tags: ["autodocs"],
  args: {
    "aria-label": "Action button",
    icon: <Settings className="w-4 h-4" />,
  },
};

export default meta;
type Story = StoryObj<typeof IconButton>;

export const Default: Story = {
  args: {
    "aria-label": "Settings",
    icon: <Settings className="w-4 h-4" />,
  },
};

export const WithTooltip: Story = {
  args: {
    "aria-label": "Copy to clipboard",
    icon: <Copy className="w-4 h-4" />,
    tooltip: "Copy to clipboard",
  },
};

export const Disabled: Story = {
  args: {
    "aria-label": "Delete (disabled)",
    icon: <Trash2 className="w-4 h-4" />,
    tooltip: "Cannot delete",
    disabled: true,
  },
};

export const Loading: Story = {
  args: {
    "aria-label": "Refreshing...",
    icon: <RefreshCw className="w-4 h-4" />,
    tooltip: "Loading",
    loading: true,
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 8, alignItems: "center", padding: 16 }}>
      <IconButton aria-label="Settings" icon={<Settings className="w-4 h-4" />} tooltip="Settings" />
      <IconButton aria-label="Copy" icon={<Copy className="w-4 h-4" />} tooltip="Copy" />
      <IconButton aria-label="Delete" icon={<Trash2 className="w-4 h-4" />} tooltip="Delete" />
      <IconButton aria-label="Refresh (loading)" icon={<RefreshCw className="w-4 h-4" />} loading tooltip="Loading..." />
      <IconButton aria-label="Disabled" icon={<Settings className="w-4 h-4" />} disabled tooltip="Disabled" />
    </div>
  ),
};
