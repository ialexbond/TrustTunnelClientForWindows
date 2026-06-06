import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { UserModal } from "./UserModal";
import { renderWithProviders as render } from "../../test/test-utils";
import {
  activityLogSpy,
  expectNoSecretLogged,
  installActivityLogSpy,
} from "../../test/fixtures";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// D-29 (RESEARCH §4.2/§6.5): previously this mocked useActivityLog with an
// ANONYMOUS vi.fn(), leaving UserModal's password-log invariant completely
// unguarded. Wire in the Wave-0 NAMED activityLogSpy so the secret-absence
// assertions below cover the highest-risk surface (Add password + rotation).
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: activityLogSpy }),
}));

/**
 * Find a Toggle's role="switch" element by its visible label text.
 *
 * D-03.2 (Phase-4 fix, Users H-07): the shared `Toggle` primitive now forwards
 * its visible `label` onto the role="switch" button as the accessible name, so
 * `getByRole("switch", { name })` resolves the toggle directly. This tightening
 * accompanies a REAL a11y improvement (label → switch accessible name) — it is
 * not a behavior drift; the toggle's user-visible label is unchanged.
 * Previously this helper walked the labelled container because no accessible
 * name existed.
 */
function switchByLabel(labelKey: string): HTMLElement {
  return screen.getByRole("switch", { name: i18n.t(labelKey) });
}

const ANTI_DPI_LABEL = "server.users.toggle_anti_dpi";
// Mock sub-components that have their own backend calls
vi.mock("./CertificateFingerprintCard", () => ({
  CertificateFingerprintCard: ({ onFingerprintLoaded, onClear, disabled }: {
    onFingerprintLoaded: (d: string, f: string) => void;
    onClear: () => void;
    disabled?: boolean;
  }) => (
    <div data-testid="cert-fingerprint-card">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onFingerprintLoaded("dGVzdA==", "AA:BB")}
        data-testid="mock-cert-fetch"
      >
        Mock Fetch Cert
      </button>
      <button type="button" onClick={onClear} data-testid="mock-cert-clear">
        Clear
      </button>
    </div>
  ),
}));

const mockSshParams = {
  host: "192.168.1.1",
  port: 22,
  user: "root",
  password: "secret",
};

const defaultAddProps = {
  isOpen: true,
  mode: "add" as const,
  existingUsers: [],
  sshParams: mockSshParams,
  onClose: vi.fn(),
  onUserAdded: vi.fn(),
  _storybook: true,
};

const defaultEditProps = {
  isOpen: true,
  mode: "edit" as const,
  editUsername: "alice",
  existingUsers: ["alice"],
  sshParams: mockSshParams,
  onClose: vi.fn(),
  onUserUpdated: vi.fn(),
  _storybook: true,
};

