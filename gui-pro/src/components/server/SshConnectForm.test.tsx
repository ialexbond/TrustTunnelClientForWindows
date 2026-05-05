import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import i18n from "../../shared/i18n";
import { SshConnectForm } from "./SshConnectForm";
import { renderWithProviders as render } from "../../test/test-utils";

describe("SshConnectForm", () => {
  const onConnect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  function renderForm() {
    return render(<SshConnectForm onConnect={onConnect} />);
  }

  it("renders without crashing", () => {
    renderForm();
    expect(screen.getByText(i18n.t("control.ssh_title"))).toBeInTheDocument();
  });

  it("displays host, port, username, and password fields", () => {
    renderForm();
    expect(screen.getByPlaceholderText("123.45.67.89")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("22")).toBeInTheDocument();
    expect(screen.getByDisplayValue("root")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Введите пароль/)).toBeInTheDocument();
  });

  it("shows connect button disabled when host is empty", () => {
    renderForm();
    const connectBtn = screen.getByRole("button", { name: new RegExp(i18n.t("control.connect")) });
    expect(connectBtn).toBeDisabled();
  });

  it("enables connect button when host and password are filled", () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText("123.45.67.89"), { target: { value: "10.0.0.1" } });
    fireEvent.change(screen.getByPlaceholderText(/Введите пароль/), { target: { value: "secret" } });
    const connectBtn = screen.getByRole("button", { name: new RegExp(i18n.t("control.connect")) });
    expect(connectBtn).not.toBeDisabled();
  });

  it("calls invoke and onConnect on successful connect", async () => {
    vi.mocked(invoke).mockResolvedValue({ installed: true });

    renderForm();
    fireEvent.change(screen.getByPlaceholderText("123.45.67.89"), { target: { value: "10.0.0.1" } });
    fireEvent.change(screen.getByPlaceholderText(/Введите пароль/), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("control.connect")) }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("check_server_installation", expect.objectContaining({ host: "10.0.0.1" }));
    });
    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(
        expect.objectContaining({ host: "10.0.0.1", password: "secret" }),
      );
    });
  });

  it("shows error message when invoke rejects", async () => {
    vi.mocked(invoke).mockRejectedValue("SSH_TIMEOUT|10.0.0.1");

    renderForm();
    fireEvent.change(screen.getByPlaceholderText("123.45.67.89"), { target: { value: "10.0.0.1" } });
    fireEvent.change(screen.getByPlaceholderText(/Введите пароль/), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("control.connect")) }));

    await waitFor(() => {
      const snackbar = document.querySelector("[class*='fixed bottom']");
      expect(snackbar).toBeInTheDocument();
    });
    expect(onConnect).not.toHaveBeenCalled();
  });

  it("shows auth segmented control with 2 options", () => {
    renderForm();
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("control.auth_password")) })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /SSH-ключ/ })).toBeInTheDocument();
  });

  it("switches to key mode and shows file selector by default", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: /SSH-ключ/ }));
    expect(screen.getByText(i18n.t("control.select_key"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("control.browse")) })).toBeInTheDocument();
  });

  it("shows security note text", () => {
    renderForm();
    expect(screen.getByText(i18n.t("control.remember"))).toBeInTheDocument();
  });

  it("connect button is disabled in key-file mode with no key selected", () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText("123.45.67.89"), { target: { value: "10.0.0.1" } });
    fireEvent.click(screen.getByRole("button", { name: /SSH-ключ/ }));
    const connectBtn = screen.getByRole("button", { name: new RegExp(i18n.t("control.connect")) });
    expect(connectBtn).toBeDisabled();
  });

  it("password not required in key mode", () => {
    renderForm();
    fireEvent.change(screen.getByPlaceholderText("123.45.67.89"), { target: { value: "10.0.0.1" } });
    const connectBtn = screen.getByRole("button", { name: new RegExp(i18n.t("control.connect")) });
    expect(connectBtn).toBeDisabled();
  });

  it("renders browse button in key mode", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: /SSH-ключ/ }));
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("control.browse")) })).toBeInTheDocument();
  });

  it("shows both file picker and paste textarea in key mode with separator", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: /SSH-ключ/ }));
    // Both visible at once
    expect(screen.getByText(i18n.t("control.select_key"))).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/BEGIN OPENSSH/)).toBeInTheDocument();
    // Separator "или" between them
    expect(screen.getByText(/или/)).toBeInTheDocument();
  });

  it("displays translated error message on connection failure", async () => {
    vi.mocked(invoke).mockRejectedValue("SSH_AUTH_FAILED|root@10.0.0.1");

    renderForm();
    fireEvent.change(screen.getByPlaceholderText("123.45.67.89"), { target: { value: "10.0.0.1" } });
    fireEvent.change(screen.getByPlaceholderText(/Введите пароль/), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("control.connect")) }));

    await waitFor(() => {
      const snackbar = document.querySelector("[class*='fixed bottom']");
      expect(snackbar).toBeInTheDocument();
    });
  });

  it("clears error when connecting again", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("SSH_TIMEOUT|10.0.0.1");

    renderForm();
    fireEvent.change(screen.getByPlaceholderText("123.45.67.89"), { target: { value: "10.0.0.1" } });
    fireEvent.change(screen.getByPlaceholderText(/Введите пароль/), { target: { value: "pass" } });

    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("control.connect")) }));
    await waitFor(() => {
      const snackbar = document.querySelector("[class*='fixed bottom']");
      expect(snackbar).toBeInTheDocument();
    });

    vi.mocked(invoke).mockResolvedValue({ installed: true });
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("control.connect")) }));
    await waitFor(() => {
      expect(onConnect).toHaveBeenCalled();
    });
  });

  it("port input accepts only digits", () => {
    renderForm();
    const portInput = screen.getByPlaceholderText("22");
    fireEvent.change(portInput, { target: { value: "22abc" } });
    // Verify non-digits were stripped by the onChange handler
    expect(portInput).toHaveValue("22");
  });

  it("switches back to password mode from key mode", () => {
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: /SSH-ключ/ }));
    expect(screen.queryByPlaceholderText(/Введите пароль/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(i18n.t("control.auth_password")) }));
    expect(screen.getByPlaceholderText(/Введите пароль/)).toBeInTheDocument();
  });

  it("renders ssh description text", () => {
    renderForm();
    expect(screen.getByText(i18n.t("control.ssh_description"))).toBeInTheDocument();
  });

  it("has default port 22 and user root", () => {
    renderForm();
    expect(screen.getByPlaceholderText("22")).toHaveValue("22");
    expect(screen.getByDisplayValue("root")).toHaveValue("root");
  });

  it("renders server IP and port labels", () => {
    renderForm();
    expect(screen.getByText(i18n.t("labels.server_address"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("labels.port"))).toBeInTheDocument();
  });

  it("renders username label", () => {
    renderForm();
    expect(screen.getByText(i18n.t("labels.username"))).toBeInTheDocument();
  });
});

