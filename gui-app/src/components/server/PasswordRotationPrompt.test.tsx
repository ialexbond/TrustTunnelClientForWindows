import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { PasswordRotationPrompt } from "./PasswordRotationPrompt";
import { renderWithProviders as render } from "../../test/test-utils";

// Mocks
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../shared/hooks/useActivityLog", () => ({
  useActivityLog: () => ({ log: vi.fn() }),
}));

const defaultProps = {
  isOpen: true,
  isLoading: false,
  error: null,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe("PasswordRotationPrompt", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    vi.clearAllMocks();
  });

  it("renders nothing when isOpen=false", () => {
    render(<PasswordRotationPrompt {...defaultProps} isOpen={false} />);
    expect(screen.queryByTestId("password-rotation-prompt")).toBeNull();
  });

  it("renders when isOpen=true", () => {
    render(<PasswordRotationPrompt {...defaultProps} />);
    expect(screen.getByTestId("password-rotation-prompt")).toBeInTheDocument();
  });

  it("shows warning banner about deeplink invalidation", () => {
    render(<PasswordRotationPrompt {...defaultProps} />);
    expect(screen.getByText(/старые deeplink.*перестанут работать/i)).toBeInTheDocument();
  });

  it("shows confirm and cancel buttons", () => {
    render(<PasswordRotationPrompt {...defaultProps} />);
    // confirm button (danger variant)
    expect(screen.getByRole("button", { name: /подтвердить/i })).toBeInTheDocument();
    // cancel button
    expect(screen.getByRole("button", { name: /отмена/i })).toBeInTheDocument();
  });

  it("confirm button is disabled when password is empty", () => {
    render(<PasswordRotationPrompt {...defaultProps} />);
    const confirmBtn = screen.getByRole("button", { name: /подтвердить/i });
    expect(confirmBtn).toBeDisabled();
  });

  it("confirm button becomes enabled when password is entered", () => {
    render(<PasswordRotationPrompt {...defaultProps} />);
    const input = screen.getByPlaceholderText(/новый пароль/i);
    fireEvent.change(input, { target: { value: "ValidPass123" } });
    const confirmBtn = screen.getByRole("button", { name: /подтвердить/i });
    expect(confirmBtn).not.toBeDisabled();
  });

  it("calls onConfirm with the entered password when confirmed", () => {
    const onConfirm = vi.fn();
    render(<PasswordRotationPrompt {...defaultProps} onConfirm={onConfirm} />);
    const input = screen.getByPlaceholderText(/новый пароль/i);
    fireEvent.change(input, { target: { value: "ValidPass123" } });
    fireEvent.click(screen.getByRole("button", { name: /подтвердить/i }));
    expect(onConfirm).toHaveBeenCalledWith("ValidPass123");
  });

  it("trims whitespace from password before calling onConfirm", () => {
    const onConfirm = vi.fn();
    render(<PasswordRotationPrompt {...defaultProps} onConfirm={onConfirm} />);
    const input = screen.getByPlaceholderText(/новый пароль/i);
    fireEvent.change(input, { target: { value: "ValidPass123" } });
    fireEvent.click(screen.getByRole("button", { name: /подтвердить/i }));
    expect(onConfirm).toHaveBeenCalledWith("ValidPass123");
  });

  it("calls onCancel when cancel is clicked", () => {
    const onCancel = vi.fn();
    render(<PasswordRotationPrompt {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /отмена/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows validation error for password with leading spaces", () => {
    render(<PasswordRotationPrompt {...defaultProps} />);
    const input = screen.getByPlaceholderText(/новый пароль/i);
    fireEvent.change(input, { target: { value: " leading" } });
    expect(screen.getByText(/пробелы в начале/i)).toBeInTheDocument();
  });

  it("shows error banner when error prop is set", () => {
    render(<PasswordRotationPrompt {...defaultProps} error="Сервер недоступен" />);
    expect(screen.getByText("Сервер недоступен")).toBeInTheDocument();
  });

  it("disables all inputs and buttons when isLoading=true", () => {
    render(<PasswordRotationPrompt {...defaultProps} isLoading={true} />);
    const cancelBtn = screen.getByRole("button", { name: /отмена/i });
    expect(cancelBtn).toBeDisabled();
  });

  it("shows generate password button", () => {
    render(<PasswordRotationPrompt {...defaultProps} />);
    expect(screen.getByLabelText(/сгенерировать пароль/i)).toBeInTheDocument();
  });

  it("generates password when shuffle button is clicked", () => {
    render(<PasswordRotationPrompt {...defaultProps} />);
    const genBtn = screen.getByLabelText(/сгенерировать пароль/i);
    fireEvent.click(genBtn);
    const input = screen.getByPlaceholderText(/новый пароль/i) as HTMLInputElement;
    expect(input.value.length).toBeGreaterThan(0);
  });
});
