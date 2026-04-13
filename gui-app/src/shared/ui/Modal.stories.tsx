import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";

const meta: Meta<typeof Modal> = {
  title: "Primitives/Modal",
  component: Modal,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj<typeof Modal>;

function ModalDemo({
  size,
  title,
  children,
}: {
  size?: "sm" | "md" | "lg";
  title?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open Modal</Button>
      <Modal isOpen={open} onClose={() => setOpen(false)} size={size} title={title}>
        {children ?? (
          <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
            This is the modal content.
          </p>
        )}
        <div className="flex justify-end mt-4">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </Modal>
    </>
  );
}

export const Default: Story = {
  render: () => <ModalDemo />,
};

export const Small: Story = {
  render: () => <ModalDemo size="sm" title="Small Modal" />,
};

export const Large: Story = {
  render: () => <ModalDemo size="lg" title="Large Modal" />,
};

export const WithTitle: Story = {
  render: () => <ModalDemo title="Dialog Title" />,
};

export const WithLongContent: Story = {
  render: () => (
    <ModalDemo title="Long Content Modal">
      <div className="space-y-3">
        {Array.from({ length: 8 }, (_, i) => (
          <p key={i} className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
            Paragraph {i + 1}: Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do
            eiusmod tempor incididunt ut labore.
          </p>
        ))}
      </div>
    </ModalDemo>
  ),
};
