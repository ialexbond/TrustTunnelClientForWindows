import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { UsersSection } from "./UsersSection";
import type { ServerState } from "./useServerState";

// Mock qrcode.react
vi.mock("qrcode.react", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  QRCodeSVG: (props: any) => <svg data-testid="qr-code" data-value={props.value} />,
}));

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    serverInfo: { installed: true, version: "1.4.0", serviceActive: true, users: ["alice", "bob"] },
    selectedUser: null,
    setSelectedUser: vi.fn(),
    newUsername: "",
    setNewUsername: vi.fn(),
    newPassword: "",
    setNewPassword: vi.fn(),
    exportingUser: null,
    setExportingUser: vi.fn(),
    confirmDeleteUser: null,
    setConfirmDeleteUser: vi.fn(),
    deleteLoading: false,
    setDeleteLoading: vi.fn(),
    continueLoading: false,
    setContinueLoading: vi.fn(),
    actionLoading: null,
    sshParams: { host: "10.0.0.1", port: 22, user: "root", password: "pass" },
    usernameError: "",
    onConfigExported: vi.fn(),
    setActionResult: vi.fn(),
    pushSuccess: vi.fn(),
    addUserToState: vi.fn(),
    removeUserFromState: vi.fn(),
    setActionLoading: vi.fn(),
    ...overrides,
  } as unknown as ServerState;
}

