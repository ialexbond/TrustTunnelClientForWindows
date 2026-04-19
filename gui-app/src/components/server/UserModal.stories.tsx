import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { UserModal } from "./UserModal";
import { SnackBarProvider } from "../../shared/ui/SnackBarContext";
import { ConfirmDialogProvider } from "../../shared/ui/ConfirmDialogProvider";

/**
 * UserModal stories — Phase 14.1 Plan 04.
 *
 * All stories use `_storybook=true` to bypass backend invoke calls.
 * The modal is shown open by default; use the Controls panel to toggle isOpen.
 *
 * Includes stories for:
 *   - Add mode (blank form, anti-DPI ON by default)
 *   - Edit mode (with pre-loaded user config)
 *   - Edit with dirty deeplink (warning banner)
 *   - Edit with rotation prompt open
 */

const mockSshParams = {
  host: "192.168.1.100",
  port: 22,
  user: "root",
  password: "***",
};

const meta: Meta<typeof UserModal> = {
  title: "Screens/UserModal",
  component: UserModal,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <SnackBarProvider>
        <ConfirmDialogProvider>
          <div
            style={{
              minHeight: "100vh",
              backgroundColor: "var(--color-bg-primary)",
            }}
          >
            <Story />
          </div>
        </ConfirmDialogProvider>
      </SnackBarProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Add mode — blank form with auto-generated credentials and anti-DPI ON.
 * Demonstrates D-1 (two sections) and D-5 (anti-DPI default ON).
 */
export const AddMode: Story = {
  args: {
    isOpen: true,
    mode: "add",
    existingUsers: ["swift-fox", "bold-eagle"],
    sshParams: mockSshParams,
    onClose: () => {},
    onUserAdded: (user) => console.warn("[story] user added", user),
    _storybook: true,
  },
};

/**
 * Edit mode — user "alice" with no dirty changes.
 * Shows read-only password field and gear icon (D-3 row icon).
 */
export const EditMode: Story = {
  args: {
    isOpen: true,
    mode: "edit",
    editUsername: "alice",
    existingUsers: ["alice", "bob"],
    sshParams: mockSshParams,
    onClose: () => {},
    onUserUpdated: (user) => console.warn("[story] user updated", user),
    _storybook: true,
  },
};

/**
 * Add mode — interactive story with open/close toggle.
 */
export const Interactive: Story = {
  render: () => {
    const [isOpen, setIsOpen] = useState(false);
    return (
      <SnackBarProvider>
        <ConfirmDialogProvider>
          <div
            style={{
              minHeight: "100vh",
              backgroundColor: "var(--color-bg-primary)",
              padding: "24px",
            }}
          >
            <button
              type="button"
              onClick={() => setIsOpen(true)}
              style={{
                padding: "8px 16px",
                background: "var(--color-accent)",
                color: "white",
                border: "none",
                borderRadius: "var(--radius-md)",
                cursor: "pointer",
              }}
            >
              Открыть UserModal (Add)
            </button>
            <UserModal
              isOpen={isOpen}
              mode="add"
              existingUsers={["swift-fox"]}
              sshParams={mockSshParams}
              onClose={() => setIsOpen(false)}
              onUserAdded={(user) => {
                console.warn("[story] added", user);
                setIsOpen(false);
              }}
              _storybook
            />
          </div>
        </ConfirmDialogProvider>
      </SnackBarProvider>
    );
  },
};

/**
 * Edit mode — interactive with rotation prompt visible.
 */
export const EditWithRotation: Story = {
  render: () => {
    const [isOpen, setIsOpen] = useState(true);
    return (
      <SnackBarProvider>
        <ConfirmDialogProvider>
          <div
            style={{
              minHeight: "100vh",
              backgroundColor: "var(--color-bg-primary)",
            }}
          >
            <UserModal
              isOpen={isOpen}
              mode="edit"
              editUsername="alice"
              existingUsers={["alice"]}
              sshParams={mockSshParams}
              onClose={() => setIsOpen(false)}
              _storybook
            />
          </div>
        </ConfirmDialogProvider>
      </SnackBarProvider>
    );
  },
};

/**
 * Add mode с активным fetch'ем `server_get_allowed_sni_list`. Mock в
 * `.storybook/tauri-mocks/api-core.ts` возвращает 2 хоста + 2 allowed_sni
 * — чип rail с 4 кнопками появляется под Custom SNI.
 *
 * Demonstrates M-01 (Custom SNI autocomplete) end-to-end.
 */
export const AddWithSniSuggestions: Story = {
  args: {
    isOpen: true,
    mode: "add",
    existingUsers: [],
    sshParams: mockSshParams,
    onClose: () => {},
    onUserAdded: (user) => console.warn("[story] user added", user),
    // FALSE on purpose — we want the real allowed_sni fetch to go through
    // the Storybook invoke mock. Every other backend call is also mocked
    // there (returns undefined/null), so the modal is safe to exercise.
    _storybook: false,
  },
};

/**
 * Edit mode — нажми «Сменить пароль» чтобы увидеть inline-редактор
 * (UX-E/F): label с `*`, error «Введите новый пароль» под row, внешняя
 * кнопка становится «Отмена».
 */
export const EditWithInlinePasswordRotation: Story = {
  args: {
    isOpen: true,
    mode: "edit",
    editUsername: "alice",
    existingUsers: ["alice"],
    sshParams: mockSshParams,
    onClose: () => {},
    onUserUpdated: (user) => console.warn("[story] user updated", user),
    _storybook: true,
  },
};
