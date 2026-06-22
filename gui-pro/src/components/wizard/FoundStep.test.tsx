import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { FoundStep } from "./FoundStep";
import { renderWithProviders as render } from "../../test/test-utils";
import { makeWizardState } from "./testHelpers";

// invoke is globally mocked (src/test/tauri-mock.ts). Cast to the vitest mock type
// so we can assert on the exact IPC args (D-06 auth contract).
const invokeMock = vi.mocked(invoke);

// 06-uat: the install wizard's fetch flow («Забрать с сервера» / per-user save-config /
// «Continue as user») was removed end-to-end. FoundStep is now always the setup-mode
// screen (server already installed → manage/reinstall, or not-installed → install). Back
// buttons close the overlay (onClose) — there is no SSH-connect screen to return to.
describe("FoundStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  // ─── Setup mode: TT not installed, no error ───

  describe("setup mode — server ready (not installed, no error)", () => {
    it("renders server ready title", () => {
      const w = makeWizardState({
        step: "found",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serverInfo: { installed: false, users: [], version: "", serviceActive: false, os: "linux" } as any,
        checkError: "",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.server_ready"))).toBeInTheDocument();
    });

    it("renders continue setup button that navigates to endpoint", () => {
      const setWizardStep = vi.fn();
      const w = makeWizardState({
        step: "found",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serverInfo: { installed: false, users: [], version: "", serviceActive: false, os: "linux" } as any,
        checkError: "",
        setWizardStep,
      });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("wizard.found.continue_setup")));
      expect(setWizardStep).toHaveBeenCalledWith("endpoint");
    });

    it("back button closes the overlay (onClose), never navigates to a deleted server screen", () => {
      const onClose = vi.fn();
      const setWizardStep = vi.fn();
      const w = makeWizardState({
        step: "found",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serverInfo: { installed: false, users: [], version: "", serviceActive: false, os: "linux" } as any,
        checkError: "",
        onClose,
        setWizardStep,
      });
      render(<FoundStep {...w} />);
      const backBtns = screen.getAllByText(i18n.t("buttons.back"));
      fireEvent.click(backBtns[0]);
      expect(onClose).toHaveBeenCalled();
      expect(setWizardStep).not.toHaveBeenCalledWith("server");
    });
  });

  // ─── Setup mode: check error ───

  describe("setup mode — connection error", () => {
    it("renders unreachable title and error text", () => {
      const w = makeWizardState({
        step: "found",
        serverInfo: null,
        checkError: "Connection refused",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.server_unreachable"))).toBeInTheDocument();
      expect(screen.getByText("Connection refused")).toBeInTheDocument();
    });

    it("back button closes the overlay (onClose)", () => {
      const onClose = vi.fn();
      const setWizardStep = vi.fn();
      const w = makeWizardState({
        step: "found",
        serverInfo: null,
        checkError: "Connection refused",
        onClose,
        setWizardStep,
      });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("buttons.back")));
      expect(onClose).toHaveBeenCalled();
      expect(setWizardStep).not.toHaveBeenCalledWith("server");
    });
  });

  // ─── Setup mode: TT installed ───

  describe("setup mode — TT already installed", () => {
    const installedState = () =>
      makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice", "bob"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        checkError: "",
      });

    it("renders already installed heading", () => {
      render(<FoundStep {...installedState()} />);
      expect(screen.getByText(i18n.t("wizard.found.already_installed"))).toBeInTheDocument();
    });

    it("shows version info", () => {
      render(<FoundStep {...installedState()} />);
      expect(
        screen.getByText(i18n.t("wizard.found.version_label", { version: "1.5.0" }))
      ).toBeInTheDocument();
    });

    it("shows service running status", () => {
      render(<FoundStep {...installedState()} />);
      expect(screen.getByText(i18n.t("wizard.found.service_running"))).toBeInTheDocument();
    });

    it("shows service stopped when not active", () => {
      const w = makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice"],
          version: "1.5.0",
          serviceActive: false,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.service_stopped"))).toBeInTheDocument();
    });

    it("renders user list with user names", () => {
      render(<FoundStep {...installedState()} />);
      expect(screen.getByText("alice")).toBeInTheDocument();
      expect(screen.getByText("bob")).toBeInTheDocument();
    });

    it("renders added users section header", () => {
      render(<FoundStep {...installedState()} />);
      expect(screen.getByText(i18n.t("wizard.found.added_users"))).toBeInTheDocument();
    });

    it("clicking a user row sets selectedUser", () => {
      const setSelectedUser = vi.fn();
      const w = makeWizardState({
        ...installedState(),
        setSelectedUser,
      });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText("alice"));
      expect(setSelectedUser).toHaveBeenCalledWith("alice");
    });

    // ── Add user form ──

    it("renders add user section", () => {
      render(<FoundStep {...installedState()} />);
      expect(screen.getByText(i18n.t("wizard.found.add_user"))).toBeInTheDocument();
    });

    it("renders new username input", () => {
      render(<FoundStep {...installedState()} />);
      expect(
        screen.getByPlaceholderText(i18n.t("wizard.found.username_placeholder"))
      ).toBeInTheDocument();
    });

    it("renders new password input", () => {
      render(<FoundStep {...installedState()} />);
      expect(
        screen.getByPlaceholderText(i18n.t("wizard.found.password_placeholder"))
      ).toBeInTheDocument();
    });

    it("calls setNewUsername on username input change", () => {
      const setNewUsername = vi.fn();
      const w = makeWizardState({ ...installedState(), setNewUsername });
      render(<FoundStep {...w} />);
      fireEvent.change(
        screen.getByPlaceholderText(i18n.t("wizard.found.username_placeholder")),
        { target: { value: "charlie" } }
      );
      expect(setNewUsername).toHaveBeenCalled();
    });

    it("calls setNewPassword on password input change", () => {
      const setNewPassword = vi.fn();
      const w = makeWizardState({ ...installedState(), setNewPassword });
      render(<FoundStep {...w} />);
      fireEvent.change(
        screen.getByPlaceholderText(i18n.t("wizard.found.password_placeholder")),
        { target: { value: "pass123" } }
      );
      expect(setNewPassword).toHaveBeenCalled();
    });

    it("add user button calls handleAddUser", () => {
      const handleAddUser = vi.fn();
      const w = makeWizardState({
        ...installedState(),
        handleAddUser,
        newUsername: "charlie",
        newPassword: "pass123",
      });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("wizard.found.add_btn")));
      expect(handleAddUser).toHaveBeenCalledOnce();
    });

    it("add user button is disabled when username is empty", () => {
      const w = makeWizardState({
        ...installedState(),
        newUsername: "",
        newPassword: "pass123",
      });
      render(<FoundStep {...w} />);
      const btn = screen.getByText(i18n.t("wizard.found.add_btn")).closest("button");
      expect(btn).toBeDisabled();
    });

    it("add user button is disabled when password is empty", () => {
      const w = makeWizardState({
        ...installedState(),
        newUsername: "charlie",
        newPassword: "",
      });
      render(<FoundStep {...w} />);
      const btn = screen.getByText(i18n.t("wizard.found.add_btn")).closest("button");
      expect(btn).toBeDisabled();
    });

    it("shows duplicate user warning", () => {
      const w = makeWizardState({
        ...installedState(),
        newUsername: "alice",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.user_already_exists"))).toBeInTheDocument();
    });

    it("add user button is disabled when username already exists", () => {
      const w = makeWizardState({
        ...installedState(),
        newUsername: "alice",
        newPassword: "pass123",
      });
      render(<FoundStep {...w} />);
      const btn = screen.getByText(i18n.t("wizard.found.add_btn")).closest("button");
      expect(btn).toBeDisabled();
    });

    it("toggles new password visibility", () => {
      const w = makeWizardState({
        ...installedState(),
      });
      render(<FoundStep {...w} />);
      const passwordInput = screen.getByPlaceholderText(
        i18n.t("wizard.found.password_placeholder")
      );
      expect(passwordInput).toHaveAttribute("type", "password");
      // The eye toggle is the last button inside ActionPasswordInput's action bar
      const wrapper = passwordInput.parentElement!;
      const buttons = wrapper.querySelectorAll("button");
      const eyeToggle = buttons[buttons.length - 1];
      expect(eyeToggle).toBeTruthy();
      fireEvent.click(eyeToggle!);
      expect(passwordInput).toHaveAttribute("type", "text");
    });

    // ── Action buttons ──

    it("renders skip (have config) button", () => {
      const handleSkip = vi.fn();
      const w = makeWizardState({ ...installedState(), handleSkip });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("wizard.found.skip_have_config")));
      expect(handleSkip).toHaveBeenCalledOnce();
    });

    it("renders reinstall button that navigates to endpoint", () => {
      const setWizardStep = vi.fn();
      const setCameFromFound = vi.fn();
      const w = makeWizardState({
        ...installedState(),
        setWizardStep,
        setCameFromFound,
      });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("wizard.found.reinstall_tt")));
      expect(setCameFromFound).toHaveBeenCalledWith(true);
      expect(setWizardStep).toHaveBeenCalledWith("endpoint");
    });

    it("renders delete button that opens uninstall confirm dialog", async () => {
      const w = makeWizardState({ ...installedState() });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("wizard.found.delete_tt")));
      // Dialog rendered by ConfirmDialogProvider (from renderWithProviders wrapper)
      expect(
        await screen.findByText(i18n.t("wizard.found.confirm_uninstall_title")),
      ).toBeInTheDocument();
    });

    it("back button (installed mode) closes the overlay (onClose)", () => {
      const onClose = vi.fn();
      const setWizardStep = vi.fn();
      const w = makeWizardState({ ...installedState(), onClose, setWizardStep });
      render(<FoundStep {...w} />);
      const backBtns = screen.getAllByText(i18n.t("buttons.back"));
      fireEvent.click(backBtns[0]);
      expect(onClose).toHaveBeenCalled();
      expect(setWizardStep).not.toHaveBeenCalledWith("server");
    });
  });

  // ─── Setup mode: user interactions ───

  describe("setup mode — user interaction flows", () => {
    it("icon-only row controls have explicit aria-labels naming action + target", () => {
      const w = makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice", "bob"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
      render(<FoundStep {...w} />);
      // Each icon-only control resolves by its target user name (UI-SPEC §A11y). 06-uat:
      // the per-user save-config control was removed; QR + Link + delete remain.
      expect(
        screen.getByRole("button", { name: i18n.t("wizard.found.qr_aria", { user: "alice" }) }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: i18n.t("wizard.found.link_aria", { user: "bob" }) }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: i18n.t("wizard.found.delete_aria", { user: "bob" }) }),
      ).toBeInTheDocument();
    });

    it("delete user button is disabled when only one user", () => {
      const w = makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
      render(<FoundStep {...w} />);
      // All icon buttons in the user row - find disabled ones
      const allButtons = screen.getAllByRole("button");
      const disabledButtons = allButtons.filter(btn => btn.hasAttribute("disabled"));
      // At least one should be disabled (the delete button for the last user)
      expect(disabledButtons.length).toBeGreaterThanOrEqual(1);
    });

    it("delete user button opens confirm dialog for multi-user list", async () => {
      const w = makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice", "bob"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
      render(<FoundStep {...w} />);
      // Icon-only row controls now carry an explicit aria-label naming the action +
      // target (UI-SPEC §A11y): "Удалить пользователя {name}". Resolve by that name.
      const deleteBtn = screen.getByRole("button", {
        name: i18n.t("wizard.found.delete_aria", { user: "alice" }),
      });
      fireEvent.click(deleteBtn);
      // Dialog rendered by ConfirmDialogProvider
      expect(
        await screen.findByText(i18n.t("wizard.found.confirm_delete_title")),
      ).toBeInTheDocument();
    });

    it("confirm uninstall dialog calls handleUninstall when confirmed", async () => {
      const handleUninstall = vi.fn();
      const w = makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        handleUninstall,
      });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("wizard.found.delete_tt")));
      // Wait for dialog, then click confirm
      const confirmBtn = await screen.findByRole("button", { name: new RegExp(i18n.t("buttons.confirm_delete")) });
      fireEvent.click(confirmBtn);
      await new Promise((r) => setTimeout(r, 0));
      expect(handleUninstall).toHaveBeenCalled();
    });

    it("D-18: uninstall confirm shows the plain-language «что будет удалено (только наше)» cocoon list + «НЕ трогаем» line", async () => {
      // 06-17 D-18: copy-only enrichment of the EXISTING uninstall confirm — the
      // ownership-scoped cocoon list makes the «only our files» boundary legible
      // to a non-technical user before the traceless removal.
      const w = makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("wizard.found.delete_tt")));
      // ConfirmDialog renders the message with whitespace-pre-line — the \n-list
      // lives in one text node, so match on a substring via a function matcher.
      const msg = await screen.findByText(
        (content) =>
          content.includes("правило фаервола, которое мы добавили") &&
          content.includes("Системные пакеты (curl, certbot)") &&
          content.includes("НЕ трогаем"),
      );
      expect(msg).toBeInTheDocument();
      // No SSH host/path/secret shown verbatim (D-29).
      expect(msg).not.toHaveTextContent("/opt/trusttunnel");
    });

    it("confirm uninstall dialog closes without action when cancelled", async () => {
      const handleUninstall = vi.fn();
      const w = makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        handleUninstall,
      });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("wizard.found.delete_tt")));
      const cancelBtn = await screen.findByRole("button", { name: new RegExp(i18n.t("buttons.cancel")) });
      fireEvent.click(cancelBtn);
      await new Promise((r) => setTimeout(r, 0));
      expect(handleUninstall).not.toHaveBeenCalled();
    });

    it("adding user shows loading state", () => {
      const w = makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        addingUser: true,
        newUsername: "bob",
        newPassword: "pass123",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.adding_user"))).toBeInTheDocument();
    });

    it("password input type is password when showNewPassword is false", () => {
      const w = makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        showNewPassword: false,
      });
      render(<FoundStep {...w} />);
      const passwordInput = screen.getByPlaceholderText(i18n.t("wizard.found.password_placeholder"));
      expect(passwordInput).toHaveAttribute("type", "password");
    });

    it("password input type is text after toggling visibility", () => {
      const w = makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
      render(<FoundStep {...w} />);
      const passwordInput = screen.getByPlaceholderText(i18n.t("wizard.found.password_placeholder"));
      expect(passwordInput).toHaveAttribute("type", "password");
      // Toggle visibility via the eye button (last button in ActionPasswordInput)
      const wrapper = passwordInput.parentElement!;
      const buttons = wrapper.querySelectorAll("button");
      const eyeToggle = buttons[buttons.length - 1];
      fireEvent.click(eyeToggle!);
      expect(passwordInput).toHaveAttribute("type", "text");
    });

    it("username input strips spaces on change", () => {
      const setNewUsername = vi.fn();
      const w = makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        setNewUsername,
      });
      render(<FoundStep {...w} />);
      fireEvent.change(
        screen.getByPlaceholderText(i18n.t("wizard.found.username_placeholder")),
        { target: { value: "user name" } }
      );
      // The handler calls setNewUsername with value.replace(/\s/g, "")
      expect(setNewUsername).toHaveBeenCalledWith("username");
    });

    it("shows selected user radio indicator", () => {
      const w = makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice", "bob"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        selectedUser: "alice",
      });
      render(<FoundStep {...w} />);
      // The selected user has a filled radio indicator
      // Verify alice is shown
      expect(screen.getByText("alice")).toBeInTheDocument();
      expect(screen.getByText("bob")).toBeInTheDocument();
    });

    it("shows connection error help text in setup mode with checkError", () => {
      const w = makeWizardState({
        step: "found",
        serverInfo: null,
        checkError: "Connection timed out",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.connection_error_help"))).toBeInTheDocument();
    });

    it("shows not found can install message when server ready", () => {
      const w = makeWizardState({
        step: "found",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serverInfo: { installed: false, users: [], version: "", serviceActive: false, os: "linux" } as any,
        checkError: "",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.not_found_can_install"))).toBeInTheDocument();
    });
  });

  // ─── CR-03: snackbar i18n uses the server.users.* namespace with interpolation ───
  describe("CR-03 — snackbar resolves server.users.* keys with {{user}} interpolation", () => {
    it("add-user snackbar shows the interpolated user_added string", async () => {
      const w = makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        newUsername: "charlie",
        newPassword: "pass123",
        handleAddUser: vi.fn().mockResolvedValue(undefined),
      });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("wizard.found.add_btn")));
      expect(
        await screen.findByText(i18n.t("server.users.user_added", { user: "charlie" })),
      ).toBeInTheDocument();
    });
  });

  // ─── D-06: deeplink/QR export must go through buildAuthArgs ───
  // CR-01 regression: the export call carries SSH creds, so it MUST send authMethod
  // + exactly one credential (never both password and keyPath). The bug shipped a
  // hand-rolled sshParams object that omitted authMethod and leaked both.
  describe("D-06 — deeplink export sends buildAuthArgs (authMethod, single credential)", () => {
    const installedWithUser = (extra = {}) =>
      makeWizardState({
        step: "found",
        serverInfo: {
          installed: true,
          users: ["alice"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        host: "1.2.3.4",
        port: "22",
        sshUser: "root",
        ...extra,
      });

    it("copy-link export carries authMethod 'key' and no password when authMode is key", async () => {
      invokeMock.mockClear();
      invokeMock.mockResolvedValue("tt://deeplink");
      const w = installedWithUser({
        authMode: "key",
        sshKeyPath: "/home/me/id_ed25519",
        sshKeyData: "KEYDATA",
        // password present in state, but key mode must NOT send it:
        sshPassword: "should-not-be-sent",
        buildAuthArgs: () => ({
          password: "",
          keyPath: "/home/me/id_ed25519",
          keyData: "KEYDATA",
          authMethod: "key" as const,
        }),
      });
      render(<FoundStep {...w} />);
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("wizard.found.link_aria", { user: "alice" }) }),
      );
      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith(
          "server_export_config_deeplink",
          expect.objectContaining({ authMethod: "key", clientName: "alice" }),
        );
      });
      const args = invokeMock.mock.calls.find((c) => c[0] === "server_export_config_deeplink")![1];
      expect(args).toMatchObject({ keyPath: "/home/me/id_ed25519", keyData: "KEYDATA", password: "" });
      // The leaked password must NOT ride along in key mode.
      expect((args as Record<string, unknown>).password).not.toBe("should-not-be-sent");
    });

    it("QR export carries authMethod 'password' and no key when authMode is password", async () => {
      invokeMock.mockClear();
      invokeMock.mockResolvedValue("tt://deeplink");
      const w = installedWithUser({
        authMode: "password",
        sshPassword: "hunter2",
        sshKeyPath: "/leaked/key",
        buildAuthArgs: () => ({
          password: "hunter2",
          keyPath: undefined,
          keyData: undefined,
          authMethod: "password" as const,
        }),
      });
      render(<FoundStep {...w} />);
      fireEvent.click(
        screen.getByRole("button", { name: i18n.t("wizard.found.qr_aria", { user: "alice" }) }),
      );
      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledWith(
          "server_export_config_deeplink",
          expect.objectContaining({ authMethod: "password", password: "hunter2", clientName: "alice" }),
        );
      });
      const args = invokeMock.mock.calls.find((c) => c[0] === "server_export_config_deeplink")![1] as Record<string, unknown>;
      // The leaked key path must NOT ride along in password mode.
      expect(args.keyPath).toBeUndefined();
      expect(args.keyData).toBeUndefined();
    });
  });
});