describe("UsersSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("renders nothing when serverInfo is null", () => {
    const state = makeState({ serverInfo: null });
    const { container } = render(<UsersSection state={state} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders users title", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    expect(screen.getByText(i18n.t("server.users.title"))).toBeInTheDocument();
  });

  it("displays user names in the list", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  it("shows 'no users' message when users list is empty", () => {
    const state = makeState({
      serverInfo: { installed: true, version: "1.4.0", serviceActive: true, users: [] },
    });
    render(<UsersSection state={state} />);
    expect(screen.getByText(i18n.t("server.users.no_users"))).toBeInTheDocument();
  });

  it("clicking a user row calls setSelectedUser", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    fireEvent.click(screen.getByText("alice"));
    expect(state.setSelectedUser).toHaveBeenCalledWith("alice");
  });

  it("shows 'select user' button when no user is selected", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.users.select_user")) })).toBeInTheDocument();
  });

  it("shows 'continue as' button when user is selected", () => {
    const state = makeState({ selectedUser: "alice" });
    render(<UsersSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.users.continue_as", { user: "alice" })) })).toBeInTheDocument();
  });

  it("shows add user button", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    expect(screen.getByRole("button", { name: new RegExp(i18n.t("server.users.add_user")) })).toBeInTheDocument();
  });

  it("add user button is disabled when username and password are empty", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    const addBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.users.add_user")) });
    expect(addBtn).toBeDisabled();
  });

  it("shows username and password input placeholders", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    expect(screen.getByPlaceholderText(i18n.t("server.users.username_placeholder"))).toBeInTheDocument();
    expect(screen.getByPlaceholderText(i18n.t("server.users.password_placeholder"))).toBeInTheDocument();
  });

  it("clicking delete icon calls setConfirmDeleteUser", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    // Delete buttons for users — find the delete icon buttons (Trash2)
    // There should be delete buttons for each user. We get all buttons with danger color.
    const deleteButtons = document.querySelectorAll("button[style*='color: var(--color-danger-400)']");
    expect(deleteButtons.length).toBe(2); // one per user
    fireEvent.click(deleteButtons[0]);
    expect(state.setConfirmDeleteUser).toHaveBeenCalledWith("alice");
  });

  it("delete button is disabled when only one user exists", () => {
    const state = makeState({
      serverInfo: { installed: true, version: "1.4.0", serviceActive: true, users: ["alice"] },
    });
    render(<UsersSection state={state} />);
    const deleteButtons = document.querySelectorAll("button[style*='color: var(--color-danger-400)']");
    expect(deleteButtons.length).toBe(1);
    expect(deleteButtons[0]).toBeDisabled();
  });

  it("does not show continue button when users list is empty", () => {
    const state = makeState({
      serverInfo: { installed: true, version: "1.4.0", serviceActive: true, users: [] },
    });
    render(<UsersSection state={state} />);
    expect(screen.queryByRole("button", { name: new RegExp(i18n.t("server.users.select_user")) })).not.toBeInTheDocument();
  });

  it("shows QR icon buttons for each user", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    // Each user has 4 icon buttons: QR, Link, Download, Delete (danger-colored)
    // QR, Link, Download are muted-colored: 3 per user * 2 users = 6
    // But there may also be a close button in the QR modal
    const allIconButtons = document.querySelectorAll("button[style*='color: var(--color-text-muted)']");
    // At least 6 muted buttons (3 per user), possibly more from modal close
    expect(allIconButtons.length).toBeGreaterThanOrEqual(6);
  });

  it("clicking QR icon invokes server_export_config_deeplink", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("trusttunnel://config/abc123");
    const state = makeState();
    render(<UsersSection state={state} />);
    // First non-danger icon button per user is QR
    const mutedButtons = document.querySelectorAll("button[style*='color: var(--color-text-muted)']");
    fireEvent.click(mutedButtons[0]); // First QR button (alice)
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_export_config_deeplink", {
        host: "10.0.0.1", port: 22, user: "root", password: "pass",
        clientName: "alice",
      });
    });
  });

  it("shows QR code modal after successful deeplink generation", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("trusttunnel://config/abc123");
    const state = makeState();
    render(<UsersSection state={state} />);
    const mutedButtons = document.querySelectorAll("button[style*='color: var(--color-text-muted)']");
    fireEvent.click(mutedButtons[0]); // QR button for alice
    await waitFor(() => {
      expect(screen.getByTestId("qr-code")).toBeInTheDocument();
    });
    // Shows username in the modal (alice appears both in list and modal)
    const aliceElements = screen.getAllByText("alice");
    expect(aliceElements.length).toBeGreaterThanOrEqual(2);
  });

  it("sets error and closes QR modal when deeplink generation fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("SSH failed"));
    const state = makeState();
    render(<UsersSection state={state} />);
    const mutedButtons = document.querySelectorAll("button[style*='color: var(--color-text-muted)']");
    fireEvent.click(mutedButtons[0]); // QR button for alice
    await waitFor(() => {
      expect(state.setActionResult).toHaveBeenCalledWith({
        type: "error",
        message: expect.stringContaining("SSH failed"),
      });
    });
  });

  it("clicking link icon copies deeplink to clipboard", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("trusttunnel://config/abc123");
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const state = makeState();
    render(<UsersSection state={state} />);
    const mutedButtons = document.querySelectorAll("button[style*='color: var(--color-text-muted)']");
    fireEvent.click(mutedButtons[1]); // Link button for alice (2nd muted button)
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("trusttunnel://config/abc123");
    });
    expect(state.pushSuccess).toHaveBeenCalled();
  });

  it("clicking download icon triggers config export", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("/tmp/config.toml");
    const state = makeState();
    render(<UsersSection state={state} />);
    const mutedButtons = document.querySelectorAll("button[style*='color: var(--color-text-muted)']");
    fireEvent.click(mutedButtons[2]); // Download button for alice (3rd muted button)
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("fetch_server_config", {
        host: "10.0.0.1", port: 22, user: "root", password: "pass",
        clientName: "alice",
      });
    });
    expect(state.setExportingUser).toHaveBeenCalledWith("alice");
  });

  it("continue as user button calls fetch_server_config and onConfigExported", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("/tmp/config.toml");
    const state = makeState({ selectedUser: "alice" });
    render(<UsersSection state={state} />);
    const continueBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.users.continue_as", { user: "alice" })) });
    fireEvent.click(continueBtn);
    expect(state.setContinueLoading).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(state.onConfigExported).toHaveBeenCalledWith("/tmp/config.toml");
    });
  });

  it("continue as user handles error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("fetch failed"));
    const state = makeState({ selectedUser: "alice" });
    render(<UsersSection state={state} />);
    const continueBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.users.continue_as", { user: "alice" })) });
    fireEvent.click(continueBtn);
    await waitFor(() => {
      expect(state.setActionResult).toHaveBeenCalledWith({
        type: "error",
        message: expect.stringContaining("fetch failed"),
      });
    });
  });

  it("add user button triggers invoke when username and password are filled", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    const state = makeState({ newUsername: "charlie", newPassword: "pass123" });
    render(<UsersSection state={state} />);
    const addBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.users.add_user")) });
    fireEvent.click(addBtn);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("add_server_user", {
        host: "10.0.0.1", port: 22, user: "root", password: "pass",
        vpnUsername: "charlie",
        vpnPassword: "pass123",
      });
    });
    expect(state.addUserToState).toHaveBeenCalledWith("charlie");
  });

  it("shows selected user with visual indicator", () => {
    const state = makeState({ selectedUser: "alice" });
    render(<UsersSection state={state} />);
    // The selected user row has a specific background color
    const aliceRow = screen.getByText("alice").closest("div[class*='cursor-pointer']") as HTMLElement;
    expect(aliceRow).toBeTruthy();
    expect(aliceRow.style.backgroundColor).toBe("rgba(99, 102, 241, 0.08)");
  });

  it("shows separator between users but not after last", () => {
    const state = makeState();
    const { container } = render(<UsersSection state={state} />);
    // There should be 1 separator for 2 users (between alice and bob)
    const separators = container.querySelectorAll("div[style*='border-bottom']");
    expect(separators.length).toBe(1);
  });

  it("shows confirm delete dialog when confirmDeleteUser is set", () => {
    const state = makeState({ confirmDeleteUser: "alice" });
    render(<UsersSection state={state} />);
    expect(screen.getByText(i18n.t("server.users.confirm_delete_title"))).toBeInTheDocument();
  });

  it("add user button disabled when usernameError is set", () => {
    const state = makeState({ newUsername: "alice", newPassword: "pass", usernameError: "server.users.username_exists" });
    render(<UsersSection state={state} />);
    const addBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.users.add_user")) });
    expect(addBtn).toBeDisabled();
  });

  it("QR modal shows loading spinner while generating", async () => {
    // Use a promise that never resolves during the test to keep loading state
    let resolveInvoke: (value: unknown) => void;
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(r => { resolveInvoke = r; }));
    const state = makeState();
    render(<UsersSection state={state} />);
    const mutedButtons = document.querySelectorAll("button[style*='color: var(--color-text-muted)']");
    fireEvent.click(mutedButtons[0]); // QR button for alice
    // The modal should be open with loading spinner
    await waitFor(() => {
      const spinners = document.querySelectorAll("svg.animate-spin");
      expect(spinners.length).toBeGreaterThan(0);
    });
    // Clean up
    resolveInvoke!("trusttunnel://config/abc123");
  });

  it("QR modal has a close button", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("trusttunnel://config/abc123");
    const state = makeState();
    render(<UsersSection state={state} />);
    const mutedButtons = document.querySelectorAll("button[style*='color: var(--color-text-muted)']");
    fireEvent.click(mutedButtons[0]); // QR button for alice
    await waitFor(() => {
      expect(screen.getByTestId("qr-code")).toBeInTheDocument();
    });
    // The close button exists inside the modal content
    const closeBtn = document.querySelector("button.absolute") as HTMLElement;
    expect(closeBtn).toBeTruthy();
  });

  it("user row hover changes background on non-selected user", () => {
    const state = makeState({ selectedUser: "alice" });
    render(<UsersSection state={state} />);
    // Bob is not selected, hover should change background
    const bobRow = screen.getByText("bob").closest("div[class*='cursor-pointer']") as HTMLElement;
    fireEvent.mouseEnter(bobRow);
    expect(bobRow.style.backgroundColor).toBe("var(--color-bg-hover)");
    fireEvent.mouseLeave(bobRow);
    expect(bobRow.style.backgroundColor).toBe("transparent");
  });

  it("user row hover does not change background on selected user", () => {
    const state = makeState({ selectedUser: "alice" });
    render(<UsersSection state={state} />);
    const aliceRow = screen.getByText("alice").closest("div[class*='cursor-pointer']") as HTMLElement;
    fireEvent.mouseEnter(aliceRow);
    // Should stay with selected background
    expect(aliceRow.style.backgroundColor).toBe("rgba(99, 102, 241, 0.08)");
  });

  it("add user handles error from invoke", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("user exists"));
    const state = makeState({ newUsername: "charlie", newPassword: "pass123" });
    render(<UsersSection state={state} />);
    const addBtn = screen.getByRole("button", { name: new RegExp(i18n.t("server.users.add_user")) });
    fireEvent.click(addBtn);
    await waitFor(() => {
      expect(state.setActionResult).toHaveBeenCalledWith({
        type: "error",
        message: expect.stringContaining("user exists"),
      });
    });
  });

  it("copy link handles error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("ssh error"));
    const state = makeState();
    render(<UsersSection state={state} />);
    const mutedButtons = document.querySelectorAll("button[style*='color: var(--color-text-muted)']");
    fireEvent.click(mutedButtons[1]); // Link button for alice
    await waitFor(() => {
      expect(state.setActionResult).toHaveBeenCalledWith({
        type: "error",
        message: expect.stringContaining("ssh error"),
      });
    });
  });

  it("download config handles export error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("download failed"));
    const state = makeState();
    render(<UsersSection state={state} />);
    const mutedButtons = document.querySelectorAll("button[style*='color: var(--color-text-muted)']");
    fireEvent.click(mutedButtons[2]); // Download button for alice
    await waitFor(() => {
      expect(state.setActionResult).toHaveBeenCalledWith({
        type: "error",
        message: expect.stringContaining("download failed"),
      });
    });
  });

  it("shows loading state on add user button when actionLoading starts with add_user", () => {
    const state = makeState({ actionLoading: "add_user", newUsername: "x", newPassword: "y" });
    render(<UsersSection state={state} />);
    // The input fields should be disabled during add
    const inputs = screen.getAllByRole("textbox");
    inputs.forEach(input => expect(input).toBeDisabled());
  });

  it("selected user shows inner dot indicator", () => {
    const state = makeState({ selectedUser: "alice" });
    const { container } = render(<UsersSection state={state} />);
    // The selected user has an inner dot (w-2 h-2 rounded-full)
    const dots = container.querySelectorAll("div.w-2.h-2.rounded-full");
    expect(dots.length).toBe(1);
  });
});
