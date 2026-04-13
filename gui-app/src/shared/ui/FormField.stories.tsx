import type { Meta, StoryObj } from "@storybook/react";
import { FormField } from "./FormField";

const meta: Meta<typeof FormField> = {
  title: "Primitives/FormField",
  component: FormField,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof FormField>;

export const Default: Story = {
  render: () => (
    <FormField label="Имя пользователя" className="w-72">
      <input
        type="text"
        placeholder="Введите имя"
        style={{
          width: "100%",
          padding: "6px var(--space-3)",
          fontSize: "var(--font-size-md)",
          color: "var(--color-text-primary)",
          background: "var(--color-input-bg)",
          border: "1px solid var(--color-input-border)",
          borderRadius: "var(--radius-md)",
          outline: "none",
        }}
      />
    </FormField>
  ),
};

export const Required: Story = {
  render: () => (
    <FormField label="Email" required className="w-72">
      <input
        type="email"
        placeholder="user@example.com"
        style={{
          width: "100%",
          padding: "6px var(--space-3)",
          fontSize: "var(--font-size-md)",
          color: "var(--color-text-primary)",
          background: "var(--color-input-bg)",
          border: "1px solid var(--color-input-border)",
          borderRadius: "var(--radius-md)",
          outline: "none",
        }}
      />
    </FormField>
  ),
};

export const WithHint: Story = {
  render: () => (
    <FormField label="SSH порт" hint="Стандартный порт: 22. Измените только если необходимо." className="w-72">
      <input
        type="number"
        defaultValue={22}
        style={{
          width: "100%",
          padding: "6px var(--space-3)",
          fontSize: "var(--font-size-md)",
          color: "var(--color-text-primary)",
          background: "var(--color-input-bg)",
          border: "1px solid var(--color-input-border)",
          borderRadius: "var(--radius-md)",
          outline: "none",
        }}
      />
    </FormField>
  ),
};

export const WithError: Story = {
  render: () => (
    <FormField label="Пароль" required error="Пароль должен содержать минимум 8 символов" className="w-72">
      <input
        type="password"
        defaultValue="123"
        style={{
          width: "100%",
          padding: "6px var(--space-3)",
          fontSize: "var(--font-size-md)",
          color: "var(--color-text-primary)",
          background: "var(--color-status-error-bg)",
          border: "1px solid var(--color-status-error-border, var(--color-status-error))",
          borderRadius: "var(--radius-md)",
          outline: "none",
        }}
      />
    </FormField>
  ),
};

export const WithInputAndError: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", width: "288px" }}>
      <FormField label="Сервер" required error="Укажите действительный адрес сервера">
        <input
          type="text"
          defaultValue="invalid@@server"
          style={{
            width: "100%",
            padding: "6px var(--space-3)",
            fontSize: "var(--font-size-md)",
            color: "var(--color-text-primary)",
            background: "var(--color-status-error-bg)",
            border: "1px solid var(--color-status-error)",
            borderRadius: "var(--radius-md)",
            outline: "none",
          }}
        />
      </FormField>
    </div>
  ),
};

export const MultipleFields: Story = {
  render: () => (
    <form style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", width: "288px" }}>
      <FormField label="Хост" required>
        <input
          type="text"
          placeholder="192.168.1.100"
          style={{
            width: "100%",
            padding: "6px var(--space-3)",
            fontSize: "var(--font-size-md)",
            color: "var(--color-text-primary)",
            background: "var(--color-input-bg)",
            border: "1px solid var(--color-input-border)",
            borderRadius: "var(--radius-md)",
            outline: "none",
          }}
        />
      </FormField>
      <FormField label="Порт" hint="Диапазон: 1–65535">
        <input
          type="number"
          defaultValue={22}
          style={{
            width: "100%",
            padding: "6px var(--space-3)",
            fontSize: "var(--font-size-md)",
            color: "var(--color-text-primary)",
            background: "var(--color-input-bg)",
            border: "1px solid var(--color-input-border)",
            borderRadius: "var(--radius-md)",
            outline: "none",
          }}
        />
      </FormField>
      <FormField label="Пользователь" required>
        <input
          type="text"
          placeholder="root"
          style={{
            width: "100%",
            padding: "6px var(--space-3)",
            fontSize: "var(--font-size-md)",
            color: "var(--color-text-primary)",
            background: "var(--color-input-bg)",
            border: "1px solid var(--color-input-border)",
            borderRadius: "var(--radius-md)",
            outline: "none",
          }}
        />
      </FormField>
    </form>
  ),
};
