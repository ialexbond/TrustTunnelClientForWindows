import type { Meta, StoryObj } from "@storybook/react";
import { Section, SectionHeader } from "./Section";
import { Button } from "./Button";

const meta: Meta<typeof Section> = {
  title: "Primitives/Section",
  component: Section,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof Section>;

export const Default: Story = {
  render: () => (
    <Section title="Основные настройки">
      <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
        Контент секции появляется здесь. Section группирует связанный контент с заголовком.
      </p>
    </Section>
  ),
};

export const WithDescription: Story = {
  render: () => (
    <Section title="Безопасность" description="Управление параметрами безопасного соединения">
      <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
        Настройки безопасности отображаются здесь.
      </p>
    </Section>
  ),
};

export const Collapsible: Story = {
  render: () => (
    <Section title="Дополнительные параметры" collapsible defaultOpen>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
        <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
          Этот контент можно скрыть нажатием на заголовок.
        </p>
        <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
          Используйте collapsible секции для необязательных настроек.
        </p>
      </div>
    </Section>
  ),
};

export const CollapsedByDefault: Story = {
  render: () => (
    <Section
      title="Расширенные настройки"
      description="Скрыто по умолчанию"
      collapsible
      defaultOpen={false}
    >
      <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
        Этот контент скрыт по умолчанию. Нажмите на заголовок, чтобы развернуть.
      </p>
    </Section>
  ),
};

export const WithAction: Story = {
  render: () => (
    <Section
      title="Сертификаты"
      action={<Button size="sm" variant="ghost">Добавить</Button>}
    >
      <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
        Список сертификатов появится здесь.
      </p>
    </Section>
  ),
};

export const NestedSections: Story = {
  render: () => (
    <Section title="Конфигурация соединения" description="Настройки подключения к VPN">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
        <Section title="Основные" collapsible defaultOpen>
          <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
            Протокол, сервер, порт.
          </p>
        </Section>
        <Section title="Безопасность" collapsible defaultOpen={false}>
          <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
            Сертификаты, ключи, шифрование.
          </p>
        </Section>
      </div>
    </Section>
  ),
};

export const HeaderOnly: Story = {
  render: () => (
    <SectionHeader
      title="Отдельный заголовок"
      description="SectionHeader можно использовать самостоятельно"
      action={<Button size="sm" variant="ghost">Действие</Button>}
    />
  ),
};
