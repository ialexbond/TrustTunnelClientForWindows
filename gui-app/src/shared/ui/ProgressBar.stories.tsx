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
  argTypes: {
    value: { control: { type: "range", min: 0, max: 100, step: 1 } },
    max: { control: { type: "number" } },
    size: { control: "select", options: ["sm", "md", "lg"] },
    color: { control: "select", options: ["accent", "success", "warning", "danger"] },
  },
};

export default meta;
type Story = StoryObj<typeof ProgressBar>;

export const Default: Story = {
  name: "Default (value=50, md, accent)",
  args: {
    value: 50,
    label: "Прогресс",
  },
  render: (args) => (
    <div style={{ width: 320, padding: 16 }}>
      <ProgressBar {...args} />
    </div>
  ),
};

export const Small: Story = {
  name: "Small (size=sm)",
  args: {
    value: 60,
    size: "sm",
    label: "Маленький",
  },
  render: (args) => (
    <div style={{ width: 320, padding: 16 }}>
      <ProgressBar {...args} />
    </div>
  ),
};

export const Large: Story = {
  name: "Large (size=lg)",
  args: {
    value: 75,
    size: "lg",
    label: "Большой",
  },
  render: (args) => (
    <div style={{ width: 320, padding: 16 }}>
      <ProgressBar {...args} />
    </div>
  ),
};

export const Warning: Story = {
  name: "Warning (color=warning)",
  args: {
    value: 70,
    color: "warning",
    label: "Нагрузка CPU",
  },
  render: (args) => (
    <div style={{ width: 320, padding: 16 }}>
      <ProgressBar {...args} />
    </div>
  ),
};

export const Danger: Story = {
  name: "Danger (color=danger)",
  args: {
    value: 92,
    color: "danger",
    label: "Память",
  },
  render: (args) => (
    <div style={{ width: 320, padding: 16 }}>
      <ProgressBar {...args} />
    </div>
  ),
};

export const Success: Story = {
  name: "Success (color=success)",
  args: {
    value: 100,
    color: "success",
    label: "Завершено",
  },
  render: (args) => (
    <div style={{ width: 320, padding: 16 }}>
      <ProgressBar {...args} />
    </div>
  ),
};

export const MultipleValues: Story = {
  name: "MultipleValues (все размеры и цвета)",
  render: () => (
    <div style={{ width: 360, padding: 16, display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>sm</span>
        <ProgressBar value={30} size="sm" color="accent" label="Загрузка конфига (sm)" />
        <ProgressBar value={60} size="sm" color="success" label="Память (sm, success)" />
        <ProgressBar value={75} size="sm" color="warning" label="CPU (sm, warning)" />
        <ProgressBar value={90} size="sm" color="danger" label="Диск (sm, danger)" />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>md (default)</span>
        <ProgressBar value={30} size="md" color="accent" label="Загрузка конфига (md)" />
        <ProgressBar value={60} size="md" color="success" label="Память (md, success)" />
        <ProgressBar value={75} size="md" color="warning" label="CPU (md, warning)" />
        <ProgressBar value={90} size="md" color="danger" label="Диск (md, danger)" />
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: 12, color: "var(--color-text-muted)" }}>lg</span>
        <ProgressBar value={30} size="lg" color="accent" label="Загрузка конфига (lg)" />
        <ProgressBar value={60} size="lg" color="success" label="Память (lg, success)" />
        <ProgressBar value={75} size="lg" color="warning" label="CPU (lg, warning)" />
        <ProgressBar value={90} size="lg" color="danger" label="Диск (lg, danger)" />
      </div>
    </div>
  ),
};

export const CustomMax: Story = {
  name: "CustomMax (max=200)",
  args: {
    value: 120,
    max: 200,
    color: "accent",
    label: "Кастомный max=200, value=120 (60%)",
  },
  render: (args) => (
    <div style={{ width: 320, padding: 16 }}>
      <ProgressBar {...args} />
    </div>
  ),
};

export const Animated: Story = {
  name: "Animated (интерактивный)",
  render: () => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const [value, setValue] = useState(0);

    return (
      <div style={{ width: 320, padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
        <ProgressBar
          value={value}
          color={value >= 90 ? "danger" : value >= 70 ? "warning" : "accent"}
          label={`Деплой: ${value}%`}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => setValue((v) => Math.min(100, v + 10))}
            style={{
              padding: "6px 12px",
              background: "var(--color-accent-interactive)",
              color: "white",
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
