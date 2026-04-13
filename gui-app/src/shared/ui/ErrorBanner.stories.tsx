import type { Meta, StoryObj } from "@storybook/react";
import { ErrorBanner } from "./ErrorBanner";

const meta = {
  title: "Primitives/ErrorBanner",
  component: ErrorBanner,
  tags: ["autodocs"],
  argTypes: {
    severity: {
      control: { type: "select" },
      options: ["error", "warning", "info"],
    },
    message: { control: "text" },
    onDismiss: { action: "dismissed" },
  },
  args: {
    message: "Something went wrong. Please try again.",
    severity: "error",
  },
} satisfies Meta<typeof ErrorBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AllSeverities: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <ErrorBanner severity="error" message="Connection failed: unable to reach the gateway." />
      <ErrorBanner severity="warning" message="Gateway is slow to respond. Retrying..." />
      <ErrorBanner severity="info" message="A new version is available. Restart to update." />
    </div>
  ),
};

export const Dismissible: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <ErrorBanner
        severity="error"
        message="Authentication failed. Check your credentials."
        onDismiss={() => {}}
      />
      <ErrorBanner
        severity="warning"
        message="Session will expire in 5 minutes."
        onDismiss={() => {}}
      />
    </div>
  ),
};

export const WithLongMessage: Story = {
  args: {
    severity: "error",
    message:
      "Failed to establish SSH tunnel: the remote server rejected the connection with error code 1001. " +
      "Please verify your server address, port, and credentials are correct, then try again.",
  },
};
