import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { UsersAddForm } from "./UsersAddForm";

// Activity log spy — critical for D-29 invariant checks.
const activityLogSpy = vi.fn();
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: activityLogSpy }),
}));

// Tooltip wrap — render children immediately (don't wait for hover).
vi.mock("../../shared/ui/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

/**
 * UsersAddForm client-side validation (Phase 14 post-install).
 *
 * The form has a SILENT bug history: an onChange regex used to strip any
 * non-ASCII-alphanumeric char. If user typed Cyrillic "тест", only numbers
 * survived — which looked like "input is broken". The regex was removed, and
 * replaced with inline validation error + disabled submit. These tests guard
 * against regression: no stripping AT ALL during typing, but submit is blocked
 * if username/password violate server-compatible char sets.
 */
describe("UsersAddForm — client-side validation", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    activityLogSpy.mockClear();
  });

  function setup(overrides: Partial<React.ComponentProps<typeof UsersAddForm>> = {}) {
    const props: React.ComponentProps<typeof UsersAddForm> = {
      newUsername: "",
      setNewUsername: vi.fn(),
      newPassword: "",
      setNewPassword: vi.fn(),
      isAdding: false,
      usernameError: "",
      onAdd: vi.fn(),
      ...overrides,
    };
    render(<UsersAddForm {...props} />);
    return props;
  }

  it("does NOT strip characters during typing (user can see what they typed)", () => {
    const setNewUsername = vi.fn();
    setup({ newUsername: "тест", setNewUsername });
    // The input displays the raw value. React prop-based controlled input reflects newUsername as-is.
    const input = screen.getByPlaceholderText(
      i18n.t("server.users.username_placeholder"),
    ) as HTMLInputElement;
    expect(input.value).toBe("тест");
  });

  it("displays validation error when username contains Cyrillic", () => {
    setup({ newUsername: "тест" });
    // Validation error translated from key server.users.username_ascii_only
    expect(
      screen.getByText(i18n.t("server.users.username_ascii_only")),
    ).toBeInTheDocument();
  });

  it("displays validation error when username contains spaces", () => {
    setup({ newUsername: "hello world" });
    expect(
      screen.getByText(i18n.t("server.users.username_spaces")),
    ).toBeInTheDocument();
  });

  it("displays validation error when username >32 chars", () => {
    setup({ newUsername: "a".repeat(33) });
    expect(
      screen.getByText(i18n.t("server.users.username_too_long")),
    ).toBeInTheDocument();
  });

  it("accepts valid username (a-zA-Z0-9._-)", () => {
    setup({ newUsername: "valid.user_name-42" });
    // No error messages visible
    expect(
      screen.queryByText(i18n.t("server.users.username_ascii_only")),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(i18n.t("server.users.username_spaces")),
    ).not.toBeInTheDocument();
  });

  it("displays validation error when password contains leading/trailing spaces", () => {
    setup({ newPassword: "   pass   " });
    expect(
      screen.getByText(i18n.t("server.users.password_no_edge_spaces")),
    ).toBeInTheDocument();
  });

  it("displays validation error when password contains non-ASCII", () => {
    setup({ newPassword: "пасс" });
    expect(
      screen.getByText(i18n.t("server.users.password_ascii_only")),
    ).toBeInTheDocument();
  });

  it("Add button disabled when validation error present", () => {
    setup({ newUsername: "тест", newPassword: "Valid123!" });
    const addBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("server.users.add_user"), "i"),
    });
    expect(addBtn).toBeDisabled();
  });

  it("Add button enabled when both fields valid + non-empty", () => {
    setup({ newUsername: "valid-user", newPassword: "ValidPass123!" });
    const addBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("server.users.add_user"), "i"),
    });
    expect(addBtn).not.toBeDisabled();
  });

  it("submit is blocked when validation fails + logs user.add.blocked", () => {
    const onAdd = vi.fn();
    setup({ newUsername: "тест", newPassword: "Valid", onAdd });
    // Get the form directly via the submit button's closest form
    const addBtn = screen.getByRole("button", {
      name: new RegExp(i18n.t("server.users.add_user"), "i"),
    });
    const form = addBtn.closest("form")!;
    fireEvent.submit(form);
    expect(onAdd).not.toHaveBeenCalled();
    // Blocked submission logged with the responsible field
    const blocked = activityLogSpy.mock.calls.find(
      ([level, msg]) => level === "USER" && typeof msg === "string" && msg.includes("user.add.blocked"),
    );
    expect(blocked?.[1]).toMatch(/reason=username/);
  });

  it("logs user.form.validation_error when Cyrillic typed", () => {
    // Mount with empty → re-render with invalid value, effect fires.
    const { rerender } = render(
      <UsersAddForm
        newUsername=""
        setNewUsername={vi.fn()}
        newPassword=""
        setNewPassword={vi.fn()}
        isAdding={false}
        usernameError=""
        onAdd={vi.fn()}
      />,
    );
    activityLogSpy.mockClear();
    rerender(
      <UsersAddForm
        newUsername="тест"
        setNewUsername={vi.fn()}
        newPassword=""
        setNewPassword={vi.fn()}
        isAdding={false}
        usernameError=""
        onAdd={vi.fn()}
      />,
    );
    const logged = activityLogSpy.mock.calls.find(
      ([level, msg]) =>
        level === "USER" &&
        typeof msg === "string" &&
        msg.includes("user.form.validation_error") &&
        msg.includes("field=username"),
    );
    expect(logged).toBeDefined();
    expect(logged?.[1]).toMatch(/type=username_ascii_only/);
  });

  it("D-29 security: typed value NEVER appears in activity log payloads", () => {
    activityLogSpy.mockClear();
    const SECRET_PWD = "SECRET-TOPSECRET-DO-NOT-LEAK";
    render(
      <UsersAddForm
        newUsername="тест"  // triggers validation log
        setNewUsername={vi.fn()}
        newPassword={SECRET_PWD}
        setNewPassword={vi.fn()}
        isAdding={false}
        usernameError=""
        onAdd={vi.fn()}
      />,
    );
    for (const call of activityLogSpy.mock.calls) {
      const payload = JSON.stringify(call);
      expect(payload).not.toContain(SECRET_PWD);
      // Cyrillic username value should NOT be in payload either (just type=)
      expect(payload).not.toContain("тест");
    }
  });
});
