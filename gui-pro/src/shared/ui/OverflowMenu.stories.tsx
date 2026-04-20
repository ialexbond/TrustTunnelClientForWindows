import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Pencil, Trash2, Copy, RefreshCw, Users, Download, FileText } from "lucide-react";
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu";

const meta: Meta<typeof OverflowMenu> = {
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

// Near-edge viewport stories (Phase 14 — D-12 auto-flip verification).
// parameters.layout="fullscreen" removes Storybook's centered layout so the
// fixed-positioned trigger sits at the viewport edge where auto-flip triggers.

export const NearBottomRight: Story = {
  parameters: { layout: "fullscreen" },
  render: () => (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <div style={{ position: "fixed", bottom: 20, right: 20 }}>
        <OverflowMenu
          items={[
            { label: "Edit", icon: <Pencil className="w-3.5 h-3.5" />, onSelect: () => {} },
            { label: "Copy", icon: <Copy className="w-3.5 h-3.5" />, onSelect: () => {} },
            { label: "Refresh", icon: <RefreshCw className="w-3.5 h-3.5" />, onSelect: () => {} },
            { label: "Delete", icon: <Trash2 className="w-3.5 h-3.5" />, onSelect: () => {}, destructive: true },
          ]}
          triggerAriaLabel="Near bottom-right"
        />
      </div>
    </div>
  ),
};

export const NearTopLeft: Story = {
  parameters: { layout: "fullscreen" },
  render: () => (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <div style={{ position: "fixed", top: 20, left: 20 }}>
        <OverflowMenu
          items={[
            { label: "Edit", icon: <Pencil className="w-3.5 h-3.5" />, onSelect: () => {} },
            { label: "Delete", icon: <Trash2 className="w-3.5 h-3.5" />, onSelect: () => {}, destructive: true },
          ]}
          triggerAriaLabel="Near top-left (default below)"
        />
      </div>
    </div>
  ),
};

export const TallMenuFlipsUp: Story = {
  parameters: { layout: "fullscreen" },
  render: () => {
    // Tall menu (12 items) + trigger near bottom — menu should flip up
    const items: OverflowMenuItem[] = [
      { label: "Download as TOML", icon: <Download className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Download as JSON", icon: <Download className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Download as YAML", icon: <Download className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Copy link", icon: <Copy className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Copy as QR", icon: <Copy className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Show config", icon: <FileText className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Show users", icon: <Users className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Refresh", icon: <RefreshCw className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Edit profile", icon: <Pencil className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Duplicate", icon: <Copy className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Archive", icon: <FileText className="w-3.5 h-3.5" />, onSelect: () => {} },
      { label: "Delete", icon: <Trash2 className="w-3.5 h-3.5" />, onSelect: () => {}, destructive: true },
    ];
    return (
      <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
        <div style={{ position: "fixed", bottom: 30, left: "50%", transform: "translateX(-50%)" }}>
          <OverflowMenu items={items} triggerAriaLabel="Tall menu near bottom" />
        </div>
      </div>
    );
  },
};
