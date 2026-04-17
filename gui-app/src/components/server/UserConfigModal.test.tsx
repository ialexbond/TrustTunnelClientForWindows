import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import i18n from "../../shared/i18n";
import { UserConfigModal } from "./UserConfigModal";
import { renderWithProviders as render } from "../../test/test-utils";

// Mock qrcode.react so tests don't pull the real SVG renderer.
vi.mock("qrcode.react", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  QRCodeSVG: (props: any) => (
    <svg
      data-testid="qr-code"
      data-value={props.value}
      width={props.size}
      height={props.size}
    />
  ),
}));

// Mock useActivityLog — spy on log calls for D-29 security verification.
const activityLogSpy = vi.fn();
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: activityLogSpy }),
}));

// Mock tauri.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));

const mockSshParams = {
  host: "192.168.1.100",
  port: 22,
  user: "root",
  password: "***",
};

describe("UserConfigModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activityLogSpy.mockClear();
    i18n.changeLanguage("ru");

    // Mock clipboard API — writeText + write.
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
        write: vi.fn().mockResolvedValue(undefined),
      },
    });
    // Provide ClipboardItem for happy path (tests override for fallback).
    (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = class {
      constructor(_data: Record<string, Blob>) {
        void _data;
      }
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not render when isOpen=false", () => {
    const { container } = render(
      <UserConfigModal
        isOpen={false}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    // WR-03: UserConfigModal returns null when isOpen=false — container stays empty.
    // (Prior assertion `[role="dialog"]` was a false-positive — Modal primitive
    // does not set role="dialog", so the selector was null regardless of state.)
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId("qr-code")).not.toBeInTheDocument();
  });

  it("fetches deeplink via invoke when opened", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(
      "tt://example.com/config?token=abc",
    );
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_export_config_deeplink", {
        ...mockSshParams,
        clientName: "swift-fox",
      });
    });
  });

  it("renders QR code with fetched deeplink (240px)", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(
      "tt://example.com/config?token=abc",
    );
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    const qr = await screen.findByTestId("qr-code");
    expect(qr).toHaveAttribute("data-value", "tt://example.com/config?token=abc");
    expect(qr).toHaveAttribute("width", "240");
  });

  it("bypasses invoke when _deeplinkOverride provided (Storybook)", async () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://overridden.com/test"
      />,
    );
    await waitFor(() => {
      const qr = screen.getByTestId("qr-code");
      expect(qr).toHaveAttribute("data-value", "tt://overridden.com/test");
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "server_export_config_deeplink",
      expect.anything(),
    );
  });

  it("calls onClose when X button clicked", async () => {
    const onClose = vi.fn();
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={onClose}
        _deeplinkOverride="tt://test"
      />,
    );
    const closeBtn = await screen.findByRole("button", {
      name: i18n.t("buttons.close"),
    });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("copies deeplink text when Copy icon clicked (D-23)", async () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test-link"
      />,
    );
    const copyBtn = await screen.findByRole("button", {
      name: i18n.t("server.users.copy_deeplink_tooltip"),
    });
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "tt://test-link",
      );
    });
    expect(activityLogSpy).toHaveBeenCalledWith(
      "USER",
      expect.stringContaining("user.config.link_copied user=swift-fox"),
    );
  });

  it("falls back to text copy when ClipboardItem is unavailable (D-09)", async () => {
    delete (globalThis as unknown as { ClipboardItem?: unknown }).ClipboardItem;

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://fallback-test"
      />,
    );
    const qrBtn = await screen.findByRole("button", {
      name: i18n.t("server.users.qr_click_to_copy"),
    });
    fireEvent.click(qrBtn);
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "tt://fallback-test",
      );
    });
    expect(activityLogSpy).toHaveBeenCalledWith(
      "USER",
      expect.stringContaining("fallback=no-clipboarditem"),
    );
  });

  it("D-29 SECURITY: activity log never contains deeplink value", async () => {
    delete (globalThis as unknown as { ClipboardItem?: unknown }).ClipboardItem;

    const secret =
      "tt://example.com/config?secret_token=ABC-SECRET-DO-NOT-LEAK-123";
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride={secret}
      />,
    );
    const qrBtn = await screen.findByRole("button", {
      name: i18n.t("server.users.qr_click_to_copy"),
    });
    const copyBtn = await screen.findByRole("button", {
      name: i18n.t("server.users.copy_deeplink_tooltip"),
    });
    fireEvent.click(qrBtn);
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalled();
    });

    const allLogCalls = activityLogSpy.mock.calls;
    for (const call of allLogCalls) {
      const message = String(call[1] ?? "");
      expect(message).not.toContain("ABC-SECRET-DO-NOT-LEAK-123");
      expect(message).not.toContain("secret_token");
    }
  });

  it("Download button invokes fetch_server_config + save + copy_file (D-27)", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "fetch_server_config") return "/tmp/test.toml";
      if (cmd === "copy_file") return undefined;
      return null;
    });
    vi.mocked(save).mockResolvedValueOnce("/home/user/config.toml");

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test"
      />,
    );
    const downloadBtn = await screen.findByRole("button", {
      name: new RegExp(i18n.t("server.users.download_config"), "i"),
    });
    fireEvent.click(downloadBtn);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "fetch_server_config",
        expect.objectContaining({ clientName: "swift-fox" }),
      );
    });
    await waitFor(() => {
      expect(save).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "copy_file",
        expect.objectContaining({ destination: "/home/user/config.toml" }),
      );
    });
    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalledWith(
        "STATE",
        expect.stringContaining("user.config.downloaded user=swift-fox"),
      );
    });
  });

  it("Download cancelled (user closes save dialog) does not invoke copy_file", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "fetch_server_config") return "/tmp/test.toml";
      return null;
    });
    vi.mocked(save).mockResolvedValueOnce(null);

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://test"
      />,
    );
    const downloadBtn = await screen.findByRole("button", {
      name: new RegExp(i18n.t("server.users.download_config"), "i"),
    });
    fireEvent.click(downloadBtn);

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(invoke).not.toHaveBeenCalledWith(
      "copy_file",
      expect.anything(),
    );
  });

  it("shows loading state when deeplink fetch is in flight", () => {
    vi.mocked(invoke).mockReturnValueOnce(new Promise(() => {}));
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    const spinner = document.querySelector("svg.animate-spin");
    expect(spinner).toBeInTheDocument();
  });

  it("shows error state with retry button when deeplink fetch fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("SSH connection failed"));
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/SSH connection failed/i)).toBeInTheDocument();
    });
    const retryBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("buttons.retry"), "i"),
    });
    expect(retryBtn).toBeInTheDocument();
  });

  it("retries deeplink fetch when retry button clicked", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("first fail"));
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    const retryBtn = await screen.findByRole("button", {
      name: new RegExp(i18n.t("buttons.retry"), "i"),
    });
    vi.mocked(invoke).mockResolvedValueOnce("tt://retry-success");
    fireEvent.click(retryBtn);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(2);
    });
  });

  it("_forceLoading prop displays loading state (storybook)", () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _forceLoading
      />,
    );
    const spinner = document.querySelector("svg.animate-spin");
    expect(spinner).toBeInTheDocument();
  });

  it("_forceError prop displays error state (storybook)", () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _forceError="Mock error for storybook"
      />,
    );
    expect(screen.getByText(/Mock error for storybook/)).toBeInTheDocument();
  });
});
