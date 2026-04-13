import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { SnackBar } from "./SnackBar";

const meta: Meta<typeof SnackBar> = {
  title: "Primitives/SnackBar",
  component: SnackBar,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof SnackBar>;

export const Default: Story = {
  render: () => {
    const [messages, setMessages] = useState<string[]>([]);
    const [shown, setShown] = useState(0);

    const push = (msg: string) => setMessages((prev) => [...prev, msg]);
    const onShown = () => setShown((n) => n + 1);

    if (shown > 0 && shown >= messages.length) {
      setTimeout(() => {
        setMessages([]);
        setShown(0);
      }, 4000);
    }

    return (
      <div style={{ padding: 24 }}>
        <button
          onClick={() => push("Settings saved successfully")}
          style={{
            padding: "8px 16px",
            background: "var(--color-accent-interactive)",
            color: "var(--color-text-on-accent)",
            border: "none",
            borderRadius: "var(--radius-md)",
            cursor: "pointer",
          }}
        >
          Show success snackbar
        </button>
        <SnackBar messages={messages} onShown={onShown} />
      </div>
    );
  },
};

export const Error: Story = {
  render: () => {
    const [messages, setMessages] = useState<Array<string | { text: string; type: "error" }>>([]);
    const onShown = () => {};

    return (
      <div style={{ padding: 24 }}>
        <button
          onClick={() =>
            setMessages((prev) => [
              ...prev,
              { text: "Connection failed: timeout after 30s", type: "error" as const },
            ])
          }
          style={{
            padding: "8px 16px",
            background: "var(--color-status-error)",
            color: "white",
            border: "none",
            borderRadius: "var(--radius-md)",
            cursor: "pointer",
          }}
        >
          Show error snackbar
        </button>
        <SnackBar messages={messages} onShown={onShown} />
      </div>
    );
  },
};

export const Success: Story = {
  render: () => {
    const [messages, setMessages] = useState<string[]>(["VPN connected successfully"]);
    const onShown = () => {};

    return (
      <div style={{ padding: 24 }}>
        <p style={{ color: "var(--color-text-secondary)", fontSize: "var(--font-size-sm)" }}>
          Success snackbar with auto-dismiss (3s)
        </p>
        <SnackBar messages={messages} onShown={onShown} />
      </div>
    );
  },
};

export const AutoDismiss: Story = {
  render: () => {
    const [messages, setMessages] = useState<string[]>([]);
    const onShown = () => {};

    return (
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 8 }}>
        <button
          onClick={() => setMessages(["Auto-dismisses in 3 seconds"])}
          style={{
            padding: "8px 16px",
            background: "var(--color-bg-elevated)",
            color: "var(--color-text-primary)",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-md)",
            cursor: "pointer",
          }}
        >
          Trigger auto-dismiss (3s)
        </button>
        <SnackBar messages={messages} onShown={onShown} duration={3000} />
      </div>
    );
  },
};
