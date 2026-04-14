import type { Meta, StoryObj } from "@storybook/react";
import { SshConnectForm } from "./SshConnectForm";

const meta: Meta<typeof SshConnectForm> = {
  title: "Screens/SshConnectForm",
  component: SshConnectForm,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
        <Story />
      </div>
    ),
  ],
  args: {
    onConnect: () => console.log("[Story] onConnect called"),
  },
};

export default meta;
type Story = StoryObj<typeof SshConnectForm>;

/**
 * Форма подключения к серверу. Начальное состояние — режим пароля.
 * Переключите на SSH-ключ прямо в форме, чтобы увидеть файловый/вставочный режим.
 * Тему (dark/light) можно переключить через тулбар сверху.
 */
export const Default: Story = {};
