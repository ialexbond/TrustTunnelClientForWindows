import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { UsersSection } from "./UsersSection";
import { renderWithProviders as render } from "../../test/test-utils";
import type { ServerState } from "./useServerState";

// Mock qrcode.react — avoids pulling real SVG renderer (used by UserConfigModal).
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

// Spy on activity log — critical for D-29 password leak verification (SECURITY).
const activityLogSpy = vi.fn();
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: activityLogSpy }),
}));

// Mock Tauri.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn().mockResolvedValue(null),
}));

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    serverInfo: {
      installed: true,
      version: "1.4.0",
      serviceActive: true,
      users: ["alice", "bob"],
    },
    selectedUser: null,
    setSelectedUser: vi.fn(),
    newUsername: "",
    setNewUsername: vi.fn(),
    newPassword: "",
    setNewPassword: vi.fn(),
    exportingUser: null,
    setExportingUser: vi.fn(),
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

describe("UsersSection (Phase 14 redesign)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activityLogSpy.mockClear();
    i18n.changeLanguage("ru");

    // Mock clipboard API — used by UserConfigModal when FileText opens the modal.
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
        write: vi.fn().mockResolvedValue(undefined),
      },
    });
    (globalThis as unknown as { ClipboardItem: unknown }).ClipboardItem = class {
      constructor(_data: Record<string, Blob>) {
        void _data;
      }
    };
  });

  // ══════════════════════════════════════════════════════
  // Rendering basics
  // ══════════════════════════════════════════════════════

  it("renders nothing when serverInfo is null", () => {
    const state = makeState({ serverInfo: null });
    const { container } = render(<UsersSection state={state} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders users title (CardHeader with i18n)", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    expect(screen.getByText(i18n.t("server.users.title"))).toBeInTheDocument();
  });

  it("renders user names as role=option in role=listbox (D-02 WAI-ARIA)", () => {
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.4.0",
        serviceActive: true,
        users: ["alice", "bob"],
      },
    });
    render(<UsersSection state={state} />);
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    const options = within(listbox).getAllByRole("option");
    expect(options.length).toBe(2);
    expect(options[0]).toHaveTextContent("alice");
    expect(options[1]).toHaveTextContent("bob");
  });

  it("renders EmptyState when users.length === 0", () => {
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.4.0",
        serviceActive: true,
        users: [],
      },
    });
    render(<UsersSection state={state} />);
    expect(
      screen.getByText(i18n.t("server.users.empty_heading")),
    ).toBeInTheDocument();
    expect(
      screen.getByText(i18n.t("server.users.empty_body")),
    ).toBeInTheDocument();
    // listbox not rendered when empty
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  // ══════════════════════════════════════════════════════
  // D-02: Row click selection
  // ══════════════════════════════════════════════════════

  it("D-02: clicking a row calls setSelectedUser with that user", () => {
    const setSelectedUser = vi.fn();
    const state = makeState({ setSelectedUser });
    render(<UsersSection state={state} />);
    const aliceRow = screen.getByRole("option", { name: /alice/i });
    fireEvent.click(aliceRow);
    expect(setSelectedUser).toHaveBeenCalledWith("alice");
  });

  it("D-02: selected row has aria-selected=true", () => {
    const state = makeState({ selectedUser: "bob" });
    render(<UsersSection state={state} />);
    const bobRow = screen.getByRole("option", { name: /bob/i });
    expect(bobRow).toHaveAttribute("aria-selected", "true");
    const aliceRow = screen.getByRole("option", { name: /alice/i });
    expect(aliceRow).toHaveAttribute("aria-selected", "false");
  });

  // ══════════════════════════════════════════════════════
  // D-03: 2 inline icons (FileText + Trash), NO OverflowMenu
  // ══════════════════════════════════════════════════════

  it("D-03: OverflowMenu is NOT used (removed from UsersSection)", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    // OverflowMenu trigger has aria-label users.actions_menu — should NOT exist
    expect(
      screen.queryByRole("button", { name: i18n.t("users.actions_menu") }),
    ).not.toBeInTheDocument();
  });

  it("D-03: each row has FileText + Trash inline icon buttons", () => {
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.4.0",
        serviceActive: true,
        users: ["alice", "bob"],
      },
    });
    render(<UsersSection state={state} />);
    const showConfigBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.show_config_tooltip"),
    });
    expect(showConfigBtns.length).toBe(2);
    const deleteBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.delete_tooltip"),
    });
    expect(deleteBtns.length).toBe(2);
  });

  it("D-03: clicking FileText icon opens UserConfigModal for that user", async () => {
    vi.mocked(invoke).mockResolvedValue("tt://example.com/config?user=alice");
    const state = makeState();
    render(<UsersSection state={state} />);

    const showConfigBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.show_config_tooltip"),
    });
    fireEvent.click(showConfigBtns[0]); // alice

    // Modal opens — invoke called for deeplink
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "server_export_config_deeplink",
        expect.objectContaining({ clientName: "alice" }),
      );
    });
  });

  it("D-03: FileText click uses stopPropagation — does NOT call setSelectedUser", () => {
    vi.mocked(invoke).mockResolvedValue("tt://example.com/config?user=alice");
    const setSelectedUser = vi.fn();
    const state = makeState({ setSelectedUser });
    render(<UsersSection state={state} />);

    const showConfigBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.show_config_tooltip"),
    });
    fireEvent.click(showConfigBtns[0]);

    // stopPropagation должна предотвратить клик по row
    expect(setSelectedUser).not.toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════
  // D-21: Trash disabled when users.length === 1
  // ══════════════════════════════════════════════════════

  it("D-21: Trash button is disabled when users.length === 1", () => {
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.4.0",
        serviceActive: true,
        users: ["alice"],
      },
    });
    render(<UsersSection state={state} />);
    // Single user case — tooltip меняется на cant_delete_last
    const trashBtn = screen.getByRole("button", {
      name: i18n.t("server.users.cant_delete_last"),
    });
    expect(trashBtn).toBeDisabled();
    expect(trashBtn).toHaveAttribute("aria-disabled", "true");
  });

  it("D-21: Trash button is enabled when users.length > 1", () => {
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.4.0",
        serviceActive: true,
        users: ["alice", "bob"],
      },
    });
    render(<UsersSection state={state} />);
    const trashBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.delete_tooltip"),
    });
    trashBtns.forEach((btn) => {
      expect(btn).not.toBeDisabled();
    });
  });

  it("D-21: Clicking disabled Trash does NOT initiate delete", () => {
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.4.0",
        serviceActive: true,
        users: ["alice"],
      },
    });
    render(<UsersSection state={state} />);
    const trashBtn = screen.getByRole("button", {
      name: i18n.t("server.users.cant_delete_last"),
    });
    fireEvent.click(trashBtn);
    // invoke не должен быть вызван для удаления
    expect(invoke).not.toHaveBeenCalledWith(
      "server_remove_user",
      expect.anything(),
    );
  });

  // ══════════════════════════════════════════════════════
  // D-22 + D-26: Delete flow — ConfirmDialog → invoke → pushSuccess
  // ══════════════════════════════════════════════════════

  it("D-22: Trash click opens ConfirmDialog", async () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    const trashBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.delete_tooltip"),
    });
    fireEvent.click(trashBtns[0]);

    await waitFor(() => {
      expect(
        screen.getByText(i18n.t("server.users.confirm_delete_title")),
      ).toBeInTheDocument();
    });
  });

  it("D-22 + D-26: Confirming delete invokes server_remove_user, removes from state, and calls pushSuccess with user_deleted text", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const pushSuccess = vi.fn();
    const removeUserFromState = vi.fn();
    const state = makeState({ pushSuccess, removeUserFromState });
    render(<UsersSection state={state} />);

    const trashBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.delete_tooltip"),
    });
    fireEvent.click(trashBtns[0]);

    // Confirm button in ConfirmDialog
    const confirmBtn = await screen.findByRole("button", {
      name: i18n.t("buttons.confirm_delete"),
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "server_remove_user",
        expect.objectContaining({ vpnUsername: "alice" }),
      );
    });
    await waitFor(() => {
      expect(removeUserFromState).toHaveBeenCalledWith("alice");
    });
    // D-26: SnackBar должна содержать локализованный текст server.users.user_deleted
    // с интерполированным username: "Пользователь «alice» удалён"
    await waitFor(() => {
      expect(pushSuccess).toHaveBeenCalledWith(
        i18n.t("server.users.user_deleted", { user: "alice" }),
      );
    });
  });

  it("D-22: Cancel ConfirmDialog does NOT invoke server_remove_user", async () => {
    const state = makeState();
    render(<UsersSection state={state} />);

    const trashBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.delete_tooltip"),
    });
    fireEvent.click(trashBtns[0]);

    const cancelBtn = await screen.findByRole("button", {
      name: i18n.t("buttons.cancel"),
    });
    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(
        screen.queryByText(i18n.t("server.users.confirm_delete_title")),
      ).not.toBeInTheDocument();
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "server_remove_user",
      expect.anything(),
    );
  });

  // ══════════════════════════════════════════════════════
  // D-16: No min-length validation
  // ══════════════════════════════════════════════════════

  it("D-16: 1-char username + 1-char password does NOT disable Add button (no min-length validation)", () => {
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.4.0",
        serviceActive: true,
        users: [],
      },
      newUsername: "x",
      newPassword: "y",
    });
    render(<UsersSection state={state} />);
    const addBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("server.users.add_user"), "i"),
    });
    expect(addBtn).not.toBeDisabled();
  });

  it("D-16: empty inputs DO disable Add button", () => {
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.4.0",
        serviceActive: true,
        users: [],
      },
      newUsername: "",
      newPassword: "",
    });
    render(<UsersSection state={state} />);
    const addBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("server.users.add_user"), "i"),
    });
    expect(addBtn).toBeDisabled();
  });

  // ══════════════════════════════════════════════════════
  // D-28: Activity log coverage
  // ══════════════════════════════════════════════════════

  it("D-28: delete flow logs user.remove.initiated + user.remove.confirmed + user.remove.completed", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const state = makeState();
    render(<UsersSection state={state} />);

    const trashBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.delete_tooltip"),
    });
    fireEvent.click(trashBtns[0]);
    // user.remove.initiated logged БЕЗ confirm
    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalledWith(
        "USER",
        expect.stringContaining("user.remove.initiated user=alice"),
      );
    });

    const confirmBtn = await screen.findByRole("button", {
      name: i18n.t("buttons.confirm_delete"),
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalledWith(
        "USER",
        expect.stringContaining("user.remove.confirmed user=alice"),
      );
    });
    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalledWith(
        "STATE",
        expect.stringContaining("user.remove.completed user=alice"),
      );
    });
  });

  it("D-28: show-config click logs user.config.modal_opened source=inline_icon", async () => {
    vi.mocked(invoke).mockResolvedValue("tt://example.com");
    const state = makeState();
    render(<UsersSection state={state} />);
    const showBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.show_config_tooltip"),
    });
    fireEvent.click(showBtns[0]);
    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalledWith(
        "USER",
        expect.stringContaining(
          "user.config.modal_opened user=alice source=inline_icon",
        ),
      );
    });
  });

  // ══════════════════════════════════════════════════════
  // D-29: Password and deeplink NEVER in activity log (SECURITY)
  // ══════════════════════════════════════════════════════

  it("D-29 SECURITY: password value never appears in activity log calls", async () => {
    const SECRET_PASSWORD = "DO-NOT-LEAK-THIS-789";
    vi.mocked(invoke).mockResolvedValue(undefined);
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.4.0",
        serviceActive: true,
        users: [],
      },
      newUsername: "testuser",
      newPassword: SECRET_PASSWORD,
    });
    render(<UsersSection state={state} />);
    const addBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("server.users.add_user"), "i"),
    });
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalled();
    });

    // Проверить ВСЕ activity log calls — ни один не содержит пароль
    const allCalls = activityLogSpy.mock.calls;
    for (const call of allCalls) {
      const [tag, message, details] = call;
      expect(String(message ?? "")).not.toContain(SECRET_PASSWORD);
      if (details !== undefined) {
        expect(String(details)).not.toContain(SECRET_PASSWORD);
      }
      void tag;
    }
  });

  it("D-29 SECURITY: add_server_user invoke receives password as arg but log doesn't leak it", async () => {
    const SECRET_PASSWORD = "ZZZ-SECRET-999";
    vi.mocked(invoke).mockResolvedValue(undefined);
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.4.0",
        serviceActive: true,
        users: [],
      },
      newUsername: "testuser",
      newPassword: SECRET_PASSWORD,
    });
    render(<UsersSection state={state} />);
    const addBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("server.users.add_user"), "i"),
    });
    fireEvent.click(addBtn);

    // invoke получает password — это нормально (SSH call)
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "add_server_user",
        expect.objectContaining({ vpnPassword: SECRET_PASSWORD }),
      );
    });

    // Но activityLog не должен содержать password
    const addClickedLog = activityLogSpy.mock.calls.find((call) =>
      String(call[1] ?? "").includes("user.add.clicked"),
    );
    expect(addClickedLog).toBeDefined();
    expect(String(addClickedLog?.[1] ?? "")).not.toContain(SECRET_PASSWORD);
  });

  // ══════════════════════════════════════════════════════
  // D-09: QR copy (integration through modal) — opening modal triggers deeplink fetch
  // ══════════════════════════════════════════════════════

  it("D-09 (integration): Opening config modal via inline icon triggers deeplink fetch", async () => {
    vi.mocked(invoke).mockResolvedValue("tt://example.com/config?token=xyz");
    const state = makeState();
    render(<UsersSection state={state} />);

    const showBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.show_config_tooltip"),
    });
    fireEvent.click(showBtns[0]);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "server_export_config_deeplink",
        expect.objectContaining({ clientName: "alice" }),
      );
    });
  });

  // ══════════════════════════════════════════════════════
  // D-06: Row contains ONLY username + 2 icons (no avatars, no status)
  // ══════════════════════════════════════════════════════

  it("D-06: Row does not render avatar/status/metadata — only name + 2 icons", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    const aliceRow = screen.getByRole("option", { name: /alice/i });
    // Внутри row должны быть 2 buttons (FileText + Trash) — никаких <img>
    const buttonsInRow = within(aliceRow).getAllByRole("button");
    expect(buttonsInRow.length).toBe(2);
    // Нет <img> (avatars)
    expect(within(aliceRow).queryByRole("img")).not.toBeInTheDocument();
  });
});
