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

  it("calls onUserAdded after successful add", async () => {
    const onUserAdded = vi.fn();
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    render(<UserModal {...defaultAddProps} onUserAdded={onUserAdded} />);
    fireEvent.change(screen.getByPlaceholderText(/имя пользователя/i), {
      target: { value: "newuser" },
    });
    fireEvent.change(screen.getByPlaceholderText(/пароль/i), {
      target: { value: "Pass123!" },
    });
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      expect(onUserAdded).toHaveBeenCalledWith("newuser");
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
    // Toggle pin cert (last toggle)
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

  it("opens rotation prompt when 'Сменить пароль' is clicked", () => {
    render(<UserModal {...defaultEditProps} />);
    fireEvent.click(screen.getByTestId("rotate-password-btn"));
    expect(screen.getByTestId("password-rotation-prompt")).toBeInTheDocument();
  });

  it("calls server_update_user_config on save", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    render(<UserModal {...defaultEditProps} />);
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("server_update_user_config", expect.objectContaining({
        vpnUsername: "alice",
      }));
    });
  });

  it("calls onUserUpdated after successful save", async () => {
    const onUserUpdated = vi.fn();
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    render(<UserModal {...defaultEditProps} onUserUpdated={onUserUpdated} />);
    fireEvent.click(screen.getByTestId("user-modal-submit"));
    await waitFor(() => {
      expect(onUserUpdated).toHaveBeenCalledWith("alice");
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

describe("UserModal — renders nothing when closed", () => {
  it("modal not mounted when isOpen=false (Modal primitive manages mount)", () => {
    render(<UserModal {...defaultAddProps} isOpen={false} />);
    // Modal primitive returns null when !mounted — nothing visible
    expect(screen.queryByText("Добавить пользователя")).toBeNull();
  });
});
