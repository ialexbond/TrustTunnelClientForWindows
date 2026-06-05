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

  it("does not render a duplicate card title (Phase 14.1 post-review: header removed)", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    // Card title removed — the tab already shows «Пользователи», no duplicate heading
    expect(screen.queryByText(i18n.t("server.users.title"))).not.toBeInTheDocument();
  });

  it("renders user names in a <ul> list (static, no selection)", () => {
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.4.0",
        serviceActive: true,
        users: ["alice", "bob"],
      },
    });
    render(<UsersSection state={state} />);
    // After Continue-as removal (Phase 14 post-install) row selection is gone:
    // rows are static <li> elements, no role=option / role=listbox / aria-selected.
    // Action surface moved entirely to inline FileText / Trash icons per row.
    const list = screen.getByRole("list");
    expect(list).toBeInTheDocument();
    const items = within(list).getAllByRole("listitem");
    expect(items.length).toBe(2);
    expect(items[0]).toHaveTextContent("alice");
    expect(items[1]).toHaveTextContent("bob");
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
    // list not rendered when empty
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  // ══════════════════════════════════════════════════════
  // Row selection REMOVED — Continue-as button удалён, row click бесполезен.
  // (Ранее D-02 тесты проверяли setSelectedUser/aria-selected — удалены.)
  // ══════════════════════════════════════════════════════

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

  // FIX (false green :213): the old test asserted `setSelectedUser` was never
  // called — but that prop is NEVER wired into UsersSection (row selection was
  // removed when Continue-as went away), so the assertion was tautologically
  // green regardless of behavior. Replace with the REAL observable effect of a
  // FileText click: the inline-icon activity-log entry that fires on open.
  it("D-03: FileText click logs user.config.modal_opened source=inline_icon (real inline-icon effect)", async () => {
    vi.mocked(invoke).mockResolvedValue("tt://example.com/config?user=alice");
    const state = makeState();
    render(<UsersSection state={state} />);

    const showConfigBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.show_config_tooltip"),
    });
    fireEvent.click(showConfigBtns[0]); // alice (first row)

    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalledWith(
        "USER",
        "user.config.modal_opened user=alice source=inline_icon",
      );
    });
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
  // D-2 (Phase 14.1 post-review): Single bottom «Add user» button opens UserModal
  // Header plus-icon removed per user feedback — avoids duplicate entry point.
  // D-16 inline-form tests moved to UserModal.test.tsx
  // ══════════════════════════════════════════════════════

  // FIX (false green :371): the old test's only positive proof was the bottom
  // button; its closing assertion negated `users-add-btn` — a testid that has
  // NEVER existed in the component, so it was green by construction and proved
  // nothing about "single entry point". Replace with a real uniqueness check:
  // exactly ONE button carries the add_title accessible name, and it is the
  // bottom button.
  it("D-2 (Phase 14.1 post-review): exactly one «Add user» button exists and it is the bottom button", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    const addBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.add_title"),
    });
    // Single entry point — no duplicate header plus-icon.
    expect(addBtns).toHaveLength(1);
    const addBtnBottom = screen.getByTestId("users-add-btn-bottom");
    expect(addBtns[0]).toBe(addBtnBottom);
    expect(addBtnBottom).not.toBeDisabled();
  });

  it("D-3 (Phase 14.1): Gear icon per row opens UserModal in Edit mode", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    // Gear (Settings) buttons — one per user
    const gearBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.edit_tooltip"),
    });
    expect(gearBtns.length).toBe(2); // alice + bob
    fireEvent.click(gearBtns[0]);
    // activity log: user.modal.open_edit logged
    expect(activityLogSpy).toHaveBeenCalledWith(
      "USER",
      expect.stringContaining("user.modal.open_edit user=alice"),
    );
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

  // ══════════════════════════════════════════════════════
  // D-29 SECURITY: Phase 14.1 — Add is now via UserModal (tested in UserModal.test.tsx).
  // UsersSection D-29 tests verify that delete flow also never leaks credentials.
  // ══════════════════════════════════════════════════════

  it("D-29 SECURITY (Phase 14.1): delete flow activity log never contains password", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const state = makeState();
    render(<UsersSection state={state} />);

    const trashBtns = screen.getAllByRole("button", {
      name: i18n.t("server.users.delete_tooltip"),
    });
    fireEvent.click(trashBtns[0]);

    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalled();
    });

    // No activity log call should contain a password-like value
    const allCalls = activityLogSpy.mock.calls;
    for (const call of allCalls) {
      const [, message] = call;
      // password= should never appear in remove flow logs
      expect(String(message ?? "")).not.toContain("password=");
    }
  });

  it("D-29 SECURITY (Phase 14.1 post-review): bottom add button opens UserModal (Add moved out of UsersSection)", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    const addBtn = screen.getByTestId("users-add-btn-bottom");
    expect(addBtn).toBeInTheDocument();
    fireEvent.click(addBtn);
    // activity log: user.modal.open_add logged (no password involved at this stage)
    expect(activityLogSpy).toHaveBeenCalledWith(
      "USER",
      "user.modal.open_add",
    );
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

  it("D-06 (Phase 14.1): Row does not render avatar/status/metadata — only name + 3 icons", () => {
    const state = makeState();
    render(<UsersSection state={state} />);
    const items = screen.getAllByRole("listitem");
    const aliceRow = items.find((el) => el.textContent?.includes("alice"))!;
    // Phase 14.1 D-3: 3 buttons per row (FileText + Gear + Trash) — никаких <img>/avatars
    const buttonsInRow = within(aliceRow).getAllByRole("button");
    expect(buttonsInRow.length).toBe(3);
    expect(within(aliceRow).queryByRole("img")).not.toBeInTheDocument();
  });

  // ══════════════════════════════════════════════════════
  // Phase 14 post-install: isBusy disables row-level actions
  // ══════════════════════════════════════════════════════

  it("isBusy (actionLoading='add_user'): FileText + Trash icons disabled on all rows", () => {
    const state = makeState({ actionLoading: "add_user" });
    render(<UsersSection state={state} />);
    const items = screen.getAllByRole("listitem");
    // Find all icon buttons — they should all be disabled while adding.
    for (const row of items) {
      const buttons = within(row).getAllByRole("button");
      for (const btn of buttons) {
        expect(btn).toBeDisabled();
      }
    }
  });

  // FIX-JJ (2026-04-18): `deleteLoading` intentionally NO LONGER dims the
  // row icons. The delete flow goes through a ConfirmDialog whose backdrop
  // already captures every click until the async action returns. Adding a
  // second layer of disable made background icons look faded while the
  // dialog was up — user feedback explicitly asked for that to stop.
  // See memory/v3/design-system/known-issues.md.
  it("deleteLoading=true does NOT disable row icons (ConfirmDialog blocks clicks)", () => {
    const state = makeState({ deleteLoading: true });
    render(<UsersSection state={state} />);
    const items = screen.getAllByRole("listitem");
    for (const row of items) {
      const buttons = within(row).getAllByRole("button");
      for (const btn of buttons) {
        expect(btn).not.toBeDisabled();
      }
    }
  });

  it("Not busy: FileText enabled, Trash enabled (except last-user case D-21)", () => {
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.4.0",
        serviceActive: true,
        users: ["alice", "bob"],  // 2 users → Trash NOT disabled by D-21
      },
    });
    render(<UsersSection state={state} />);
    const items = screen.getAllByRole("listitem");
    const aliceRow = items.find((el) => el.textContent?.includes("alice"))!;
    const buttons = within(aliceRow).getAllByRole("button");
    for (const btn of buttons) {
      expect(btn).not.toBeDisabled();
    }
  });

  // ══════════════════════════════════════════════════════
  // GAP: display_name alias rendering (users-advanced.toml → row label)
  // ══════════════════════════════════════════════════════

  it("GAP: row shows display_name alias as the primary label with username muted alongside", async () => {
    // refreshDisplayNames runs on mount and calls server_list_user_advanced.
    // Returning a display_name for alice means the row renders "Alice Cooper"
    // as the label, with the raw username "alice" shown muted beside it.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "server_list_user_advanced") {
        return [
          { username: "alice", display_name: "Alice Cooper" },
          { username: "bob", display_name: "" }, // empty → falls back to username
        ];
      }
      return undefined;
    });
    const state = makeState();
    render(<UsersSection state={state} />);

    const items = screen.getAllByRole("listitem");
    const aliceRow = items.find((el) => el.textContent?.includes("alice"))!;
    await waitFor(() => {
      expect(within(aliceRow).getByText("Alice Cooper")).toBeInTheDocument();
    });
    // Raw username still present (muted alias) so the operator can correlate.
    expect(aliceRow).toHaveTextContent("alice");

    // bob has an empty display_name → only the username renders, no alias span.
    const bobRow = items.find((el) => el.textContent?.includes("bob"))!;
    expect(bobRow).toHaveTextContent("bob");
  });

  // ══════════════════════════════════════════════════════
  // GAP: empty-state and the bottom add-button render together
  // ══════════════════════════════════════════════════════

  it("GAP: empty-state and the bottom add-button are shown together (add path reachable with zero users)", () => {
    const state = makeState({
      serverInfo: {
        installed: true,
        version: "1.4.0",
        serviceActive: true,
        users: [],
      },
    });
    render(<UsersSection state={state} />);
    // EmptyState heading present...
    expect(
      screen.getByText(i18n.t("server.users.empty_heading")),
    ).toBeInTheDocument();
    // ...AND the bottom add button is still there so the user can add the
    // first user (it lives below the Divider, outside the list/empty branch).
    const addBtn = screen.getByTestId("users-add-btn-bottom");
    expect(addBtn).toBeInTheDocument();
    expect(addBtn).not.toBeDisabled();
  });

  // ══════════════════════════════════════════════════════
  // GAP: auto-open UserConfigModal after a successful add (preloadedDeeplink)
  // ══════════════════════════════════════════════════════

  it("GAP: after UserModal reports a successful add, UserConfigModal auto-opens for the new user", async () => {
    // Drive the real handleUserAdded callback by submitting through UserModal
    // (opened via the bottom add button). server_add_user_advanced returns the
    // generated deeplink; UsersSection then auto-opens UserConfigModal with the
    // preloaded deeplink and logs source=add.
    vi.mocked(invoke).mockResolvedValue("tt://preloaded-after-add");
    const state = makeState();
    render(<UsersSection state={state} />);

    fireEvent.click(screen.getByTestId("users-add-btn-bottom"));
    // UserModal Add form pre-fills a username + password; submit straight away.
    const submit = await screen.findByTestId("user-modal-submit");
    fireEvent.click(submit);

    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalledWith(
        "USER",
        expect.stringContaining("user.config.modal_opened"),
      );
    });
    // The auto-open log carries source=add (distinct from inline_icon).
    const autoOpenLogged = activityLogSpy.mock.calls.some((call: unknown[]) => {
      const msg = call[1];
      return (
        typeof msg === "string" &&
        msg.includes("user.config.modal_opened") &&
        msg.includes("source=add")
      );
    });
    expect(autoOpenLogged).toBe(true);
  });

  // ══════════════════════════════════════════════════════
  // GAP: tab-activation refresh (M-04 / M-11)
  // ══════════════════════════════════════════════════════

  it("GAP: re-activating the «users» tab triggers a silent refresh + reconcile (server_reconcile_users_advanced)", async () => {
    vi.mocked(invoke).mockResolvedValue(0);
    const loadServerInfo = vi.fn().mockResolvedValue(undefined);
    const state = makeState({ loadServerInfo } as Partial<ServerState>);
    // First mount with activeServerTab="users" is the bootstrap render — the
    // effect skips it (firstTabActivationRef). Re-activation (off→on) fires it.
    const { rerender } = render(
      <UsersSection state={state} activeServerTab="users" />,
    );
    rerender(<UsersSection state={state} activeServerTab="service" />);
    rerender(<UsersSection state={state} activeServerTab="users" />);

    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalledWith(
        "USER",
        "users.tab.activated refresh=triggered",
      );
    });
    // Silent reload (silent=true) + best-effort reconcile invoke fire.
    expect(loadServerInfo).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "server_reconcile_users_advanced",
        expect.anything(),
      );
    });
  });
});
