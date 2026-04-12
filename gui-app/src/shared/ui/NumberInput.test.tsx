import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NumberInput } from "./NumberInput";

describe("NumberInput", () => {
  it("renders with label and placeholder", () => {
    render(
      <NumberInput value="" onChange={vi.fn()} label="Port" placeholder="1024-65535" />
    );
    expect(screen.getByText("Port")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("1024-65535")).toBeInTheDocument();
  });

  it("accepts valid number within range", () => {
    const onChange = vi.fn();
    render(
      <NumberInput value="" onChange={onChange} min={1024} max={65535} placeholder="port" />
    );
    const input = screen.getByPlaceholderText("port");
    // Simulate a paste or direct value change with a valid port
    fireEvent.change(input, { target: { value: "2222" } });
    expect(onChange).toHaveBeenCalledWith("2222");
  });

  it("shows error for value below min on blur", () => {
    render(
      <NumberInput value="100" onChange={vi.fn()} min={1024} max={65535} />
    );
    const input = screen.getByRole("textbox");
    fireEvent.blur(input);
    expect(screen.getByText(/1024/)).toBeInTheDocument();
  });

  it("shows error for value above max on blur", () => {
    render(
      <NumberInput value="70000" onChange={vi.fn()} min={1024} max={65535} />
    );
    const input = screen.getByRole("textbox");
    fireEvent.blur(input);
    expect(screen.getByText(/65535/)).toBeInTheDocument();
  });

  it("calls onChange with string value on input", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <NumberInput value="" onChange={onChange} placeholder="num" />
    );
    const input = screen.getByPlaceholderText("num");
    await user.type(input, "5");
    expect(onChange).toHaveBeenCalledWith("5");
  });

  it("disables input when disabled prop is true", () => {
    render(
      <NumberInput value="123" onChange={vi.fn()} disabled />
    );
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("filters non-numeric input", () => {
    const onChange = vi.fn();
    render(
      <NumberInput value="" onChange={onChange} placeholder="num" />
    );
    const input = screen.getByPlaceholderText("num");
    // Typing mixed content should strip non-digits
    fireEvent.change(input, { target: { value: "abc12def3" } });
    expect(onChange).toHaveBeenCalledWith("123");

    // Pure letters should produce empty string
    onChange.mockClear();
    fireEvent.change(input, { target: { value: "xyz" } });
    expect(onChange).toHaveBeenCalledWith("");
  });
});
