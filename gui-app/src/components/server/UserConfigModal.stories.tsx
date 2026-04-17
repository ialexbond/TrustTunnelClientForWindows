import type { Meta, StoryObj } from "@storybook/react";
import { UserConfigModal } from "./UserConfigModal";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";

/**
 * Phase 14 mockup-first stories for the new UserConfigModal compound.
 *
 * The component itself is a stub in 14-01 (props signature + static
 * visual shell); Plan 04 wires the real deeplink invoke(), clipboard
 * flow, and save-as dialog. These stories demonstrate every visual
 * state (Default, Loading, Error, Long Deeplink, Light Theme) using
 * Storybook-only props `_deeplinkOverride`, `_forceLoading`, and
 * `_forceError` — production call sites never pass these.
 */

const mockSshParams = {
  host: "192.168.1.100",
  port: 22,
  user: "root",
  password: "***",
};

const meta: Meta<typeof UserConfigModal> = {
  title: "Screens/UserConfigModal",
  component: UserConfigModal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <SnackBarProvider>
        <div
          style={{
            minHeight: "100vh",
            backgroundColor: "var(--color-bg-primary)",
          }}
        >
          <Story />
        </div>
      </SnackBarProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default state: full modal layout — clickable QR (D-09), read-only
 * deeplink input with inline Copy icon, primary Download button, and
 * absolute-positioned X close (D-10/D-11).
 */
export const Default: Story = {
  args: {
    isOpen: true,
    username: "swift-fox",
    sshParams: mockSshParams,
    onClose: () => {},
    _deeplinkOverride:
      "tt://example.com/config?token=abc123xyz&user=swift-fox",
  },
};

/** Loading: deeplink fetch in flight — spinner centered in modal body. */
export const Loading: Story = {
  args: {
    isOpen: true,
    username: "swift-fox",
    sshParams: mockSshParams,
    onClose: () => {},
    _forceLoading: true,
  },
};

/** Error: deeplink fetch failed (rare — SSH or backend issue). */
export const Error: Story = {
  args: {
    isOpen: true,
    username: "swift-fox",
    sshParams: mockSshParams,
    onClose: () => {},
    _forceError: "Не удалось получить deeplink: SSH connection failed",
  },
};

/**
 * Long deeplink: 400+ char token — verifies truncation in the
 * read-only input and Copy action positioning.
 */
export const LongDeeplink: Story = {
  args: {
    isOpen: true,
    username: "bold-eagle42",
    sshParams: mockSshParams,
    onClose: () => {},
    _deeplinkOverride:
      "tt://example.com/config?token=" + "a".repeat(400) + "&user=bold-eagle42",
  },
};

/** Same content as Default, rendered under data-theme="light" tokens. */
export const LightTheme: Story = {
  args: {
    isOpen: true,
    username: "swift-fox",
    sshParams: mockSshParams,
    onClose: () => {},
    _deeplinkOverride:
      "tt://example.com/config?token=abc123&user=swift-fox",
  },
  decorators: [
    (Story) => (
      <SnackBarProvider>
        <div
          data-theme="light"
          style={{
            minHeight: "100vh",
            backgroundColor: "var(--color-bg-primary)",
          }}
        >
          <Story />
        </div>
      </SnackBarProvider>
    ),
  ],
};
