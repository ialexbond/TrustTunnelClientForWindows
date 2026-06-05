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

  it("fetches deeplink via invoke when opened (advanced probe FIRST, then basic export)", async () => {
    // FIX (false green :80-98): the old test relied on the GLOBAL `vi.fn()`
    // default returning undefined for the unmocked first probe, so the basic
    // export "happened to" be the only matched call — it never proved the
    // ordering of the two-step fetch (advanced probe → basic fallback). Pin the
    // exact order with mockResolvedValueOnce + toHaveBeenNthCalledWith.
    vi.mocked(invoke)
      .mockResolvedValueOnce(null) // 1st: server_get_user_advanced → no advanced params
      .mockResolvedValueOnce("tt://example.com/config?token=abc"); // 2nd: basic export
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledTimes(2);
    });
    // Probe order is contractual: advanced params first, basic export second.
    expect(invoke).toHaveBeenNthCalledWith(1, "server_get_user_advanced", {
      ...mockSshParams,
      username: "swift-fox",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "server_export_config_deeplink", {
      ...mockSshParams,
      clientName: "swift-fox",
    });
  });

  it("renders QR code with fetched deeplink (240px)", async () => {
    // FIX-NN: fetchDeeplink now probes `server_get_user_advanced` first.
    // Returning null falls through to the basic `server_export_config_deeplink`
    // path, which the second Once-mock answers.
    vi.mocked(invoke).mockResolvedValueOnce(null);
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

  it("shows skeleton loading state when deeplink fetch is in flight", () => {
    vi.mocked(invoke).mockReturnValueOnce(new Promise(() => {}));
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    // Skeleton layout replaces the old spinner — 4 placeholders matching QR/caption/deeplink/download.
    // CSS-coupling FIX: query the busy region by its accessible name (the
    // loading aria-label) instead of `document.querySelector('[aria-busy]')`,
    // which couples the test to a markup attribute rather than the a11y
    // contract a screen-reader actually consumes.
    const busyRegion = screen.getByLabelText(i18n.t("common.loading"));
    expect(busyRegion).toHaveAttribute("aria-busy", "true");
    expect(screen.getByTestId("qr-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("deeplink-skeleton")).toBeInTheDocument();
    expect(screen.getByTestId("download-skeleton")).toBeInTheDocument();
  });

  it("shows error state with retry button when deeplink fetch fails", async () => {
    // FIX-NN: first probe `server_get_user_advanced` (returns null → fall
    // through to basic path), then the basic export rejects.
    vi.mocked(invoke).mockResolvedValueOnce(null);
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
    // FIX-NN: two invokes per fetchDeeplink pass (advanced probe + basic
    // export). First pass: advanced=null, then basic rejects. Second pass
    // on Retry: advanced=null, then basic succeeds.
    vi.mocked(invoke).mockResolvedValueOnce(null);
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
    vi.mocked(invoke).mockResolvedValueOnce(null);
    vi.mocked(invoke).mockResolvedValueOnce("tt://retry-success");
    fireEvent.click(retryBtn);
    await waitFor(() => {
      // 4 total invokes: 2 for initial failed fetch, 2 for successful retry.
      expect(invoke).toHaveBeenCalledTimes(4);
    });
  });

  it("_forceLoading prop displays skeleton loading state (storybook)", () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _forceLoading
      />,
    );
    // CSS-coupling FIX: same accessible-name query as above.
    expect(screen.getByLabelText(i18n.t("common.loading"))).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByTestId("qr-skeleton")).toBeInTheDocument();
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

  // ══════════════════════════════════════════════════════
  // Phase 14 post-install: download blocks close
  // ══════════════════════════════════════════════════════

  it("Download in-flight: X close button is disabled (can't dismiss during SSH)", async () => {
    const onClose = vi.fn();
    // fetch_server_config returns a pending promise — download never completes.
    let resolveFetch!: (v: string) => void;
    const fetchPromise = new Promise<string>((res) => {
      resolveFetch = res;
    });
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "server_export_config_deeplink") {
        return Promise.resolve("tt://?test");
      }
      if (cmd === "fetch_server_config") return fetchPromise;
      return Promise.resolve();
    });
    vi.mocked(save).mockResolvedValue(null);

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={onClose}
      />,
    );

    // Wait for deeplink ready + download button visible
    const downloadBtn = await screen.findByRole("button", {
      name: new RegExp(i18n.t("server.users.download_config"), "i"),
    });

    // Click download — isDownloading becomes true, fetch_server_config pending
    fireEvent.click(downloadBtn);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("fetch_server_config", expect.anything()));

    // X close button is disabled during download
    const closeBtn = screen.getByRole("button", { name: i18n.t("buttons.close") });
    expect(closeBtn).toBeDisabled();

    // Clicking X doesn't trigger onClose
    fireEvent.click(closeBtn);
    expect(onClose).not.toHaveBeenCalled();

    // Release the fetch — download completes
    resolveFetch("/tmp/ok.toml");
  });

  it("Download NOT in-flight: X close button is enabled", async () => {
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "server_export_config_deeplink") {
        return Promise.resolve("tt://?ready");
      }
      return Promise.resolve();
    });

    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );

    await screen.findByTestId("qr-code");
    const closeBtn = screen.getByRole("button", { name: i18n.t("buttons.close") });
    expect(closeBtn).not.toBeDisabled();
  });

  // ══════════════════════════════════════════════════════
  // GAP: preloadedDeeplink bypass (FIX-W) — skip the backend roundtrip
  // ══════════════════════════════════════════════════════

  it("GAP: preloadedDeeplink is shown verbatim WITHOUT any backend fetch (FIX-W)", async () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        preloadedDeeplink="tt://preloaded-from-edit?tlv=1"
        onClose={vi.fn()}
      />,
    );
    const qr = await screen.findByTestId("qr-code");
    expect(qr).toHaveAttribute("data-value", "tt://preloaded-from-edit?tlv=1");
    // The whole point of preloadedDeeplink: no fetch (would strip edited TLVs).
    expect(invoke).not.toHaveBeenCalledWith(
      "server_export_config_deeplink",
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "server_get_user_advanced",
      expect.anything(),
    );
  });

  // ══════════════════════════════════════════════════════
  // GAP: QR caption text under the QR code
  // ══════════════════════════════════════════════════════

  it("GAP: renders the «scan QR» caption under the QR code", async () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://with-caption"
      />,
    );
    await screen.findByTestId("qr-code");
    expect(
      screen.getByText(i18n.t("server.export.scan_qr")),
    ).toBeInTheDocument();
  });

  // ══════════════════════════════════════════════════════
  // GAP: readonly deeplink input mirrors the deeplink value
  // ══════════════════════════════════════════════════════

  it("GAP: deeplink is shown in a read-only input carrying the deeplink value", async () => {
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
        _deeplinkOverride="tt://readonly-input-value"
      />,
    );
    const input = (await screen.findByLabelText(
      i18n.t("server.users.deeplink_aria"),
    )) as HTMLInputElement;
    expect(input).toHaveAttribute("readonly");
    expect(input.value).toBe("tt://readonly-input-value");
  });

  // ══════════════════════════════════════════════════════
  // GAP: advanced-deeplink invoke path (server_get_user_advanced → advanced export)
  // ══════════════════════════════════════════════════════

  it("GAP: when advanced params exist, the advanced export command is used (not the basic one)", async () => {
    // First probe returns a persisted advanced record → fetchDeeplink takes the
    // server_export_config_deeplink_advanced branch with the TLV params baked in.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_user_advanced") {
        // Shape must satisfy isUserAdvancedServerResponse (userAdvanced.ts):
        // username + the typed flags are required.
        return {
          username: "swift-fox",
          display_name: "Alice",
          custom_sni: "cdn.example.com",
          upstream_protocol: "h3",
          anti_dpi: true,
          skip_verification: false,
          pin_cert_der_b64: null,
          dns_upstreams: [],
        };
      }
      if (cmd === "server_export_config_deeplink_advanced") {
        return "tt://advanced-export-result";
      }
      return null;
    });
    render(
      <UserConfigModal
        isOpen={true}
        username="swift-fox"
        sshParams={mockSshParams}
        onClose={vi.fn()}
      />,
    );
    const qr = await screen.findByTestId("qr-code");
    expect(qr).toHaveAttribute("data-value", "tt://advanced-export-result");
    expect(invoke).toHaveBeenCalledWith(
      "server_export_config_deeplink_advanced",
      expect.objectContaining({ clientName: "swift-fox" }),
    );
    // Basic export is NOT used when advanced params are present.
    expect(invoke).not.toHaveBeenCalledWith(
      "server_export_config_deeplink",
      expect.anything(),
    );
  });
});
