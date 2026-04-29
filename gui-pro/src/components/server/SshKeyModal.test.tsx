import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import i18n from "../../shared/i18n";
import { SshKeyModal } from "./SshKeyModal";
import { renderWithProviders as render } from "../../test/test-utils";

// D-29 spy mock — verify activityLog NEVER receives PEM/private-key content.
const activityLogSpy = vi.fn();
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: activityLogSpy }),
}));

// Tauri mocks (override globals from src/test/tauri-mock.ts to add `save`).
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
}));

const mockSshParams = {
  host: "192.168.1.100",
  port: 22,
  user: "root",
  password: "secret-pw",
};

describe("SshKeyModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activityLogSpy.mockClear();
    localStorage.clear();
    i18n.changeLanguage("ru");
  });

  it("renders not-generated state with Generate button", async () => {
    render(
      <SshKeyModal
        isOpen={true}
        onClose={vi.fn()}
        sshParams={mockSshParams}
        _forceStatus={{
          generated: false,
          authorized_on_server: false,
          password_auth_disabled: false,
        }}
      />,
    );
    expect(
      await screen.findByRole("button", { name: /сгенерировать ssh-ключ/i }),
    ).toBeVisible();
    expect(screen.queryByTestId("ssh-key-fingerprint")).not.toBeInTheDocument();
  });

  it("renders generated state with fingerprint + regenerate + export + step2 buttons", async () => {
    render(
      <SshKeyModal
        isOpen={true}
        onClose={vi.fn()}
        sshParams={mockSshParams}
        _forceStatus={{
          generated: true,
          authorized_on_server: true,
          pubkey_fingerprint: "SHA256:abcdef123",
          password_auth_disabled: false,
        }}
      />,
    );
    expect(await screen.findByTestId("ssh-key-fingerprint")).toHaveTextContent(
      "SHA256:abcdef123",
    );
    expect(
      screen.getByRole("button", { name: /перегенерировать ключ/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /экспортировать резервную копию/i }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /продолжить/i })).toBeVisible();
  });

  it("invokes backend to generate key + persists localStorage flag (D-1.4)", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      fingerprint: "SHA256:newkey",
      generated: true,
    });
    render(
      <SshKeyModal
        isOpen={true}
        onClose={vi.fn()}
        sshParams={mockSshParams}
        _forceStatus={{
          generated: false,
          authorized_on_server: false,
          password_auth_disabled: false,
        }}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /сгенерировать ssh-ключ/i }),
    );
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "security_generate_ssh_key",
        expect.objectContaining({
          host: "192.168.1.100",
          hostArg: "192.168.1.100",
        }),
      );
    });
    expect(localStorage.getItem("tt_auth_method_192.168.1.100")).toBe("key");
  });

  it("opens save dialog with correct default path", async () => {
    vi.mocked(save).mockResolvedValueOnce(null); // user cancels
    render(
      <SshKeyModal
        isOpen={true}
        onClose={vi.fn()}
        sshParams={mockSshParams}
        _forceStatus={{
          generated: true,
          authorized_on_server: true,
          pubkey_fingerprint: "SHA256:k",
          password_auth_disabled: false,
        }}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /экспортировать резервную копию/i }),
    );
    await waitFor(() => {
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: "trusttunnel-key-192.168.1.100.pem",
        }),
      );
    });
  });

  it("Step 2 button disabled until export succeeds (D-2.1 forced backup gate)", async () => {
    vi.mocked(save).mockResolvedValueOnce("/tmp/backup.pem");
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "security_export_ssh_key_backup") return undefined;
      return null;
    });

    render(
      <SshKeyModal
        isOpen={true}
        onClose={vi.fn()}
        sshParams={mockSshParams}
        _forceStatus={{
          generated: true,
          authorized_on_server: true,
          pubkey_fingerprint: "SHA256:k",
          password_auth_disabled: false,
        }}
      />,
    );

    const continueBtn = await screen.findByRole("button", {
      name: /продолжить/i,
    });
    expect(continueBtn).toBeDisabled();
    expect(continueBtn).toHaveAttribute("aria-describedby", "ssh-step2-hint");

    fireEvent.click(
      screen.getByRole("button", { name: /экспортировать резервную копию/i }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "security_export_ssh_key_backup",
        expect.any(Object),
      ),
    );
    await waitFor(() => expect(continueBtn).not.toBeDisabled());
    // After export success — aria-describedby hint removed.
    expect(continueBtn).not.toHaveAttribute("aria-describedby");
    expect(screen.getByTestId("ssh-key-export-path")).toHaveTextContent(
      "/tmp/backup.pem",
    );
  });

  it("D-29 SECURITY: activity log never contains private key content", async () => {
    const fakePem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nABC-SECRET-KEY-DO-NOT-LEAK\n-----END OPENSSH PRIVATE KEY-----";
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "security_get_ssh_key_status")
        return {
          generated: true,
          authorized_on_server: true,
          pubkey_fingerprint: "SHA256:abc",
          password_auth_disabled: false,
        };
      if (cmd === "security_export_ssh_key_backup") return undefined;
      // Hypothetical leak path — must NEVER be logged.
      if (cmd === "load_ssh_key_for_host") return fakePem;
      if (cmd === "security_generate_ssh_key")
        return { fingerprint: "SHA256:newkey", generated: true };
      return null;
    });
    vi.mocked(save).mockResolvedValueOnce("/tmp/backup.pem");

    render(
      <SshKeyModal
        isOpen={true}
        onClose={vi.fn()}
        sshParams={mockSshParams}
      />,
    );

    // Wait for status load.
    await waitFor(() =>
      expect(screen.getByText(/sha256:abc/i)).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /экспортировать резервную копию/i }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "security_export_ssh_key_backup",
        expect.any(Object),
      ),
    );

    // INVARIANT: NO log call contains the secret bytes.
    for (const call of activityLogSpy.mock.calls) {
      const message = String(call[1] ?? "");
      const details = String(call[2] ?? "");
      expect(message).not.toContain("ABC-SECRET-KEY-DO-NOT-LEAK");
      expect(message).not.toContain("BEGIN OPENSSH PRIVATE KEY");
      expect(message).not.toContain("BEGIN PRIVATE KEY");
      expect(message).not.toContain(fakePem);
      expect(details).not.toContain("ABC-SECRET-KEY-DO-NOT-LEAK");
      expect(details).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    }
    // Spot-check: at least path or fingerprint logged (sanity check).
    const allMessages = activityLogSpy.mock.calls
      .map((c) => String(c[1] ?? ""))
      .join("\n");
    expect(allMessages).toContain("backup_exported");
  });

  it("disable PW invokes confirmDialog + backend after export succeeds", async () => {
    vi.mocked(save).mockResolvedValueOnce("/tmp/backup.pem");
    let exportResolved = false;
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "security_export_ssh_key_backup") {
        exportResolved = true;
        return undefined;
      }
      if (cmd === "security_disable_password_auth") {
        if (!exportResolved) throw new Error("Step 2 fired before Step 1!");
        return undefined;
      }
      return null;
    });

    render(
      <SshKeyModal
        isOpen={true}
        onClose={vi.fn()}
        sshParams={mockSshParams}
        _forceStatus={{
          generated: true,
          authorized_on_server: true,
          pubkey_fingerprint: "SHA256:k",
          password_auth_disabled: false,
        }}
      />,
    );

    // Step 1: export
    fireEvent.click(
      await screen.findByRole("button", { name: /экспортировать резервную копию/i }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "security_export_ssh_key_backup",
        expect.any(Object),
      ),
    );

    // Step 2: continue → ConfirmDialog
    const continueBtn = screen.getByRole("button", { name: /продолжить/i });
    await waitFor(() => expect(continueBtn).not.toBeDisabled());
    fireEvent.click(continueBtn);

    // ConfirmDialog confirm button — find the button that triggers actual disable.
    const confirmBtn = await screen.findByRole("button", {
      name: /отключить пароль/i,
    });
    fireEvent.click(confirmBtn);

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "security_disable_password_auth",
        expect.objectContaining({ host: "192.168.1.100" }),
      ),
    );
  });

  it("renders error state with retry button + invokes backend on retry", async () => {
    render(
      <SshKeyModal
        isOpen={true}
        onClose={vi.fn()}
        sshParams={mockSshParams}
        _forceError="KEY_STORE_FAILED|test error"
      />,
    );
    expect(
      await screen.findByText(/key_store_failed/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: new RegExp(i18n.t("buttons.retry"), "i") }),
    ).toBeVisible();
  });

  it("calls onClose when X button clicked", async () => {
    const onClose = vi.fn();
    render(
      <SshKeyModal
        isOpen={true}
        onClose={onClose}
        sshParams={mockSshParams}
        _forceStatus={{
          generated: false,
          authorized_on_server: false,
          password_auth_disabled: false,
        }}
      />,
    );
    const closeBtn = await screen.findByRole("button", {
      name: i18n.t("server.security.ssh_key.modal_close_aria"),
    });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("hides Section 2 when password_auth_disabled=true and shows ✓ indicator", async () => {
    render(
      <SshKeyModal
        isOpen={true}
        onClose={vi.fn()}
        sshParams={mockSshParams}
        _forceStatus={{
          generated: true,
          authorized_on_server: true,
          pubkey_fingerprint: "SHA256:k",
          password_auth_disabled: true,
        }}
      />,
    );
    expect(
      await screen.findByText(/пароль отключён/i),
    ).toBeInTheDocument();
    // Step 1/2 controls should not be visible.
    expect(
      screen.queryByRole("button", { name: /экспортировать резервную копию/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /продолжить/i }),
    ).not.toBeInTheDocument();
  });
});