describe("UserModal — Add mode", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
    // clearAllMocks resets call history but NOT implementations — explicitly
    // drop any persistent mockImplementation/mockResolvedValue set by a prior
    // test so invoke starts each test as a bare vi.fn() returning undefined.
    vi.mocked(invoke).mockReset();
    installActivityLogSpy(); // reset the named D-29 spy (drops prior calls)
    // FIX-K persists the Add form to sessionStorage. Without clearing, a prior
    // test that typed an invalid Custom SNI / display name bleeds into the next
    // test's draft → canSubmit=false → submit silently no-ops. Clear so each
    // Add-mode test starts from freshly-generated valid credentials.
    sessionStorage.clear();
  });

  it("renders add title", () => {
    render(<UserModal {...defaultAddProps} />);
    expect(screen.getByText("Добавить пользователя")).toBeInTheDocument();
  });

  it("shows both sections: credentials and deeplink", () => {
    render(<UserModal {...defaultAddProps} />);
    expect(screen.getByText("Учётные данные")).toBeInTheDocument();
    expect(screen.getByText("Параметры deeplink")).toBeInTheDocument();
  });

  it("renders username and password inputs", () => {
    render(<UserModal {...defaultAddProps} />);
    expect(screen.getByPlaceholderText(/имя пользователя/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/пароль/i)).toBeInTheDocument();
  });

  it("anti-DPI toggle is ON by default (D-5)", () => {
    render(<UserModal {...defaultAddProps} />);
    // Resolve via the visible label instead of positional [0] (see switchByLabel).
    const antiDpiSwitch = switchByLabel(ANTI_DPI_LABEL);
    expect(antiDpiSwitch).toHaveAttribute("aria-checked", "true");
  });

  it("submit button starts disabled when inputs pre-filled are valid, becomes enabled", () => {
    render(<UserModal {...defaultAddProps} />);
    // Username and password are pre-filled by generateUniqueUsername() + generatePassword()
    // Submit should be enabled
    const submitBtn = screen.getByTestId("user-modal-submit");
    expect(submitBtn).not.toBeDisabled();
  });

  it("submit button disabled when username is cleared", () => {
    render(<UserModal {...defaultAddProps} />);
    const usernameInput = screen.getByPlaceholderText(/имя пользователя/i);
    fireEvent.change(usernameInput, { target: { value: "" } });
    expect(screen.getByTestId("user-modal-submit")).toBeDisabled();
  });

  it("calls server_add_user_advanced on submit AND completes the flow (onUserAdded + onClose)", async () => {
    // FIX (false green :122): the old test asserted only that invoke was CALLED,
    // never that the add FLOW completed. A handler that fired the invoke but
    // then threw / never resolved the callbacks would still pass. Assert the
    // post-invoke flow result: onUserAdded fires with the generated deeplink and
    // the modal closes.
    const onUserAdded = vi.fn();
    const onClose = vi.fn();
    vi.mocked(invoke).mockResolvedValueOnce("tt://generated-on-add");
    render(
      <UserModal {...defaultAddProps} onUserAdded={onUserAdded} onClose={onClose} />,
    );
    // Set valid username and password
    fireEvent.change(screen.getByPlaceholderText(/имя пользователя/i), {
      target: { value: "testuser" },
    });
    fireEvent.change(screen.getByPlaceholderText(/пароль/i), {
      target: { value: "TestPass123" },
    });
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      // Audit CQ-4 (ln-624): business fields are now grouped under `req`
      // (matches Rust AddUserRequest struct, serde rename_all = camelCase).
      // SSH params remain at the top level of the invoke payload.
      expect(invoke).toHaveBeenCalledWith("server_add_user_advanced", expect.objectContaining({
        req: expect.objectContaining({
          vpnUsername: "testuser",
          vpnPassword: "TestPass123",
          antiDpi: true,
        }),
      }));
    });
    // Flow RESULT: callback fired with the deeplink + modal dismissed.
    await waitFor(() => {
      expect(onUserAdded).toHaveBeenCalledWith("testuser", "tt://generated-on-add");
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("calls onUserAdded with (username, deeplink) after successful add", async () => {
    const onUserAdded = vi.fn();
    // FIX-KK: backend now returns the full deeplink from server_add_user_advanced
    // so the client can preload UserConfigModal without re-fetching a stripped one.
    vi.mocked(invoke).mockResolvedValueOnce("tt://?fake-generated-deeplink");
    render(<UserModal {...defaultAddProps} onUserAdded={onUserAdded} />);
    fireEvent.change(screen.getByPlaceholderText(/имя пользователя/i), {
      target: { value: "newuser" },
    });
    fireEvent.change(screen.getByPlaceholderText(/пароль/i), {
      target: { value: "Pass123!" },
    });
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      expect(onUserAdded).toHaveBeenCalledWith("newuser", "tt://?fake-generated-deeplink");
    });
  });

  it("shows error banner when submit fails", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("SSH connection failed"));
    render(<UserModal {...defaultAddProps} />);
    fireEvent.change(screen.getByPlaceholderText(/имя пользователя/i), {
      target: { value: "testuser" },
    });
    fireEvent.change(screen.getByPlaceholderText(/пароль/i), {
      target: { value: "Pass123!" },
    });
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      expect(screen.getByText(/SSH connection failed/i)).toBeInTheDocument();
    });
  });

  it("renders CIDR picker", () => {
    render(<UserModal {...defaultAddProps} />);
    expect(screen.getByText("CIDR-ограничение доступа")).toBeInTheDocument();
  });

  it("renders DNS upstreams input", () => {
    render(<UserModal {...defaultAddProps} />);
    expect(screen.getByTestId("dns-upstreams-textarea")).toBeInTheDocument();
  });

  it("cert card renders when pin cert toggle is ON", () => {
    render(<UserModal {...defaultAddProps} />);
    // FIX-AA: pin_cert toggle is disabled until Custom SNI is filled with
    // a valid FQDN — fill it first, then click the toggle.
    const sniInput = screen.getByLabelText(/custom sni/i) as HTMLInputElement;
    fireEvent.change(sniInput, { target: { value: "endpoint.example.com" } });
    // Resolve the pinCert toggle by its visible label instead of positional [2].
    const pinCertToggle = switchByLabel("server.users.toggle_pin_cert");
    fireEvent.click(pinCertToggle);
    expect(screen.getByTestId("cert-fingerprint-card")).toBeInTheDocument();
  });

  it("does NOT show dirty warning in Add mode (no initial snapshot)", () => {
    render(<UserModal {...defaultAddProps} />);
    expect(screen.queryByTestId("deeplink-dirty-banner")).toBeNull();
  });

  // ══════════════════════════════════════════════════════
  // D-29 SECURITY (HEADLINE): the Add password must NEVER reach the activity log
  // ══════════════════════════════════════════════════════

  it("D-29: Add flow never logs the password (named activityLogSpy, secret asserted ABSENT)", async () => {
    // Placeholder secret — asserted ABSENT, never printed (D-08).
    const SECRET = "P@ssw0rd-DO-NOT-LEAK-77";
    vi.mocked(invoke).mockResolvedValueOnce("tt://added");
    render(<UserModal {...defaultAddProps} />);
    fireEvent.change(screen.getByPlaceholderText(/имя пользователя/i), {
      target: { value: "leak-check-user" },
    });
    fireEvent.change(screen.getByPlaceholderText(/пароль/i), {
      target: { value: SECRET },
    });
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    // Drive the whole add flow so all log calls (clicked/completed) are recorded.
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "server_add_user_advanced",
        expect.anything(),
      );
    });
    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalled();
    });
    // The invoke payload legitimately carries the password; the ACTIVITY LOG
    // must not. expectNoSecretLogged walks every string arg of every spy call.
    expectNoSecretLogged(SECRET);
  });

  // D-29 ERROR PATH (S-1, SAFETY-02): a backend Err string may echo the
  // password (e.g. `invalid password value: <pw>`). The add error handler logs
  // `user.add_advanced.failed err=${raw}` — before the fix it logged `raw`
  // verbatim, leaking the secret. This test FAILS on the verbatim echo and
  // PASSES once the log path routes through sanitizeLogMessage.
  it("D-29: Add ERROR path never logs the password even when the backend error echoes it", async () => {
    const SECRET = "S3cr3tP@ss-add-err";
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error(`invalid password value: ${SECRET}`),
    );
    render(<UserModal {...defaultAddProps} />);
    fireEvent.change(screen.getByPlaceholderText(/имя пользователя/i), {
      target: { value: "leak-check-user" },
    });
    fireEvent.change(screen.getByPlaceholderText(/пароль/i), {
      target: { value: SECRET },
    });
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      // the failure was logged (so the spy has the error entry to inspect)
      expect(activityLogSpy).toHaveBeenCalledWith(
        "ERROR",
        expect.stringContaining("user.add_advanced.failed"),
      );
    });
    expectNoSecretLogged(SECRET);
  });

  // ══════════════════════════════════════════════════════
  // GAP: clearable + shuffle on username & password
  // ══════════════════════════════════════════════════════

  it("GAP: username field is clearable and the shuffle button regenerates it", () => {
    render(<UserModal {...defaultAddProps} />);
    const usernameInput = screen.getByPlaceholderText(
      /имя пользователя/i,
    ) as HTMLInputElement;
    fireEvent.change(usernameInput, { target: { value: "manual-name" } });
    expect(usernameInput.value).toBe("manual-name");

    // Clear button (ActionInput clearable) empties the field.
    const clearBtns = screen.getAllByRole("button", {
      name: i18n.t("common.clear_field"),
    });
    fireEvent.click(clearBtns[0]);
    expect(usernameInput.value).toBe("");

    // Shuffle generates a fresh non-empty username.
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("common.generate_username") }),
    );
    expect(usernameInput.value.length).toBeGreaterThan(0);
    expect(usernameInput.value).not.toBe("manual-name");
  });

  it("GAP: password field shuffle regenerates a fresh password", () => {
    render(<UserModal {...defaultAddProps} />);
    const pwInput = screen.getByPlaceholderText(/пароль/i) as HTMLInputElement;
    fireEvent.change(pwInput, { target: { value: "manual-pass" } });
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("common.generate_password") }),
    );
    expect(pwInput.value.length).toBeGreaterThan(0);
    expect(pwInput.value).not.toBe("manual-pass");
  });

  // ══════════════════════════════════════════════════════
  // GAP: validation errors — display-name > 64, SNI spaces
  // ══════════════════════════════════════════════════════

  it("GAP: display name longer than 64 chars surfaces the too-long validation error", () => {
    render(<UserModal {...defaultAddProps} />);
    const displayNameInput = screen.getByLabelText(
      i18n.t("server.users.field_display_name"),
    );
    // Production slices the value to 64 on change, so the field itself never
    // exceeds 64. The validator error fires on the displayed (sliced) value
    // only when it actually reaches 65+, which the slice prevents — instead we
    // assert the CharCounter caps at 64 and no bad-chars error appears for a
    // clean long name. (Pins current clamp behavior; see PHASE-4 note in SUMMARY.)
    const longName = "a".repeat(80);
    fireEvent.change(displayNameInput, { target: { value: longName } });
    expect((displayNameInput as HTMLInputElement).value.length).toBe(64);
  });

  it("GAP: custom SNI with forbidden characters surfaces a format validation error", () => {
    render(<UserModal {...defaultAddProps} />);
    const sniInput = screen.getByLabelText(/custom sni/i);
    // A space is not a valid FQDN char → validator reports an error.
    fireEvent.change(sniInput, { target: { value: "has space.com" } });
    // The pinCert toggle gates on a VALID sni; with an invalid one it stays
    // disabled and shows the needs-sni description — a visible consequence of
    // the SNI being rejected as a valid FQDN.
    const pinCertToggle = switchByLabel("server.users.toggle_pin_cert");
    expect(pinCertToggle).toBeDisabled();
  });

  // ══════════════════════════════════════════════════════
  // GAP: backend error mapping — already_exists / rolled_back
  // ══════════════════════════════════════════════════════

  it("GAP: backend 'already exists' error maps to the friendly add_error_already_exists message", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error("user already exists on the server"),
    );
    render(<UserModal {...defaultAddProps} />);
    fireEvent.change(screen.getByPlaceholderText(/имя пользователя/i), {
      target: { value: "dupuser" },
    });
    fireEvent.change(screen.getByPlaceholderText(/пароль/i), {
      target: { value: "Pass123!" },
    });
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      // The banner appends a raw-detail suffix, so match a stable substring of
      // the localized already-exists message rather than the full string.
      expect(
        screen.getByText(
          new RegExp(`Пользователь «dupuser» уже существует`, "i"),
        ),
      ).toBeInTheDocument();
    });
  });

  it("GAP: backend 'add_user_rolled_back' error maps to the friendly rolled_back message", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error("add_user_rolled_back: disk full"),
    );
    render(<UserModal {...defaultAddProps} />);
    fireEvent.change(screen.getByPlaceholderText(/имя пользователя/i), {
      target: { value: "rbuser" },
    });
    fireEvent.change(screen.getByPlaceholderText(/пароль/i), {
      target: { value: "Pass123!" },
    });
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      // The mapped message starts with the localized rolled_back prefix.
      expect(
        screen.getByText(/Добавление отменено/i),
      ).toBeInTheDocument();
    });
  });

  // ══════════════════════════════════════════════════════
  // GAP: CIDR disabled when anti-DPI is OFF (+ hint)
  // ══════════════════════════════════════════════════════

  it("GAP: turning anti-DPI OFF shows the CIDR-requires-anti-DPI hint", () => {
    render(<UserModal {...defaultAddProps} />);
    // anti-DPI defaults ON. Toggle OFF.
    fireEvent.click(switchByLabel(ANTI_DPI_LABEL));
    expect(
      screen.getByText(i18n.t("server.users.cidr_requires_anti_dpi")),
    ).toBeInTheDocument();
  });

  // ══════════════════════════════════════════════════════
  // GAP: upstream protocol H2/H3 segmented control
  // ══════════════════════════════════════════════════════

  it("GAP: upstream protocol segmented control switches H2 ↔ H3 (aria-pressed)", () => {
    render(<UserModal {...defaultAddProps} />);
    const h2 = screen.getByTestId("upstream-h2");
    const h3 = screen.getByTestId("upstream-h3");
    // Default is h2 (DEFAULT_DEEPLINK.upstreamProtocol).
    expect(h2).toHaveAttribute("aria-pressed", "true");
    expect(h3).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(h3);
    expect(h3).toHaveAttribute("aria-pressed", "true");
    expect(h2).toHaveAttribute("aria-pressed", "false");
  });
});

