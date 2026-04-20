import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { PanelErrorBoundary } from "./PanelErrorBoundary";

const meta: Meta<typeof PanelErrorBoundary> = {
  title: "Primitives/PanelErrorBoundary",
  component: PanelErrorBoundary,
  tags: ["autodocs"],
};

export default meta;
type Story = StoryObj<typeof PanelErrorBoundary>;

/** Component that throws on demand for testing error boundary */
function ThrowingComponent({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error("Simulated panel crash: component render failed");
  }
  return (
    <div
      style={{
        padding: 24,
        color: "var(--color-text-primary)",
        background: "var(--color-bg-surface)",
        borderRadius: "var(--radius-md)",
      }}
    >
      Panel content rendered successfully.
    </div>
  );
}

export const Default: Story = {
  render: () => (
    <PanelErrorBoundary panelName="ExamplePanel">
      <ThrowingComponent shouldThrow={true} />
    </PanelErrorBoundary>
  ),
};

export const WithRetry: Story = {
  render: () => {
    const [shouldThrow, setShouldThrow] = useState(true);

    return (
      <PanelErrorBoundary
        panelName="RetryPanel"
        onNavigateHome={() => setShouldThrow(false)}
      >
        <ThrowingComponent shouldThrow={shouldThrow} />
      </PanelErrorBoundary>
    );
  },
};

export const NormalState: Story = {
  render: () => (
    <PanelErrorBoundary panelName="WorkingPanel">
      <ThrowingComponent shouldThrow={false} />
    </PanelErrorBoundary>
  ),
};
