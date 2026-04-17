import type { Meta, StoryObj } from "@storybook/react";
import { ArrowDownToLine, ArrowUpFromLine, Gauge, Clock } from "lucide-react";
import { StatCard } from "./StatCard";

const meta = {
  title: "Primitives/StatCard",
  component: StatCard,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  args: { label: "Download", value: "1.24 MB/s" },
} satisfies Meta<typeof StatCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithIcon: Story = {
  args: {
    label: "Download",
    value: "1.24 MB/s",
    icon: <ArrowDownToLine size={16} />,
  },
};

export const WithTrend: Story = {
  render: () => (
    <div className="flex gap-3">
      <StatCard label="Download" value="1.24 MB/s" trend={12} icon={<ArrowDownToLine size={16} />} />
      <StatCard label="Upload" value="0.56 MB/s" trend={-5} icon={<ArrowUpFromLine size={16} />} />
      <StatCard label="Ping" value="42 ms" trend={0} icon={<Gauge size={16} />} />
    </div>
  ),
};

export const Loading: Story = {
  args: { label: "Download", value: "—", loading: true },
};

export const DashboardGrid: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-3" style={{ width: 400 }}>
      <StatCard label="Download" value="1.24 MB/s" trend={12} icon={<ArrowDownToLine size={16} />} />
      <StatCard label="Upload" value="0.56 MB/s" trend={-5} icon={<ArrowUpFromLine size={16} />} />
      <StatCard label="Ping" value="42 ms" icon={<Gauge size={16} />} />
      <StatCard label="Uptime" value="99.9%" icon={<Clock size={16} />} />
    </div>
  ),
};
