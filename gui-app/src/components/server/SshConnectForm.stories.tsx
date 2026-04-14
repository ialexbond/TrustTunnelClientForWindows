import type { Meta, StoryObj } from "@storybook/react";
import { SshConnectForm } from "./SshConnectForm";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";

const meta: Meta<typeof SshConnectForm> = {
  title: "Screens/SshConnectForm",
  component: SshConnectForm,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <SnackBarProvider>
        <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
          <Story />
        </div>
      </SnackBarProvider>
    ),
  ],
  args: {
    onConnect: () => console.log("[Story] onConnect called"),
  },
};

export default meta;
type Story = StoryObj<typeof SshConnectForm>;

/**
 * Default state: empty form, password auth mode.
 * Connect button is disabled until host and password are filled.
 * Switch theme via toolbar (dark/light) to verify both themes.
 */
export const Default: Story = {};

/**
 * Password mode — explicitly named for clarity.
 * Identical to Default, documents the initial auth mode.
 */
export const PasswordMode: Story = {
  name: "Password Mode (default)",
};

/**
 * Interactive key modes: click the "SSH ключ" button in the auth toggle
 * to switch to key-file mode, then "Вставить" to switch to key-paste mode.
 * Both modes are accessible via user interaction within this same story.
 */
export const KeyMode: Story = {
  name: "Key Mode (click 'SSH ключ' to activate)",
};
