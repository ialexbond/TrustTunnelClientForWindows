import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { ServerUnavailablePlate } from "./ServerUnavailablePlate";
import { renderWithProviders as render } from "../../test/test-utils";

describe("ServerUnavailablePlate", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
  });

  it("renders the «Сервер недоступен» heading", () => {
    render(<ServerUnavailablePlate onRetry={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: "Сервер недоступен" }),
    ).toBeInTheDocument();
  });

  it("renders the explanatory body copy", () => {
    render(<ServerUnavailablePlate onRetry={vi.fn()} />);
    expect(
      screen.getByText(
        "Не удаётся связаться с сервером. Проверьте, что он включён и доступен по сети.",
      ),
    ).toBeInTheDocument();
  });

  it("invokes onRetry when the «Повторить» button is clicked", () => {
    const onRetry = vi.fn();
    render(<ServerUnavailablePlate onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