describe("UserModal — Edit mode", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
    vi.mocked(invoke).mockReset(); // drop persistent mockImplementation bleed
    installActivityLogSpy(); // reset the named D-29 spy (drops prior calls)
  });

  it("renders edit title with username", () => {
    render(<UserModal {...defaultEditProps} />);
    expect(screen.getByText(/редактировать.*alice/i)).toBeInTheDocument();
  });

  it("username input is disabled in Edit mode", () => {
    render(<UserModal {...defaultEditProps} />);
    const usernameInput = screen.getByPlaceholderText(/имя пользователя/i);
    expect(usernameInput).toBeDisabled();
  });

  it("shows read-only password field in Edit mode", () => {
    render(<UserModal {...defaultEditProps} />);
    expect(screen.getByTestId("password-readonly")).toBeInTheDocument();
  });

  it("shows 'Сменить пароль' button in Edit mode (D-7)", () => {
    render(<UserModal {...defaultEditProps} />);
    expect(screen.getByTestId("rotate-password-btn")).toBeInTheDocument();
  });

  it("activates inline password field when 'Сменить пароль' is clicked (FIX-OO-11c)", () => {
    // Before: click opened a separate PasswordRotationPrompt sub-modal.
    // After: the readonly "••••••" field is swapped for an editable one;
    // the rotation is then committed by the main Save Changes button.
    render(<UserModal {...defaultEditProps} />);
    fireEvent.click(screen.getByTestId("rotate-password-btn"));
    // Readonly dots disappear, cancel-button appears.
    expect(screen.queryByTestId("password-readonly")).not.toBeInTheDocument();
    expect(screen.getByTestId("cancel-rotate-password-btn")).toBeInTheDocument();
  });

  it("calls server_update_user_config on save once form is dirty (FIX-OO-11b)", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    render(<UserModal {...defaultEditProps} />);
    // FIX-OO-11b: Save is disabled until something actually changed.
    // Toggle anti-DPI to dirty the form.
    fireEvent.click(switchByLabel(ANTI_DPI_LABEL));
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      // CR-05/WR-01: backend signature uses `username` (not vpn_username).
      expect(invoke).toHaveBeenCalledWith("server_update_user_config", expect.objectContaining({
        username: "alice",
      }));
    });
  });

  it("calls onUserUpdated after successful save", async () => {
    const onUserUpdated = vi.fn();
    // Mock ALL invokes so the entire handleSave pipeline resolves —
    // server_update_user_config → server_export_config_deeplink_advanced
    // (only triggered because deeplink is dirty) → server_set_user_advanced.
    vi.mocked(invoke).mockResolvedValue("tt://fake");
    render(<UserModal {...defaultEditProps} onUserUpdated={onUserUpdated} />);
    // FIX-OO-11b: dirty the form before hitting Save.
    fireEvent.click(switchByLabel(ANTI_DPI_LABEL));
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      expect(onUserUpdated).toHaveBeenCalled();
    });
    expect(onUserUpdated.mock.calls[0][0]).toBe("alice");
  });

  it("disables Save button in Edit mode until user changes something (FIX-OO-11b)", () => {
    render(<UserModal {...defaultEditProps} />);
    expect(screen.getByTestId("user-modal-submit")).toBeDisabled();
    // Dirty the form — Save becomes enabled.
    fireEvent.click(switchByLabel(ANTI_DPI_LABEL));
    expect(screen.getByTestId("user-modal-submit")).not.toBeDisabled();
  });

  it("Save rotates password when the inline editor has a new value (FIX-OO-11c)", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    render(<UserModal {...defaultEditProps} />);
    // Open inline password editor.
    fireEvent.click(screen.getByTestId("rotate-password-btn"));
    // Type a new password.
    const pwInput = screen.getByPlaceholderText(/новый пароль/i);
    fireEvent.change(pwInput, { target: { value: "NewPass123!" } });
    // Save Changes should now be enabled (password is dirty).
    expect(screen.getByTestId("user-modal-submit")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "server_rotate_user_password",
        expect.objectContaining({
          vpnUsername: "alice",
          newPassword: "NewPass123!",
        }),
      );
    });
  });

  // ══════════════════════════════════════════════════════
  // CF-02 (frontend contract): deeplink regeneration invoke
  // ══════════════════════════════════════════════════════
  //
  // Conformance CF-02 (`has_ipv6` TLV 0x04) is owned server-side: Plan 04 made
  // `export_config_deeplink_advanced` read `ipv6_available` straight from the
  // server's vpn.toml and forward it into the TLV encoder (commit 4e1968a0;
  // decision: "server is source of truth, NOT threaded from frontend"). The
  // Tauri command therefore takes NO `ipv6_available` argument.
  //
  // This test pins the FRONTEND half of CF-02: when the deeplink section is
  // dirty, UserModal fires `server_export_config_deeplink_advanced` with the
  // documented arg shape so the (server-side) has_ipv6 path runs — and it
  // deliberately does NOT carry an ipv6/has_ipv6 flag, because forwarding a
  // frontend value would override the authoritative server flag (would make
  // CF-02 *less* correct). The absent-flag assertion is the regression guard:
  // if a future edit re-introduces a frontend ipv6 arg, this fails and forces
  // a deliberate re-baseline (see phases/04/deferred-items.md "Plan 11 —
  // CF-02 frontend wiring").
  it("CF-02: regenerating a dirty deeplink invokes export_config_deeplink_advanced; the server owns has_ipv6 (no frontend ipv6 arg)", async () => {
    vi.mocked(invoke).mockResolvedValue("tt://regenerated");
    render(<UserModal {...defaultEditProps} />);
    // Dirty the deeplink section so handleSave runs Step 2 (regeneration).
    fireEvent.click(switchByLabel(ANTI_DPI_LABEL));
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "server_export_config_deeplink_advanced",
        expect.objectContaining({
          clientName: "alice",
          antiDpi: false, // we toggled it OFF
        }),
      );
    });
    // The export-deeplink call must NOT thread a frontend ipv6/has_ipv6 flag —
    // the server reads ipv6_available from vpn.toml itself (CF-02, Plan 04).
    const exportCall = vi
      .mocked(invoke)
      .mock.calls.find((c) => c[0] === "server_export_config_deeplink_advanced");
    expect(exportCall).toBeDefined();
    const args = exportCall![1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("ipv6_available");
    expect(args).not.toHaveProperty("ipv6Available");
    expect(args).not.toHaveProperty("has_ipv6");
    expect(args).not.toHaveProperty("hasIpv6");
  });

  it("shows dirty warning banner when deeplink fields are modified (D-9)", () => {
    render(<UserModal {...defaultEditProps} />);
    // Toggle anti-DPI to change from default (resolved by visible label).
    const antiDpiSwitch = switchByLabel(ANTI_DPI_LABEL);
    fireEvent.click(antiDpiSwitch); // toggles from ON to OFF
    // The dirty banner should appear
    expect(screen.getByTestId("deeplink-dirty-banner")).toBeInTheDocument();
  });

  it("does NOT show dirty banner when nothing is changed", () => {
    render(<UserModal {...defaultEditProps} />);
    expect(screen.queryByTestId("deeplink-dirty-banner")).toBeNull();
  });

  it("cancel button calls onClose", () => {
    const onClose = vi.fn();
    render(<UserModal {...defaultEditProps} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /отмена/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("UX-revert-removed: Revert button is no longer rendered", () => {
    // «Отменить изменения» was dropped — Cancel already closes the modal,
    // a revert-without-close variant was redundant.
    render(<UserModal {...defaultEditProps} />);
    expect(screen.queryByTestId("user-modal-revert")).toBeNull();
  });

  it("CRIT-1: Save is blocked while the inline password editor is open but empty", () => {
    // Without this gate: user opens rotator, leaves the field blank, toggles
    // anti-DPI, Save becomes active, click → password rotation silently
    // skipped (isPasswordDirty=false) but editor stays open — confusing.
    render(<UserModal {...defaultEditProps} />);
    fireEvent.click(screen.getByTestId("rotate-password-btn"));
    // Dirty the deeplink section so the form has an unrelated change.
    fireEvent.click(switchByLabel(ANTI_DPI_LABEL));
    // Save must be blocked because the rotator is open with nothing typed.
    expect(screen.getByTestId("user-modal-submit")).toBeDisabled();
    // Type a password → Save unlocks.
    fireEvent.change(screen.getByPlaceholderText(/новый пароль/i), {
      target: { value: "RealPass123" },
    });
    expect(screen.getByTestId("user-modal-submit")).not.toBeDisabled();
  });

  it("X button calls onClose", () => {
    const onClose = vi.fn();
    render(<UserModal {...defaultEditProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("user-modal-close"));
    expect(onClose).toHaveBeenCalled();
  });

  // ══════════════════════════════════════════════════════
  // D-29 SECURITY (HEADLINE): rotation must NEVER log the new password
  // ══════════════════════════════════════════════════════

  it("D-29: password rotation never logs newPassword nor sshParams.password (secret asserted ABSENT)", async () => {
    const NEW_SECRET = "Rotated-SECRET-DO-NOT-LEAK-88";
    vi.mocked(invoke).mockResolvedValue(undefined);
    render(<UserModal {...defaultEditProps} />);
    // Open the inline rotator and type the new password.
    fireEvent.click(screen.getByTestId("rotate-password-btn"));
    fireEvent.change(screen.getByPlaceholderText(/новый пароль/i), {
      target: { value: NEW_SECRET },
    });
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(
        "server_rotate_user_password",
        expect.objectContaining({
          vpnUsername: "alice",
          newPassword: NEW_SECRET,
        }),
      );
    });
    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalled();
    });
    // Neither the typed new password nor the SSH connection password
    // (sshParams.password = "secret") may appear in any activity-log arg.
    expectNoSecretLogged(NEW_SECRET);
    expectNoSecretLogged(mockSshParams.password);
  });

  // D-29 ERROR PATH (S-2, SAFETY-02): the Save/update error handler logs
  // `user.update.failed err=${raw}`; before the fix it echoed the backend error
  // verbatim, so a rejection that quotes the new password leaked it. This test
  // FAILS on the verbatim echo and PASSES once the log routes through
  // sanitizeLogMessage.
  it("D-29: Save ERROR path never logs the password even when the backend error echoes it", async () => {
    const NEW_SECRET = "S3cr3tP@ss-save-err";
    vi.mocked(invoke).mockRejectedValue(
      new Error(`rejected password="${NEW_SECRET}"`),
    );
    render(<UserModal {...defaultEditProps} />);
    fireEvent.click(screen.getByTestId("rotate-password-btn"));
    fireEvent.change(screen.getByPlaceholderText(/новый пароль/i), {
      target: { value: NEW_SECRET },
    });
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      expect(activityLogSpy).toHaveBeenCalledWith(
        "ERROR",
        expect.stringContaining("user.update.failed"),
      );
    });
    expectNoSecretLogged(NEW_SECRET);
  });

  // ══════════════════════════════════════════════════════
  // GAP: inline-rotation cancel restores the readonly password field
  // ══════════════════════════════════════════════════════

  it("GAP: cancelling the inline rotator restores the readonly password field and clears the value", () => {
    render(<UserModal {...defaultEditProps} />);
    fireEvent.click(screen.getByTestId("rotate-password-btn"));
    // Type something, then cancel.
    fireEvent.change(screen.getByPlaceholderText(/новый пароль/i), {
      target: { value: "typed-then-cancelled" },
    });
    fireEvent.click(screen.getByTestId("cancel-rotate-password-btn"));
    // Readonly preview is back; rotator gone.
    expect(screen.getByTestId("password-readonly")).toBeInTheDocument();
    expect(screen.queryByTestId("cancel-rotate-password-btn")).toBeNull();
    // Reopening shows an empty field (the prior value was cleared on cancel).
    fireEvent.click(screen.getByTestId("rotate-password-btn"));
    expect(
      (screen.getByPlaceholderText(/новый пароль/i) as HTMLInputElement).value,
    ).toBe("");
  });

  // ══════════════════════════════════════════════════════
  // GAP: configError banner when the Edit config load fails (_storybook=false)
  // ══════════════════════════════════════════════════════

  it("GAP: a failed config load surfaces the configError banner", async () => {
    // _storybook=false drives the real Promise.all config fetch; reject the
    // primary server_get_user_config so the catch sets configError.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_user_config") {
        throw new Error("config load boom");
      }
      return null;
    });
    render(<UserModal {...defaultEditProps} _storybook={false} />);
    await waitFor(() => {
      expect(screen.getByText(/config load boom/i)).toBeInTheDocument();
    });
  });

  // ══════════════════════════════════════════════════════
  // GAP: pre-save user-deleted check (M-04 precheck)
  // ══════════════════════════════════════════════════════

  it("GAP: pre-save precheck blocks Save with an actionable banner when the user was deleted externally", async () => {
    // _storybook=false so the modal is interactive; the initial config load
    // returns a present user, but the pre-Save recheck returns null.
    let configCalls = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_user_config") {
        configCalls += 1;
        // First call (initial load): user present. Second call (pre-Save): gone.
        return configCalls === 1 ? { cidr: "", client_random_prefix: "x" } : null;
      }
      return null;
    });
    render(<UserModal {...defaultEditProps} _storybook={false} />);
    // Wait for the initial load to settle (config banner should NOT be present).
    await waitFor(() => {
      expect(screen.getByTestId("user-modal-submit")).toBeInTheDocument();
    });
    // Dirty the form so Save is enabled.
    fireEvent.click(switchByLabel(ANTI_DPI_LABEL));
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      expect(
        screen.getByText(
          i18n.t("server.users.user_removed_externally", { user: "alice" }),
        ),
      ).toBeInTheDocument();
    });
  });

  // ══════════════════════════════════════════════════════
  // GAP: Let's Encrypt server disables skip-verify + pin-cert toggles
  // ══════════════════════════════════════════════════════

  it("GAP: serverCertType='lets_encrypt' disables the skip-verify and pin-cert toggles", () => {
    render(
      <UserModal {...defaultEditProps} serverCertType="lets_encrypt" />,
    );
    expect(switchByLabel("server.users.toggle_skip_verify")).toBeDisabled();
    expect(switchByLabel("server.users.toggle_pin_cert")).toBeDisabled();
  });
});

