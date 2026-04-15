import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
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
    expect(portInput).toBeInTheDocument();
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
