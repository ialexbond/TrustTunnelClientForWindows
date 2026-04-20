import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PasswordInput } from "./PasswordInput";

describe("PasswordInput", () => {
  it("default type is password", () => {
    render(<PasswordInput placeholder="pwd" />);
    expect(screen.getByPlaceholderText("pwd")).toHaveAttribute("type", "password");
  });

  it("toggle button switches type to text and back", () => {
    render(<PasswordInput placeholder="pwd" />);
    const input = screen.getByPlaceholderText("pwd");
    const toggleBtn = screen.getByRole("button");

    // Click to show
    fireEvent.click(toggleBtn);
    expect(input).toHaveAttribute("type", "text");

    // Click to hide
    fireEvent.click(toggleBtn);
    expect(input).toHaveAttribute("type", "password");
  });

  it("onChange callback works", () => {
    const onChange = vi.fn();
    render(<PasswordInput placeholder="pwd" onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText("pwd"), { target: { value: "secret" } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("disabled state", () => {
    render(<PasswordInput placeholder="pwd" disabled />);
    expect(screen.getByPlaceholderText("pwd")).toBeDisabled();
  });
});