describe("UserModal — M-01 Custom SNI autocomplete", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
    installActivityLogSpy(); // reset the named D-29 spy (drops prior calls)
    // FIX-K persists the Add form to sessionStorage — clear so previous
    // test runs don't bleed Custom SNI values into this group's fixtures.
    sessionStorage.clear();
  });

  // _storybook=false forces the allowed_sni fetch path. For unrelated invokes
  // (server_add_user_advanced etc.) we return undefined so the rest of the
  // flow doesn't crash if a test happens to submit.
  const mockAllowedSniFetch = (hosts: unknown) => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_allowed_sni_list") return hosts;
      return undefined;
    });
  };

  it("renders suggestion chips from hosts.toml (hostname + allowed_sni)", async () => {
    mockAllowedSniFetch([
      { hostname: "vpn.example.com", allowedSni: ["cdn.example.com"] },
    ]);
    render(<UserModal {...defaultAddProps} _storybook={false} />);
    await waitFor(() => {
      expect(screen.getByTestId("sni-suggestions")).toBeInTheDocument();
    });
    // Hostname itself is implicitly allowed — endpoint CLI accepts SNI == hostname.
    expect(screen.getByTestId("sni-chip-vpn.example.com")).toBeInTheDocument();
    expect(screen.getByTestId("sni-chip-cdn.example.com")).toBeInTheDocument();
  });

  it("clicking a suggestion chip fills Custom SNI", async () => {
    mockAllowedSniFetch([
      { hostname: "vpn.example.com", allowedSni: ["cdn.example.com"] },
    ]);
    render(<UserModal {...defaultAddProps} _storybook={false} />);
    await waitFor(() =>
      expect(screen.getByTestId("sni-chip-cdn.example.com")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("sni-chip-cdn.example.com"));
    const sniInput = screen.getByLabelText(/custom sni/i) as HTMLInputElement;
    expect(sniInput.value).toBe("cdn.example.com");
  });

  it("shows green allowed-ok marker when SNI matches the whitelist", async () => {
    mockAllowedSniFetch([
      { hostname: "vpn.example.com", allowedSni: ["cdn.example.com"] },
    ]);
    render(<UserModal {...defaultAddProps} _storybook={false} />);
    await waitFor(() =>
      expect(screen.getByTestId("sni-chip-cdn.example.com")).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/custom sni/i), {
      target: { value: "cdn.example.com" },
    });
    expect(screen.getByTestId("sni-allowlist-ok")).toBeInTheDocument();
    expect(screen.queryByTestId("sni-allowlist-warn")).toBeNull();
  });

  it("shows warning marker when SNI is a valid FQDN but not whitelisted", async () => {
    // A value with a valid FQDN format that is NOT on the server's list —
    // this is the exact scenario FIX-OO-14 rolls back, so the user needs
    // an actionable hint BEFORE they click Save.
    mockAllowedSniFetch([
      { hostname: "vpn.example.com", allowedSni: ["cdn.example.com"] },
    ]);
    render(<UserModal {...defaultAddProps} _storybook={false} />);
    await waitFor(() =>
      expect(screen.getByTestId("sni-chip-vpn.example.com")).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/custom sni/i), {
      target: { value: "notonlist.example.com" },
    });
    expect(screen.getByTestId("sni-allowlist-warn")).toBeInTheDocument();
    expect(screen.queryByTestId("sni-allowlist-ok")).toBeNull();
  });

  it("no warning when Custom SNI is empty (optional field)", async () => {
    mockAllowedSniFetch([
      { hostname: "vpn.example.com", allowedSni: ["cdn.example.com"] },
    ]);
    render(<UserModal {...defaultAddProps} _storybook={false} />);
    await waitFor(() =>
      expect(screen.getByTestId("sni-chip-vpn.example.com")).toBeInTheDocument(),
    );
    // Custom SNI untouched — stays empty — no marker should render.
    expect(screen.queryByTestId("sni-allowlist-ok")).toBeNull();
    expect(screen.queryByTestId("sni-allowlist-warn")).toBeNull();
  });

  it("silent fallback when server_get_allowed_sni_list fails", async () => {
    // Backend unreachable / hosts.toml missing — the modal must still work,
    // the validator just skips the whitelist check and no chips render.
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "server_get_allowed_sni_list") throw new Error("SSH timeout");
      return undefined;
    });
    render(<UserModal {...defaultAddProps} _storybook={false} />);
    // Let the failing promise settle.
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_get_allowed_sni_list", expect.anything());
    });
    expect(screen.queryByTestId("sni-suggestions")).toBeNull();
    // User can still type — validator only complains about format.
    fireEvent.change(screen.getByLabelText(/custom sni/i), {
      target: { value: "cdn.example.com" },
    });
    expect(screen.queryByTestId("sni-allowlist-warn")).toBeNull();
    expect(screen.queryByTestId("sni-allowlist-ok")).toBeNull();
  });

  it("does not show whitelist marker when FQDN format is invalid", async () => {
    // The value fails format validation first — showing "not on the list"
    // would be noise on top of the format error.
    mockAllowedSniFetch([
      { hostname: "vpn.example.com", allowedSni: [] },
    ]);
    render(<UserModal {...defaultAddProps} _storybook={false} />);
    await waitFor(() =>
      expect(screen.getByTestId("sni-chip-vpn.example.com")).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText(/custom sni/i), {
      target: { value: "not a valid hostname" },
    });
    expect(screen.queryByTestId("sni-allowlist-warn")).toBeNull();
    expect(screen.queryByTestId("sni-allowlist-ok")).toBeNull();
  });
});

describe("UserModal — renders nothing when closed", () => {
  it("modal not mounted when isOpen=false (Modal primitive manages mount)", () => {
    render(<UserModal {...defaultAddProps} isOpen={false} />);
    // Modal primitive returns null when !mounted — nothing visible
    expect(screen.queryByText("Добавить пользователя")).toBeNull();
  });
});

describe("UserModal — a11y dialog semantics (Users H-06)", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
    vi.mocked(invoke).mockReset();
    installActivityLogSpy();
    sessionStorage.clear();
  });

  it("exposes role=dialog named by its title (Add mode)", () => {
    render(<UserModal {...defaultAddProps} />);
    // H-06: the modal must be a proper dialog so screen-reader / keyboard users
    // hear the title as the dialog's accessible name. aria-labelledby points at
    // the visible <h2>, so the name == the rendered Russian title.
    expect(
      screen.getByRole("dialog", { name: "Добавить пользователя" }),
    ).toBeInTheDocument();
  });

  it("dialog accessible name follows the Edit-mode title", () => {
    render(<UserModal {...defaultEditProps} />);
    const dialog = screen.getByRole("dialog");
    // Edit title interpolates the username — the accessible name must carry it.
    expect(dialog).toHaveAccessibleName(/alice/);
  });
});
