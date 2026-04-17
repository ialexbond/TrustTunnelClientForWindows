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

// ═════════════════════════════════════════════════════════════════════════
// Lifecycle contract demo — open + close оба плавные 200ms ease-out.
// При правильном использовании Modal (БЕЗ `if (!isOpen) return null` в parent'е)
// exit-анимация играется корректно: opacity 1→0, scale 1→0.95, translateY 0→2px.
// ═════════════════════════════════════════════════════════════════════════

/**
 * LifecycleContract: demonstrates the correct Modal usage pattern.
 *
 * Modal primitive manages its own mount/unmount timing via `mounted` + `animating`
 * state. Parent components MUST NOT `return null` before `<Modal>` — that would
 * unmount the tree instantly and kill the 200ms exit transition.
 *
 * See: `Modal.tsx` JSDoc · `memory/v3/design-system/known-issues.md` #10 ·
 *      `CLAUDE.md` Gotchas section.
 *
 * Reopen this story and click Open/Close несколько раз подряд — обрати внимание
 * на плавный fade+scale обоих направлений.
 */
export const LifecycleContract: Story = {
  render: () => (
    <ModalDemo title="Open and close — both animate 200ms">
      <div className="space-y-3">
        <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
          ✅ <strong>Правильный паттерн:</strong> parent передаёт{" "}
          <code>isOpen</code> в <code>&lt;Modal&gt;</code> как есть. Modal сам
          управляет lifecycle: enter 200ms + exit 200ms.
        </p>
        <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
          ❌ <strong>Анти-паттерн:</strong>{" "}
          <code>if (!isOpen) return null;</code> до <code>&lt;Modal&gt;</code> —
          React unmount'ит дерево мгновенно, exit-анимация не играется.
        </p>
      </div>
    </ModalDemo>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "Эталонный пример использования Modal primitive. Parent просто передаёт `isOpen` — Modal сам делает 200ms enter/exit transitions. Никогда не делайте `if (!isOpen) return null` перед `<Modal>` — это сломает exit-анимацию (см. `Modal.tsx` JSDoc и known-issues.md #10).",
      },
    },
  },
};
