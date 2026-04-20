import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Select } from "./Select";

const options = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gamma" },
];

describe("Select", () => {
  let onChange: (e: { target: { value: string } }) => void;

  beforeEach(() => {
    onChange = vi.fn();
  });

  it("renders selected value label", () => {
    render(<Select options={options} value="b" onChange={onChange} />);
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("renders placeholder when no value selected", () => {
    render(<Select options={options} onChange={onChange} />);
    expect(screen.getByText("Select...")).toBeInTheDocument();
  });

  it("renders custom placeholder", () => {
    render(<Select options={options} onChange={onChange} placeholder="Select option" />);
    expect(screen.getByText("Select option")).toBeInTheDocument();
  });

  it("renders label and description when provided", () => {
    render(
      <Select
        options={options}
        value="a"
        label="Pick one"
        description="Helper text"
        onChange={onChange}
      />,
    );
    expect(screen.getByText("Pick one")).toBeInTheDocument();
    expect(screen.getByText("Helper text")).toBeInTheDocument();
  });

  it("has combobox role on trigger", () => {
    render(<Select options={options} value="a" onChange={onChange} />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("trigger has aria-expanded=false when closed", () => {
    render(<Select options={options} value="a" onChange={onChange} />);
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "false");
  });

  it("opens dropdown on click and shows all options", () => {
    render(<Select options={options} value="a" onChange={onChange} />);

    // Options not visible initially
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();

    // Click trigger button
    fireEvent.click(screen.getByRole("combobox"));

    // All option labels visible (Alpha appears twice: trigger + dropdown)
    expect(screen.getAllByText("Alpha")).toHaveLength(2);
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Gamma")).toBeInTheDocument();
  });

  it("trigger has aria-expanded=true when open", () => {
    render(<Select options={options} value="a" onChange={onChange} />);
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("combobox")).toHaveAttribute("aria-expanded", "true");
  });

  it("dropdown has listbox role", () => {
    render(<Select options={options} value="a" onChange={onChange} />);
    fireEvent.click(screen.getByRole("combobox"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("options have option role and aria-selected", () => {
    render(<Select options={options} value="a" onChange={onChange} />);
    fireEvent.click(screen.getByRole("combobox"));
    const optionEls = screen.getAllByRole("option");
    expect(optionEls).toHaveLength(3);
    expect(optionEls[0]).toHaveAttribute("aria-selected", "true");
    expect(optionEls[1]).toHaveAttribute("aria-selected", "false");
  });

  it("calls onChange with selected option value", () => {
    render(<Select options={options} value="a" onChange={onChange} />);

    fireEvent.click(screen.getByRole("combobox")); // open
    fireEvent.click(screen.getByText("Gamma")); // pick option

    expect(onChange).toHaveBeenCalledWith({ target: { value: "c" } });
  });

  it("closes dropdown after selecting an option", () => {
    render(<Select options={options} value="a" onChange={onChange} />);

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByText("Beta"));

    // Dropdown should be closed — listbox gone
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("closes dropdown on outside click", () => {
    render(<Select options={options} value="a" onChange={onChange} />);

    fireEvent.click(screen.getByRole("combobox")); // open
    expect(screen.getByRole("listbox")).toBeInTheDocument(); // dropdown open

    fireEvent.mouseDown(document.body); // click outside

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("does not open when disabled", () => {
    render(<Select options={options} value="a" onChange={onChange} disabled />);

    fireEvent.click(screen.getByRole("combobox"));

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("applies disabled styling", () => {
    render(<Select options={options} value="a" onChange={onChange} disabled />);

    const button = screen.getByRole("combobox");
    expect(button.className).toContain("opacity-[var(--opacity-disabled)]");
    expect(button.className).toContain("cursor-not-allowed");
  });

  it("keyboard ArrowDown opens dropdown", () => {
    render(<Select options={options} value="a" onChange={onChange} />);

    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("keyboard Enter selects highlighted option", () => {
    render(<Select options={options} value="a" onChange={onChange} />);

    const trigger = screen.getByRole("combobox");
    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // open
    fireEvent.keyDown(trigger, { key: "ArrowDown" }); // move to next (Beta)
    fireEvent.keyDown(trigger, { key: "Enter" });     // select

    expect(onChange).toHaveBeenCalledWith({ target: { value: "b" } });
  });

  it("keyboard Escape closes dropdown", () => {
    render(<Select options={options} value="a" onChange={onChange} />);

    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger); // open
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
