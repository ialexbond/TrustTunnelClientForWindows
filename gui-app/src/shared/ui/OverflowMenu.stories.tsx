import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Pencil, Trash2, Copy, RefreshCw } from "lucide-react";
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu";

const meta = {
  title: "Primitives/OverflowMenu",
  component: OverflowMenu,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: {
    triggerAriaLabel: "More options",
  },
} satisfies Meta<typeof OverflowMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

const defaultItems: OverflowMenuItem[] = [
  { label: "Edit", icon: <Pencil className="w-3.5 h-3.5" />, onSelect: () => {} },
  { label: "Copy", icon: <Copy className="w-3.5 h-3.5" />, onSelect: () => {} },
];

export const Default: Story = {
  args: {
    items: defaultItems,
  },
};

export const MultipleItems: Story = {
  args: {
    items: [
      { label: "Edit", icon: <Pencil className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Copy", icon: <Copy className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Refresh", icon: <RefreshCw className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Delete", icon: <Trash2 className="w-3.5 h-3.5" />, onSelect: () => {}, destructive: true },
    ],
  },
};

export const WithDestructiveItem: Story = {
  args: {
    items: [
      { label: "Edit", icon: <Pencil className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Delete", icon: <Trash2 className="w-3.5 h-3.5" />, onSelect: () => {}, destructive: true },
    ],
  },
};

export const WithDisabledItem: Story = {
  args: {
    items: [
      { label: "Edit", icon: <Pencil className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Copy (unavailable)", icon: <Copy className="w-3.5 h-3.5" />, onSelect: () => {}, disabled: true },
      { label: "Delete", icon: <Trash2 className="w-3.5 h-3.5" />, onSelect: () => {}, destructive: true },
    ],
  },
};

export const WithLoadingItem: Story = {
  render: () => {
    const [loading, setLoading] = useState(false);
    const items: OverflowMenuItem[] = [
      {
        label: loading ? "Refreshing..." : "Refresh",
        icon: <RefreshCw className="w-3.5 h-3.5" />,
        loading,
        onSelect: () => {
          setLoading(true);
          setTimeout(() => setLoading(false), 2000);
        },
      },
      { label: "Delete", icon: <Trash2 className="w-3.5 h-3.5" />, onSelect: () => {}, destructive: true },
    ];
    return <OverflowMenu items={items} triggerAriaLabel="More options" />;
  },
};
