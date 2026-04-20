import type { Meta, StoryObj } from "@storybook/react";
import { Accordion } from "./Accordion";

const sampleItems = [
  { id: "1", title: "General Settings", content: <p>Application preferences and defaults.</p> },
  { id: "2", title: "Security", content: <p>Firewall rules, certificates, and access control.</p> },
  { id: "3", title: "Advanced", content: <p>Network tuning, DNS settings, and diagnostics.</p> },
];

const meta = {
  title: "Primitives/Accordion",
  component: Accordion,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: { items: sampleItems },
} satisfies Meta<typeof Accordion>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const MultiOpen: Story = {
  args: { defaultOpen: ["1", "2"] },
};

export const SingleMode: Story = {
  args: { single: true, defaultOpen: ["1"] },
};

export const AllClosed: Story = {
  args: { defaultOpen: [] },
};
