/* eslint-disable no-console -- storybook stories use console.log to demo callbacks */
import type { Meta, StoryObj } from "@storybook/react";
import { TitleBar } from "./TitleBar";
import { WindowControls } from "./WindowControls";

/**
 * TitleBar -- compact 32px bar with Shield icon, "TrustTunnel" brand, "PRO" badge,
 * and a children slot for WindowControls.
 *
 * - Transparent background (inherits from parent).
 * - data-tauri-drag-region is a DOM attribute; dragging is Tauri-only, inert in Storybook.
 * - WindowControls use mocked Tauri window API (.storybook/tauri-mocks/api-window.ts).
 */
const meta: Meta<typeof TitleBar> = {
  title: "Layout/TitleBar",
  component: TitleBar,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div style={{ backgroundColor: "var(--color-bg-primary)" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof TitleBar>;

/** Default: brand (Shield + "TrustTunnel" + PRO badge), no children. */
export const Default: Story = {};

/**
 * With WindowControls passed as children -- full title bar as used in App.tsx.
 * Hover minimize / maximize / close to see interactive states.
 */
export const WithWindowControls: Story = {
  render: () => (
    <TitleBar>
      <WindowControls />
    </TitleBar>
  ),
};

/**
 * With custom children slot -- demonstrates the children API
 * with arbitrary content in the right section.
 */
export const WithCustomChildren: Story = {
  render: () => (
    <TitleBar>
      <button
        onClick={() => console.log("[Story] custom action clicked")}
        style={{
          fontSize: 11,
          padding: "2px 8px",
          marginRight: 8,
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--color-border)",
          background: "var(--color-bg-elevated)",
          color: "var(--color-text-secondary)",
          cursor: "pointer",
        }}
      >
        Custom Action
      </button>
    </TitleBar>
  ),
};
