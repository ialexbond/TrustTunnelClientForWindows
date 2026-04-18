import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import i18n from "../i18n";
import { CIDRPicker, PREFIX_OPTIONS } from "./CIDRPicker";

describe("CIDRPicker", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
  });

  it("renders 4 octet inputs and 1 prefix select", () => {
    render(<CIDRPicker value="" onChange={vi.fn()} />);
    // 4 textbox inputs (octets rendered as NumberInput → type="text")
    const inputs = screen.getAllByRole("textbox");
    expect(inputs).toHaveLength(4);
    // 1 combobox (Select)
    const combos = screen.getAllByRole("combobox");
    expect(combos).toHaveLength(1);
  });

  it("shows parsed octets for 10.0.0.0/24", () => {
    render(<CIDRPicker value="10.0.0.0/24" onChange={vi.fn()} />);
    const inputs = screen.getAllByRole("textbox");
    expect(inputs[0]).toHaveValue("10");
    expect(inputs[1]).toHaveValue("0");
    expect(inputs[2]).toHaveValue("0");
    expect(inputs[3]).toHaveValue("0");
  });

  it("calls onChange with full CIDR when first octet is changed", () => {
    const onChange = vi.fn();
    render(<CIDRPicker value="10.0.0.0/24" onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[0], { target: { value: "192" } });
    expect(onChange).toHaveBeenLastCalledWith("192.0.0.0/24");
  });

  it("calls onChange with '' when any octet is cleared", () => {
    const onChange = vi.fn();
    render(<CIDRPicker value="10.0.0.0/24" onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox");
    fireEvent.change(inputs[1], { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  // W12 revision: assert 33 prefix options via exported constant
  it("PREFIX_OPTIONS has exactly 33 entries (0..=32)", () => {
    expect(PREFIX_OPTIONS).toHaveLength(33);
    expect(PREFIX_OPTIONS[0]).toEqual({ value: "0", label: "0" });
    expect(PREFIX_OPTIONS[32]).toEqual({ value: "32", label: "32" });
    // Verify no gaps 0..32
    for (let i = 0; i <= 32; i++) {
      expect(PREFIX_OPTIONS[i].value).toBe(String(i));
      expect(PREFIX_OPTIONS[i].label).toBe(String(i));
    }
  });

  it("disables all inputs when disabled prop is true", () => {
    render(<CIDRPicker value="10.0.0.0/24" onChange={vi.fn()} disabled />);
    const inputs = screen.getAllByRole("textbox");
    inputs.forEach((input) => {
      expect(input).toBeDisabled();
    });
    // prefix Select button is also disabled
    const combos = screen.getAllByRole("combobox");
    combos.forEach((combo) => {
      expect(combo).toBeDisabled();
    });
  });

  it("applies aria-label to wrapper div", () => {
    const { container } = render(
      <CIDRPicker value="" onChange={vi.fn()} aria-label="CIDR ограничение" />
    );
    const wrapper = container.querySelector('[aria-label="CIDR ограничение"]');
    expect(wrapper).toBeInTheDocument();
  });

  it("renders custom helperText when provided", () => {
    render(<CIDRPicker value="10.0.0.0/24" onChange={vi.fn()} helperText="Custom hint" />);
    expect(screen.getByText("Custom hint")).toBeInTheDocument();
  });

  it("renders auto helper with range for valid CIDR", () => {
    render(<CIDRPicker value="10.0.0.0/24" onChange={vi.fn()} />);
    // describeCidr("10.0.0.0/24") returns "10.0.0.0 – 10.0.0.255 (256 addresses)"
    expect(screen.getByText(/10\.0\.0\.0/)).toBeInTheDocument();
    expect(screen.getByText(/256 addresses/)).toBeInTheDocument();
  });

  it("renders a helper for empty value (i18n key resolved)", () => {
    render(<CIDRPicker value="" onChange={vi.fn()} />);
    // describeCidr("") returns "server.users.cidr_empty_any" which is fed to t()
    // It renders either translated text or the key itself as fallback
    const helper = screen.queryByRole("paragraph") ?? document.querySelector("p");
    expect(helper).toBeTruthy();
  });

  it("shows label when label prop provided", () => {
    render(<CIDRPicker value="" onChange={vi.fn()} label="IP Range" />);
    expect(screen.getByText("IP Range")).toBeInTheDocument();
  });

  it("calls onError callback (callable without error)", () => {
    const onError = vi.fn();
    render(<CIDRPicker value="" onChange={vi.fn()} onError={onError} />);
    expect(onError).not.toHaveBeenCalled();
  });

  it("calls onChange and onError when octet changes from filled CIDR", () => {
    const onChange = vi.fn();
    const onError = vi.fn();
    render(<CIDRPicker value="10.0.0.0/24" onChange={onChange} onError={onError} />);
    const inputs = screen.getAllByRole("textbox");
    // Change second octet to non-empty → produces new valid CIDR
    fireEvent.change(inputs[1], { target: { value: "5" } });
    expect(onChange).toHaveBeenLastCalledWith("10.5.0.0/24");
    // onError should have been called with "" (valid CIDR)
    expect(onError).toHaveBeenLastCalledWith("");
  });
});
