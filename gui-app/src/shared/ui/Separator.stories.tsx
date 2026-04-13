import type { Meta, StoryObj } from "@storybook/react";
import { Separator } from "./Separator";

const meta: Meta<typeof Separator> = {
  title: "Primitives/Separator",
  component: Separator,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof Separator>;

export const Default: Story = {
  name: "Default (horizontal)",
  render: () => (
    <div style={{ width: 320, padding: 16 }}>
      <p style={{ color: "var(--color-text-secondary)", marginBottom: 12 }}>
        Контент выше
      </p>
      <Separator />
      <p style={{ color: "var(--color-text-secondary)", marginTop: 12 }}>
        Контент ниже
      </p>
    </div>
  ),
};

export const WithLabel: Story = {
  name: "WithLabel (с меткой «или»)",
  render: () => (
    <div style={{ width: 320, padding: 16 }}>
      <p style={{ color: "var(--color-text-secondary)", marginBottom: 12 }}>
        Войти с паролем
      </p>
      <Separator label="или" />
      <p style={{ color: "var(--color-text-secondary)", marginTop: 12 }}>
        Войти через SSO
      </p>
    </div>
  ),
};

export const Vertical: Story = {
  name: "Vertical (вертикальный)",
  render: () => (
    <div style={{ display: "flex", alignItems: "center", height: 48, gap: 12, padding: 16 }}>
      <span style={{ color: "var(--color-text-primary)" }}>Раздел A</span>
      <Separator orientation="vertical" />
      <span style={{ color: "var(--color-text-primary)" }}>Раздел B</span>
      <Separator orientation="vertical" />
      <span style={{ color: "var(--color-text-primary)" }}>Раздел C</span>
    </div>
  ),
};

export const InFormLayout: Story = {
  name: "InFormLayout (между секциями формы)",
  render: () => (
    <div style={{ width: 360, padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <p style={{ color: "var(--color-text-secondary)", fontSize: 12, marginBottom: 4 }}>
          Хост
        </p>
        <div
          style={{
            background: "var(--color-input-bg)",
            border: "1px solid var(--color-input-border)",
            borderRadius: 6,
            padding: "8px 12px",
            color: "var(--color-text-primary)",
            fontSize: 14,
          }}
        >
          10.0.0.1
        </div>
      </div>
      <Separator label="Дополнительно" />
      <div>
        <p style={{ color: "var(--color-text-secondary)", fontSize: 12, marginBottom: 4 }}>
          Таймаут (сек)
        </p>
        <div
          style={{
            background: "var(--color-input-bg)",
            border: "1px solid var(--color-input-border)",
            borderRadius: 6,
            padding: "8px 12px",
            color: "var(--color-text-primary)",
            fontSize: 14,
          }}
        >
          30
        </div>
      </div>
    </div>
  ),
};
