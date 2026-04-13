import type { Meta, StoryObj } from "@storybook/react";
import { Inbox, ServerOff, WifiOff } from "lucide-react";
import { EmptyState } from "./EmptyState";
import { Button } from "./Button";

const meta: Meta<typeof EmptyState> = {
  title: "Primitives/EmptyState",
  component: EmptyState,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof EmptyState>;

export const Default: Story = {
  render: () => (
    <div style={{ width: "360px", background: "var(--color-bg-surface)", borderRadius: "var(--radius-lg)", padding: "var(--space-4)" }}>
      <EmptyState />
    </div>
  ),
};

export const WithIcon: Story = {
  render: () => (
    <div style={{ width: "360px", background: "var(--color-bg-surface)", borderRadius: "var(--radius-lg)", padding: "var(--space-4)" }}>
      <EmptyState
        icon={<Inbox className="w-10 h-10" />}
        heading="Список пуст"
        body="Добавьте первое соединение, чтобы начать."
      />
    </div>
  ),
};

export const WithAction: Story = {
  render: () => (
    <div style={{ width: "360px", background: "var(--color-bg-surface)", borderRadius: "var(--radius-lg)", padding: "var(--space-4)" }}>
      <EmptyState
        icon={<ServerOff className="w-10 h-10" />}
        heading="Нет серверов"
        body="Подключитесь к серверу или импортируйте конфигурацию."
        action={<Button size="sm" variant="primary">Добавить сервер</Button>}
      />
    </div>
  ),
};

export const CustomText: Story = {
  render: () => (
    <div style={{ width: "360px", background: "var(--color-bg-surface)", borderRadius: "var(--radius-lg)", padding: "var(--space-4)" }}>
      <EmptyState
        icon={<WifiOff className="w-10 h-10" />}
        heading="Нет подключений"
        body="Все ваши VPN-соединения появятся здесь после настройки."
      />
    </div>
  ),
};

export const MinimalNoIcon: Story = {
  render: () => (
    <div style={{ width: "360px", background: "var(--color-bg-surface)", borderRadius: "var(--radius-lg)", padding: "var(--space-4)" }}>
      <EmptyState heading="Пусто" body="Здесь ничего нет." />
    </div>
  ),
};
