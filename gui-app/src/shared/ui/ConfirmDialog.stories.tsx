import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./Button";

const meta: Meta<typeof ConfirmDialog> = {
  title: "Primitives/ConfirmDialog",
  component: ConfirmDialog,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj<typeof ConfirmDialog>;

function ConfirmDemo({
  confirmText,
  cancelText,
  message,
  title,
  variant,
}: {
  confirmText?: string;
  cancelText?: string;
  message?: string;
  title?: string;
  variant?: "danger" | "warning";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open Dialog</Button>
      <ConfirmDialog
        isOpen={open}
        title={title ?? "Удалить элемент?"}
        message={message ?? "Это действие необратимо."}
        confirmText={confirmText}
        cancelText={cancelText}
        variant={variant}
        onConfirm={() => setOpen(false)}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

export const Default: Story = {
  render: () => <ConfirmDemo />,
};

export const CustomText: Story = {
  render: () => (
    <ConfirmDemo
      title="Отключить функцию?"
      confirmText="Отключить"
      cancelText="Оставить"
      variant="warning"
    />
  ),
};

export const WithLongMessage: Story = {
  render: () => (
    <ConfirmDemo
      title="Удалить конфигурацию?"
      message="Вы собираетесь удалить конфигурацию VPN-сервера. Все настройки будут безвозвратно удалены, и вам потребуется заново настроить подключение. Это действие нельзя отменить."
    />
  ),
};