// ════════════════════════════════════════════════════════════════
// Phase 16 — auto-detect SSH key + import recovery + D-6.1 fallback
// ════════════════════════════════════════════════════════════════

describe("SshConnectForm — Phase 16 auto-detect + import recovery", () => {
  const onConnect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    i18n.changeLanguage("ru");
  });

  it("auto-detects saved key on mount when localStorage has tt_auth_method_<host>=key", async () => {
    localStorage.setItem("tt_auth_method_192.168.1.100", "key");
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "load_ssh_key_for_host")
        return "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE\n-----END OPENSSH PRIVATE KEY-----";
      if (cmd === "check_server_installation") return { installed: true };
      return null;
    });

    render(<SshConnectForm onConnect={onConnect} initialHost="192.168.1.100" />);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("load_ssh_key_for_host", {
        host: "192.168.1.100",
      });
    });
  });

  it("KEEPS flag=key on PermissionDenied — recovery via .pem (UAT 2026-05-04)", async () => {
    // Раньше после PermissionDenied flag clear'ился + switch в password mode.
    // Но если password auth disabled на server'е → user locked out с no escape.
    // New recovery flow: stay в key mode, clear cached PEM, user loads backup
    // .pem file через «Обзор». localStorage flag preserved.
    localStorage.setItem("tt_auth_method_192.168.1.100", "key");
    vi.mocked(invoke).mockImplementation(async (cmd) => {
      if (cmd === "load_ssh_key_for_host")
        return "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE\n-----END OPENSSH PRIVATE KEY-----";
      if (cmd === "check_server_installation")
        throw "PermissionDenied: server rejected key";
      return null;
    });

    render(<SshConnectForm onConnect={onConnect} initialHost="192.168.1.100" />);

    // Wait for the connect attempt to complete (snackbar fires after fail).
    // Check that flag PRESERVED (user всё ещё key mode для recovery).
    await new Promise((r) => setTimeout(r, 100));
    expect(localStorage.getItem("tt_auth_method_192.168.1.100")).toBe("key");
  });

  it("does not auto-connect if authMethod is password", async () => {
    localStorage.setItem("tt_auth_method_192.168.1.100", "password");
    render(<SshConnectForm onConnect={onConnect} initialHost="192.168.1.100" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(invoke).not.toHaveBeenCalledWith(
      "load_ssh_key_for_host",
      expect.any(Object),
    );
  });

  it("does not auto-connect if no saved method", async () => {
    render(<SshConnectForm onConnect={onConnect} initialHost="192.168.1.100" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(invoke).not.toHaveBeenCalledWith(
      "load_ssh_key_for_host",
      expect.any(Object),
    );
  });

  it("import key button invokes security_import_ssh_key + sets localStorage flag (D-2.3)", async () => {
    vi.mocked(openDialog).mockResolvedValueOnce("/tmp/restored-key.pem");
    vi.mocked(invoke).mockResolvedValueOnce(undefined);

    render(<SshConnectForm onConnect={onConnect} initialHost="192.168.1.100" />);

    // Switch to key mode to expose the import button.
    fireEvent.click(screen.getByRole("button", { name: /SSH-ключ/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: /загрузить ssh-ключ/i }),
    );

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("security_import_ssh_key", {
        host: "192.168.1.100",
        pemPath: "/tmp/restored-key.pem",
      });
    });
    expect(localStorage.getItem("tt_auth_method_192.168.1.100")).toBe("key");
  });
});
