import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { UserModal } from "./UserModal";
import { renderWithProviders as render } from "../../test/test-utils";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: vi.fn() }),
}));
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
    const antiDpiSwitch = screen.getAllByRole("switch")[0];
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

  it("calls server_add_user_advanced on submit", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    render(<UserModal {...defaultAddProps} />);
    // Set valid username and password
    fireEvent.change(screen.getByPlaceholderText(/имя пользователя/i), {
      target: { value: "testuser" },
    });
    fireEvent.change(screen.getByPlaceholderText(/пароль/i), {
      target: { value: "TestPass123" },
    });
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_add_user_advanced", expect.objectContaining({
        vpnUsername: "testuser",
        vpnPassword: "TestPass123",
        antiDpi: true,
      }));
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
    const toggles = screen.getAllByRole("switch");
    // pinCert is the 3rd toggle (antiDpi, skipVerify, pinCert)
    const pinCertToggle = toggles[2];
    fireEvent.click(pinCertToggle);
    expect(screen.getByTestId("cert-fingerprint-card")).toBeInTheDocument();
  });

  it("does NOT show dirty warning in Add mode (no initial snapshot)", () => {
    render(<UserModal {...defaultAddProps} />);
    expect(screen.queryByTestId("deeplink-dirty-banner")).toBeNull();
  });
});

describe("UserModal — Edit mode", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
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
    fireEvent.click(screen.getAllByRole("switch")[0]);
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
    fireEvent.click(screen.getAllByRole("switch")[0]);
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
    fireEvent.click(screen.getAllByRole("switch")[0]);
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

  it("shows dirty warning banner when deeplink fields are modified (D-9)", () => {
    render(<UserModal {...defaultEditProps} />);
    // Toggle anti-DPI to change from default
    const antiDpiSwitch = screen.getAllByRole("switch")[0];
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

  it("X button calls onClose", () => {
    const onClose = vi.fn();
    render(<UserModal {...defaultEditProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("user-modal-close"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("UserModal — M-01 Custom SNI autocomplete", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
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
