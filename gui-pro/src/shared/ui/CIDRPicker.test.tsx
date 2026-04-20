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

  // FIX-I: leading "—" (value="") clearable option + 33 numeric prefixes (0..=32).
  it("PREFIX_OPTIONS starts with clearable '—' and covers 0..=32", () => {
    expect(PREFIX_OPTIONS).toHaveLength(34);
    expect(PREFIX_OPTIONS[0]).toEqual({ value: "", label: "—" });
    expect(PREFIX_OPTIONS[1]).toEqual({ value: "0", label: "0" });
    expect(PREFIX_OPTIONS[33]).toEqual({ value: "32", label: "32" });
    // Verify no gaps 0..32 in the numeric tail
    for (let i = 0; i <= 32; i++) {
      expect(PREFIX_OPTIONS[i + 1].value).toBe(String(i));
      expect(PREFIX_OPTIONS[i + 1].label).toBe(String(i));
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

  // Paste fan-out handler: вставка целого IP в любой octet распределяет
  // значения по всем четырём полям + подтягивает /prefix если был.
  it("paste: IP string fans out across all 4 octets when pasted into octet 0", () => {
    const onChange = vi.fn();
    render(<CIDRPicker value="" onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox");
    // clipboardData mock. React synthetic paste event получает data через
    // getData("text"); jsdom не реализует clipboardData полностью, поэтому
    // stub вручную.
    fireEvent.paste(inputs[0], {
      clipboardData: { getData: () => "109.194.163.8" },
    });
    expect(inputs[0]).toHaveValue("109");
    expect(inputs[1]).toHaveValue("194");
    expect(inputs[2]).toHaveValue("163");
    expect(inputs[3]).toHaveValue("8");
  });

  it("paste: CIDR string fills octets and prefix", () => {
    const onChange = vi.fn();
    render(<CIDRPicker value="" onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox");
    fireEvent.paste(inputs[2], {
      clipboardData: { getData: () => "10.0.0.0/24" },
    });
    expect(inputs[0]).toHaveValue("10");
    expect(inputs[3]).toHaveValue("0");
    // onChange must include the parsed prefix
    expect(onChange).toHaveBeenLastCalledWith("10.0.0.0/24");
  });

  it("paste: tolerates surrounding noise, extracts first 4 numbers", () => {
    const onChange = vi.fn();
    render(<CIDRPicker value="" onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox");
    fireEvent.paste(inputs[0], {
      clipboardData: { getData: () => "  IP: 109.194.163.8 (home) " },
    });
    expect(inputs[0]).toHaveValue("109");
    expect(inputs[3]).toHaveValue("8");
  });

  it("paste: rejects malformed input (< 4 octets) — falls back to default", () => {
    const onChange = vi.fn();
    render(<CIDRPicker value="" onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox");
    // Only 3 numbers → tryFanOutPaste returns false, e.preventDefault
    // NOT called. Default paste runs in the single input, но мы мокаем
    // без set value — проверяем что остальные поля пустые.
    fireEvent.paste(inputs[0], {
      clipboardData: { getData: () => "10.0.0" },
    });
    expect(inputs[1]).toHaveValue("");
    expect(inputs[2]).toHaveValue("");
    expect(inputs[3]).toHaveValue("");
  });

  it("paste: rejects octet > 255", () => {
    const onChange = vi.fn();
    render(<CIDRPicker value="" onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox");
    fireEvent.paste(inputs[0], {
      clipboardData: { getData: () => "300.0.0.0" },
    });
    expect(inputs[0]).toHaveValue("");
  });

  // WR-05 (14.1-REVIEW deep pass): ambiguous pastes should fall through to
  // default single-field paste instead of silently truncating. Covers the
  // edge cases added after the deep review:
  //   - >4 numeric groups → reject (could be 5-octet typo, not a valid IPv4)
  //   - malformed prefix (/3a4, /99 etc.) → prefix NOT applied
  it("paste: rejects >4 numeric groups (ambiguous) — falls back to default", () => {
    const onChange = vi.fn();
    render(<CIDRPicker value="" onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox");
    // 5 octets — maybe user meant «10.0.0.0/24» and typo'd an extra group.
    // Silent truncation to first 4 would hide the error; default paste
    // into single field makes it visible.
    fireEvent.paste(inputs[0], {
      clipboardData: { getData: () => "10.20.30.40.50" },
    });
    // Other octets NOT populated — handler fell through to default paste.
    expect(inputs[1]).toHaveValue("");
    expect(inputs[2]).toHaveValue("");
    expect(inputs[3]).toHaveValue("");
  });

  it("paste: rejects malformed prefix '/3a4' — prefix unchanged", () => {
    const onChange = vi.fn();
    render(<CIDRPicker value="10.0.0.0/16" onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox");
    // Paste with malformed prefix. Body parses (10.0.0.0), but prefix part
    // '3a4' contains non-digits → prefix stays at existing /16.
    fireEvent.paste(inputs[0], {
      clipboardData: { getData: () => "10.0.0.0/3a4" },
    });
    // Octets applied
    expect(inputs[0]).toHaveValue("10");
    // Prefix stayed at /16 — onChange was called with that preserved prefix
    expect(onChange).toHaveBeenLastCalledWith("10.0.0.0/16");
  });

  it("paste: rejects out-of-range prefix '/99' — prefix unchanged", () => {
    const onChange = vi.fn();
    render(<CIDRPicker value="10.0.0.0/8" onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox");
    fireEvent.paste(inputs[0], {
      clipboardData: { getData: () => "192.168.1.1/99" },
    });
    expect(inputs[0]).toHaveValue("192");
    // /99 is 2 digits so passes the \d{1,2} check but fails the 0..32 range
    // guard → prefix stays at /8
    expect(onChange).toHaveBeenLastCalledWith("192.168.1.1/8");
  });

  it("paste: accepts 2-digit valid prefix (boundary)", () => {
    const onChange = vi.fn();
    render(<CIDRPicker value="" onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox");
    fireEvent.paste(inputs[0], {
      clipboardData: { getData: () => "172.16.0.0/32" },
    });
    expect(onChange).toHaveBeenLastCalledWith("172.16.0.0/32");
  });

  it("paste: accepts prefix with surrounding whitespace", () => {
    const onChange = vi.fn();
    render(<CIDRPicker value="" onChange={onChange} />);
    const inputs = screen.getAllByRole("textbox");
    fireEvent.paste(inputs[0], {
      clipboardData: { getData: () => "10.0.0.0 / 24 " },
    });
    // The whole input is trimmed before split('/'), prefix part is " 24 "
    // which after trim() is "24" and passes \d{1,2} + range guard.
    expect(inputs[0]).toHaveValue("10");
    expect(onChange).toHaveBeenLastCalledWith("10.0.0.0/24");
  });
});
