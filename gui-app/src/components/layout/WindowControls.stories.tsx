import type { Meta, StoryObj } from "@storybook/react";
import { WindowControls } from "./WindowControls";

/**
 * WindowControls -- minimize / close buttons for the custom Tauri title bar.
 *
 * **Phase 13.UAT:** Maximize removed. Window is resizable within min/max bounds
 * but cannot be maximized (tauri.conf.json `maximizable: false`). Matches the
 * UX pattern of compact single-view desktop apps (Amnezia VPN and similar).
 *
 * Two buttons with rounded square hover states:
 * - Minimize: --color-bg-hover background on hover
 * - Close: --color-destructive background + --color-text-inverse on hover
 *
 * Tooltips provided via shared Tooltip primitive (not native `title=`) — portal,
 * 400ms delay, `position="bottom"` so they don't clip above the title bar.
 *
 * Tauri window API (minimize, close) is mocked via
 * .storybook/tauri-mocks/api-window.ts -- clicks are no-ops in Storybook.
 */
const meta: Meta<typeof WindowControls> = {
  title: "Layout/WindowControls",
  component: WindowControls,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div
        style={{
          backgroundColor: "var(--color-bg-primary)",
          height: 32,
          display: "flex",
          alignItems: "center",
          padding: "0 8px",
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
 * Default idle state. Hover each button to see interactive states:
 * minimize (subtle hover), maximize (subtle hover), close (destructive red).
 */
export const Default: Story = {};

/**
 * In TitleBar context -- shows WindowControls as they appear in the actual app,
 * positioned at the right end of the title bar.
 */
export const InTitleBar: Story = {
  decorators: [
    (Story) => (
      <div
        style={{
          backgroundColor: "var(--color-bg-primary)",
          height: 32,
          width: 320,
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
        }}
      >
        <Story />
      </div>
    ),
  ],
};
