import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { ProgressBar } from "./ProgressBar";

const meta: Meta<typeof ProgressBar> = {
  title: "Primitives/ProgressBar",
  component: ProgressBar,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof ProgressBar>;

export const Default: Story = {
  name: "Default (value=50)",
  args: {
    value: 50,
  },
  render: (args) => (
    <div style={{ width: 320, padding: 16 }}>
      <ProgressBar {...args} />
    </div>
  ),
};

export const Empty: Story = {
  name: "Empty (value=0)",
  args: {
    value: 0,
  },
  render: (args) => (
    <div style={{ width: 320, padding: 16 }}>
      <ProgressBar {...args} />
    </div>
  ),
};

export const Full: Story = {
  name: "Full (value=100)",
  args: {
    value: 100,
  },
  render: (args) => (
    <div style={{ width: 320, padding: 16 }}>
      <ProgressBar {...args} />
    </div>
  ),
};

export const WithLabel: Story = {
  name: "WithLabel (с меткой)",
  args: {
    value: 40,
    label: "Шаг 2 из 5",
  },
  render: (args) => (
    <div style={{ width: 320, padding: 16 }}>
      <ProgressBar {...args} />
    </div>
  ),
};

export const WithValue: Story = {
  name: "WithValue (showValue=true)",
  args: {
    value: 65,
    showValue: true,
  },
  render: (args) => (
    <div style={{ width: 320, padding: 16 }}>
      <ProgressBar {...args} />
    </div>
  ),
};

export const WithLabelAndValue: Story = {
  name: "WithLabelAndValue (метка + процент)",
  args: {
    value: 75,
    label: "Загрузка конфига",
    showValue: true,
  },
  render: (args) => (
    <div style={{ width: 320, padding: 16 }}>
      <ProgressBar {...args} />
    </div>
  ),
};

export const AnimatedProgress: Story = {
  name: "AnimatedProgress (интерактивный)",
  render: () => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const [value, setValue] = useState(0);

    return (
      <div style={{ width: 320, padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
        <ProgressBar value={value} label="Деплой" showValue />
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setValue((v) => Math.min(100, v + 10))}
            style={{
              padding: "6px 12px",
              background: "var(--color-accent-interactive)",
              color: "var(--color-text-inverse)",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            +10%
          </button>
          <button
            onClick={() => setValue(0)}
            style={{
              padding: "6px 12px",
              background: "var(--color-bg-hover)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Сброс
          </button>
        </div>
      </div>
    );
  },
};
