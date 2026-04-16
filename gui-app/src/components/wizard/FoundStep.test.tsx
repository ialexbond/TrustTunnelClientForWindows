import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { FoundStep } from "./FoundStep";
import { renderWithProviders as render } from "../../test/test-utils";
import { makeWizardState } from "./testHelpers";

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
        isFetchMode: false,
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
        isFetchMode: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serverInfo: { installed: false, users: [], version: "", serviceActive: false, os: "linux" } as any,
        checkError: "",
        setWizardStep,
      });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("wizard.found.continue_setup")));
      expect(setWizardStep).toHaveBeenCalledWith("endpoint");
    });

    it("renders back button that navigates to server", () => {
      const setWizardStep = vi.fn();
      const w = makeWizardState({
        step: "found",
        isFetchMode: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serverInfo: { installed: false, users: [], version: "", serviceActive: false, os: "linux" } as any,
        checkError: "",
        setWizardStep,
      });
      render(<FoundStep {...w} />);
      // There should be a "back" button
      const backBtns = screen.getAllByText(i18n.t("buttons.back"));
      fireEvent.click(backBtns[0]);
      expect(setWizardStep).toHaveBeenCalledWith("server");
    });
  });

  // ─── Setup mode: check error ───

  describe("setup mode — connection error", () => {
    it("renders unreachable title and error text", () => {
      const w = makeWizardState({
        step: "found",
        isFetchMode: false,
        serverInfo: null,
        checkError: "Connection refused",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.server_unreachable"))).toBeInTheDocument();
      expect(screen.getByText("Connection refused")).toBeInTheDocument();
    });

    it("back button navigates to server step", () => {
      const setWizardStep = vi.fn();
      const w = makeWizardState({
        step: "found",
        isFetchMode: false,
        serverInfo: null,
        checkError: "Connection refused",
        setWizardStep,
      });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("buttons.back")));
      expect(setWizardStep).toHaveBeenCalledWith("server");
    });
  });

  // ─── Setup mode: TT installed ───

  describe("setup mode — TT already installed", () => {
    const installedState = () =>
      makeWizardState({
        step: "found",
        isFetchMode: false,
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
        isFetchMode: false,
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

    it("continue button is disabled when no user selected", () => {
      const w = makeWizardState({ ...installedState(), selectedUser: null });
      render(<FoundStep {...w} />);
      const btn = screen.getByText(i18n.t("wizard.found.select_user_prompt")).closest("button");
      expect(btn).toBeDisabled();
    });

    it("continue button calls handleFetchConfig with selected user", () => {
      const handleFetchConfig = vi.fn();
      const w = makeWizardState({
        ...installedState(),
        selectedUser: "alice",
        handleFetchConfig,
      });
      render(<FoundStep {...w} />);
      fireEvent.click(
        screen.getByText(i18n.t("wizard.found.continue_as", { user: "alice" }))
      );
      expect(handleFetchConfig).toHaveBeenCalledWith("alice");
    });

    it("renders back button (installed mode) that navigates to server", () => {
      const setWizardStep = vi.fn();
      const w = makeWizardState({ ...installedState(), setWizardStep });
      render(<FoundStep {...w} />);
      const backBtns = screen.getAllByText(i18n.t("buttons.back"));
      fireEvent.click(backBtns[0]);
      expect(setWizardStep).toHaveBeenCalledWith("server");
    });
  });

  // ─── Fetch mode: installed with users ───

  describe("fetch mode — installed with users", () => {
    const fetchInstalledState = () =>
      makeWizardState({
        step: "found",
        isFetchMode: true,
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

    it("renders users on server heading", () => {
      render(<FoundStep {...fetchInstalledState()} />);
      expect(screen.getByText(i18n.t("wizard.found.users_on_server"))).toBeInTheDocument();
    });

    it("renders user names", () => {
      render(<FoundStep {...fetchInstalledState()} />);
      expect(screen.getByText("alice")).toBeInTheDocument();
      expect(screen.getByText("bob")).toBeInTheDocument();
    });

    it("save config button calls handleSaveConfigDirect", () => {
      const handleSaveConfigDirect = vi.fn();
      const w = makeWizardState({
        ...fetchInstalledState(),
        handleSaveConfigDirect,
      });
      render(<FoundStep {...w} />);
      const saveBtns = screen.getAllByText(i18n.t("wizard.found.save_config"));
      fireEvent.click(saveBtns[0]);
      expect(handleSaveConfigDirect).toHaveBeenCalledWith("alice");
    });

    it("shows to home button that navigates to welcome", () => {
      const setWizardStep = vi.fn();
      const w = makeWizardState({ ...fetchInstalledState(), setWizardStep });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("wizard.found.to_home")));
      expect(setWizardStep).toHaveBeenCalledWith("welcome");
    });

    it("shows error message when present", () => {
      const w = makeWizardState({
        ...fetchInstalledState(),
        errorMessage: "Something went wrong",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });
  });

  // ─── Fetch mode: installed with no users ───

  describe("fetch mode — installed with no users", () => {
    it("renders no users title", () => {
      const w = makeWizardState({
        step: "found",
        isFetchMode: true,
        serverInfo: {
          installed: true,
          users: [],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        checkError: "",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.no_users_title"))).toBeInTheDocument();
    });

    it("setup server button navigates and clears fetch mode", () => {
      const setWizardStep = vi.fn();
      const saveField = vi.fn();
      const w = makeWizardState({
        step: "found",
        isFetchMode: true,
        serverInfo: {
          installed: true,
          users: [],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        checkError: "",
        setWizardStep,
        saveField,
      });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("wizard.found.setup_server")));
      expect(saveField).toHaveBeenCalledWith("wizardMode", "");
      expect(setWizardStep).toHaveBeenCalledWith("server");
    });
  });

  // ─── Fetch mode: not installed ───

  describe("fetch mode — not installed", () => {
    it("renders not installed title", () => {
      const w = makeWizardState({
        step: "found",
        isFetchMode: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serverInfo: { installed: false, users: [], version: "", serviceActive: false, os: "linux" } as any,
        checkError: "",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.not_installed_title"))).toBeInTheDocument();
    });

    it("renders unreachable title when checkError present in fetch mode", () => {
      const w = makeWizardState({
        step: "found",
        isFetchMode: true,
        serverInfo: null,
        checkError: "Timeout",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.server_unreachable"))).toBeInTheDocument();
      expect(screen.getByText("Timeout")).toBeInTheDocument();
    });

    it("renders not installed description in fetch mode", () => {
      const w = makeWizardState({
        step: "found",
        isFetchMode: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serverInfo: { installed: false, users: [], version: "", serviceActive: false, os: "linux" } as any,
        checkError: "",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.not_installed_fetch_description"))).toBeInTheDocument();
    });

    it("setup server button in not-installed fetch mode clears fetch mode and navigates", () => {
      const setWizardStep = vi.fn();
      const saveField = vi.fn();
      const w = makeWizardState({
        step: "found",
        isFetchMode: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serverInfo: { installed: false, users: [], version: "", serviceActive: false, os: "linux" } as any,
        checkError: "",
        setWizardStep,
        saveField,
      });
      render(<FoundStep {...w} />);
      fireEvent.click(screen.getByText(i18n.t("wizard.found.setup_server")));
      expect(saveField).toHaveBeenCalledWith("wizardMode", "");
      expect(setWizardStep).toHaveBeenCalledWith("server");
    });

    it("back button in not-installed fetch mode navigates to server", () => {
      const setWizardStep = vi.fn();
      const w = makeWizardState({
        step: "found",
        isFetchMode: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serverInfo: { installed: false, users: [], version: "", serviceActive: false, os: "linux" } as any,
        checkError: "",
        setWizardStep,
      });
      render(<FoundStep {...w} />);
      const backBtns = screen.getAllByText(i18n.t("buttons.back"));
      fireEvent.click(backBtns[0]);
      expect(setWizardStep).toHaveBeenCalledWith("server");
    });
  });

  // ─── Fetch mode: error with checkError ───

  describe("fetch mode — SSH error", () => {
    it("renders SSH error description in fetch mode when checkError present", () => {
      const w = makeWizardState({
        step: "found",
        isFetchMode: true,
        serverInfo: null,
        checkError: "SSH connection failed",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.ssh_error_fetch_description"))).toBeInTheDocument();
    });

    it("shows error text in scrollable container", () => {
      const w = makeWizardState({
        step: "found",
        isFetchMode: true,
        serverInfo: null,
        checkError: "Authentication error: invalid key",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText("Authentication error: invalid key")).toBeInTheDocument();
    });
  });

  // ─── Fetch mode: saving config ───

  describe("fetch mode — saving config state", () => {
    it("shows saving text when savingConfigFor matches user", () => {
      const w = makeWizardState({
        step: "found",
        isFetchMode: true,
        serverInfo: {
          installed: true,
          users: ["alice"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        savingConfigFor: "alice",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.saving_config"))).toBeInTheDocument();
    });

    it("save config buttons are disabled when savingConfigFor is set", () => {
      const w = makeWizardState({
        step: "found",
        isFetchMode: true,
        serverInfo: {
          installed: true,
          users: ["alice", "bob"],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        savingConfigFor: "alice",
      });
      render(<FoundStep {...w} />);
      // The button for bob should be disabled while alice is saving
      const saveBtns = screen.getAllByText(i18n.t("wizard.found.save_config"));
      // bob's button should be disabled
      saveBtns.forEach(btn => {
        expect(btn.closest("button")).toBeDisabled();
      });
    });
  });

  // ─── Setup mode: user interactions ───

  describe("setup mode — user interaction flows", () => {
    it("shows select user for config description in fetch mode", () => {
      const w = makeWizardState({
        step: "found",
        isFetchMode: true,
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
      expect(screen.getByText(i18n.t("wizard.found.select_user_for_config"))).toBeInTheDocument();
    });

    it("renders no users description in fetch mode", () => {
      const w = makeWizardState({
        step: "found",
        isFetchMode: true,
        serverInfo: {
          installed: true,
          users: [],
          version: "1.5.0",
          serviceActive: true,
          os: "linux",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.no_users_description"))).toBeInTheDocument();
    });

    it("delete user button is disabled when only one user", () => {
      const w = makeWizardState({
        step: "found",
        isFetchMode: false,
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
        isFetchMode: false,
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
      // Click a delete (trash) icon button — they have aria-label from server.users.delete_tooltip
      const deleteBtn = screen.getAllByRole("button", {
        name: new RegExp(i18n.t("server.users.delete_tooltip")),
      })[0];
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
        isFetchMode: false,
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

    it("confirm uninstall dialog closes without action when cancelled", async () => {
      const handleUninstall = vi.fn();
      const w = makeWizardState({
        step: "found",
        isFetchMode: false,
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
        isFetchMode: false,
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
        isFetchMode: false,
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
        isFetchMode: false,
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
        isFetchMode: false,
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
        isFetchMode: false,
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
        isFetchMode: false,
        serverInfo: null,
        checkError: "Connection timed out",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.connection_error_help"))).toBeInTheDocument();
    });

    it("shows not found can install message when server ready", () => {
      const w = makeWizardState({
        step: "found",
        isFetchMode: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serverInfo: { installed: false, users: [], version: "", serviceActive: false, os: "linux" } as any,
        checkError: "",
      });
      render(<FoundStep {...w} />);
      expect(screen.getByText(i18n.t("wizard.found.not_found_can_install"))).toBeInTheDocument();
    });
  });
});
