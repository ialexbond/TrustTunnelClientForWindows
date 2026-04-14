import type { Meta, StoryObj } from "@storybook/react";
import { WindowControls } from "./WindowControls";

/**
 * WindowControls — minimize / maximize / close buttons for the custom Tauri title bar.
 *
 * Tauri window API (minimize, toggleMaximize, close) is mocked via
 * .storybook/tauri-mocks/api-window.ts — clicks are no-ops in Storybook.
 *
 * Hover each button to see interactive states:
 * - Minimize / Maximize: --color-bg-hover background
 * - Close: --color-destructive background + inverse text (Windows platform exception)
 *
 * Wrapped in a 32px container to simulate the title bar context.
 */
const meta: Meta<typeof WindowControls> = {
  title: "Layout/WindowControls",
  component: WindowControls,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div
        style={{
          backgroundColor: "var(--color-bg-secondary)",
          height: 32,
          display: "flex",
          alignItems: "center",
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof WindowControls>;

/**
 * Default: idle state for all three buttons.
 * Hover to see minimize (--color-bg-hover), maximize (--color-bg-hover),
 * and close (--color-destructive) hover backgrounds.
 */
export const Default: Story = {};
