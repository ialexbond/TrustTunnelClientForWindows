import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FormField } from "./FormField";

describe("FormField", () => {
  it("renders label text", () => {
    render(
      <FormField label="Username">
        <input />
      </FormField>
    );
    expect(screen.getByText("Username")).toBeInTheDocument();
  });

  it("renders children (input element)", () => {
    render(
      <FormField label="Email">
        <input data-testid="email-input" />
      </FormField>
    );
    expect(screen.getByTestId("email-input")).toBeInTheDocument();
  });

  it("shows required * indicator when required=true", () => {
    render(
      <FormField label="Password" required>
        <input />
      </FormField>
    );
    expect(screen.getByText("*")).toBeInTheDocument();
  });

  it("shows error message with role='alert' when error prop set", () => {
    render(
      <FormField label="Field" error="This field is required">
        <input />
      </FormField>
    );
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent("This field is required");
  });

  it("shows hint text when hint prop provided and no error", () => {
    render(
      <FormField label="Field" hint="Enter your full name">
        <input />
      </FormField>
    );
    expect(screen.getByText("Enter your full name")).toBeInTheDocument();
  });

  it("hides hint when error is present (error takes priority)", () => {
    render(
      <FormField label="Field" hint="Hint text" error="Error text">
        <input />
      </FormField>
    );
    expect(screen.queryByText("Hint text")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Error text");
  });
});
