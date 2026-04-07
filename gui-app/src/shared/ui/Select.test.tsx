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

  it("opens dropdown on click and shows all options", () => {
    render(<Select options={options} value="a" onChange={onChange} />);

    // Options not visible initially
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();

    // Click trigger button
    fireEvent.click(screen.getByRole("button"));

    // All option labels visible (Alpha appears twice: trigger + dropdown)
    expect(screen.getAllByText("Alpha")).toHaveLength(2);
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.getByText("Gamma")).toBeInTheDocument();
  });

  it("calls onChange with selected option value", () => {
    render(<Select options={options} value="a" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button")); // open
    fireEvent.click(screen.getByText("Gamma")); // pick option

    expect(onChange).toHaveBeenCalledWith({ target: { value: "c" } });
  });

  it("closes dropdown after selecting an option", () => {
    render(<Select options={options} value="a" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByText("Beta"));

    // Dropdown should be closed — only the trigger button text remains
    // "Beta" will still show as the selected label if parent re-renders,
    // but the dropdown list should be gone (only 1 button total)
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
  });

  it("closes dropdown on outside click", () => {
    render(<Select options={options} value="a" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button")); // open
    expect(screen.getByText("Beta")).toBeInTheDocument(); // dropdown open

    fireEvent.mouseDown(document.body); // click outside

    // Dropdown options should disappear (Beta not rendered outside dropdown)
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
  });

  it("does not open when disabled", () => {
    render(<Select options={options} value="a" onChange={onChange} disabled />);

    fireEvent.click(screen.getByRole("button"));

    // Dropdown should not open — no option buttons besides the trigger
    expect(screen.queryByText("Beta")).not.toBeInTheDocument();
  });

  it("applies disabled styling", () => {
    render(<Select options={options} value="a" onChange={onChange} disabled />);

    const button = screen.getByRole("button");
    expect(button.className).toContain("opacity-50");
    expect(button.className).toContain("cursor-not-allowed");
  });
});
