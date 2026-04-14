import type { Meta, StoryObj } from "@storybook/react";
import { TitleBar } from "./TitleBar";
import { WindowControls } from "./WindowControls";

/**
 * TitleBar — 32px custom title bar with brand identity and drag region.
 *
 * Notes:
 * - data-tauri-drag-region is a DOM attribute — dragging is Tauri-only, not demonstrable in Storybook.
 * - WindowControls are rendered as children; window minimize/maximize/close buttons are no-ops in Storybook
 *   (mocked via .storybook/tauri-mocks/api-window.ts).
 */
const meta: Meta<typeof TitleBar> = {
  title: "Layout/TitleBar",
  component: TitleBar,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof TitleBar>;

/** Default title bar: brand name + PRO badge, no window controls children. */
export const Default: Story = {};

/**
 * With WindowControls: full title bar as used in App.tsx.
 * Hover minimize/maximize/close to see interactive states.
 */
export const WithWindowControls: Story = {
  render: () => (
    <TitleBar>
      <WindowControls />
    </TitleBar>
  ),
};
