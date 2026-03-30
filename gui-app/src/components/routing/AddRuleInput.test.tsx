import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { AddRuleInput } from "./AddRuleInput";
import type { RouteAction, GeoDataIndex, GeoDataStatus } from "./useRoutingState";

function defaultGeoStatus(): GeoDataStatus {
  return {
    downloaded: true,
    geoip_exists: true,
    geosite_exists: true,
    geoip_categories_count: 5,
    geosite_categories_count: 10,
  };
}

function defaultGeoCategories(): GeoDataIndex {
  return { geoip: ["RU", "US", "CN"], geosite: ["google", "facebook", "youtube"] };
}

// jsdom does not implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("AddRuleInput", () => {
  let onAdd: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    i18n.changeLanguage("ru");
    onAdd = vi.fn().mockReturnValue(null);
  });

  function renderInput(overrides: { action?: RouteAction } = {}) {
    return render(
      <AddRuleInput
        action={overrides.action ?? "proxy"}
        geodataStatus={defaultGeoStatus()}
        geodataCategories={defaultGeoCategories()}
        onAdd={onAdd}
      />,
    );
  }

  it("renders without crashing", () => {
    renderInput();
    expect(screen.getByPlaceholderText(/domain\.com/)).toBeInTheDocument();
  });

  it("shows placeholder text from i18n", () => {
    renderInput();
    expect(screen.getByPlaceholderText("domain.com, IP, geoip:RU, geosite:category...")).toBeInTheDocument();
  });

  it("add button is disabled when input is empty", () => {
    renderInput();
    const addBtn = screen.getByRole("button");
    expect(addBtn).toBeDisabled();
  });

  it("add button becomes enabled when user types text", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "example.com");
    // The plus button (second button — first is clear)
    const buttons = screen.getAllByRole("button");
    const addBtn = buttons[buttons.length - 1];
    expect(addBtn).not.toBeDisabled();
  });

  it("calls onAdd when clicking add button with valid domain", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "example.com");
    // Click the add (Plus) button
    const buttons = screen.getAllByRole("button");
    const addBtn = buttons[buttons.length - 1];
    fireEvent.click(addBtn);
    expect(onAdd).toHaveBeenCalledWith("proxy", "example.com");
  });

  it("calls onAdd on Enter key press", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "10.0.0.1{Enter}");
    expect(onAdd).toHaveBeenCalledWith("proxy", "10.0.0.1");
  });

  it("clears input after successful add", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/) as HTMLInputElement;
    await userEvent.type(input, "example.com{Enter}");
    expect(input.value).toBe("");
  });

  it("shows error for duplicate entry", async () => {
    onAdd.mockReturnValue("duplicate");
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "example.com{Enter}");
    expect(screen.getByText("Такая запись уже существует")).toBeInTheDocument();
  });

  it("shows validation error for domain without dot", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "example{Enter}");
    expect(screen.getByText(/полный домен/)).toBeInTheDocument();
  });

  it("shows validation error for invalid format", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "!!!invalid!!!{Enter}");
    expect(screen.getByText(/Допустимы/)).toBeInTheDocument();
  });

  it("accepts valid IP address", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "192.168.1.1{Enter}");
    expect(onAdd).toHaveBeenCalledWith("proxy", "192.168.1.1");
  });

  it("accepts valid CIDR", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "10.0.0.0/8{Enter}");
    expect(onAdd).toHaveBeenCalledWith("proxy", "10.0.0.0/8");
  });

  it("accepts geoip: prefix without validation error", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    fireEvent.change(input, { target: { value: "geoip:RU" } });
    // Press add button
    const buttons = screen.getAllByRole("button");
    const addBtn = buttons[buttons.length - 1];
    fireEvent.click(addBtn);
    expect(onAdd).toHaveBeenCalledWith("proxy", "geoip:RU");
  });

  it("shows clear button when input has text", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "test");
    // Should have 2 buttons now: clear (X) and add (Plus)
    const buttons = screen.getAllByRole("button");
    expect(buttons.length).toBe(2);
  });

  it("clears input when clear button is clicked", async () => {
    renderInput();
    const input = screen.getByPlaceholderText(/domain\.com/) as HTMLInputElement;
    await userEvent.type(input, "test.com");
    const buttons = screen.getAllByRole("button");
    // Click clear button (first)
    fireEvent.click(buttons[0]);
    expect(input.value).toBe("");
  });

  it("passes correct action to onAdd", async () => {
    renderInput({ action: "direct" });
    const input = screen.getByPlaceholderText(/domain\.com/);
    await userEvent.type(input, "example.com{Enter}");
    expect(onAdd).toHaveBeenCalledWith("direct", "example.com");
  });
});
