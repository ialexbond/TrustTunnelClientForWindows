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

/**
 * FIX-JJ (2026-04-18): Loading state spec.
 *
 * When the user clicks "Confirm" and the async action is in flight:
 *   ✓ Confirm + Cancel buttons are `disabled` with the primary showing a spinner
 *   ✓ Backdrop click does NOT close the dialog (`closeOnBackdrop={!loading}`)
 *   ✓ Escape does NOT close the dialog
 *   ✗ The page/tab behind the dialog MUST NOT appear disabled or dimmed
 *     — that was the recurring complaint. The blurred backdrop already
 *     provides isolation; the BUSY signal lives inside the dialog only.
 *
 * Consumers of `useConfirm` should NOT propagate their own "busy" flag to
 * the tab underneath while this dialog is open — the dialog owns the UX.
 * See memory/v3/design-system/known-issues.md for the full invariant.
 */
export const Loading: Story = {
  render: () => (
    <ConfirmDialog
      isOpen
      title="Удалить пользователя?"
      message="Пользователь «swift-fox» будет удалён с сервера. Это действие нельзя отменить."
      confirmText="Да, удалить"
      cancelText="Отмена"
      variant="danger"
      loading
      onConfirm={() => {
        /* noop in story */
      }}
      onCancel={() => {
        /* noop in story */
      }}
    />
  ),
};
