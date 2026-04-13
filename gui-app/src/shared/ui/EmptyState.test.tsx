import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders default heading 'Ничего нет'", () => {
    render(<EmptyState />);
    expect(screen.getByText("Ничего нет")).toBeInTheDocument();
  });

  it("renders default body 'Здесь появятся элементы после добавления.'", () => {
    render(<EmptyState />);
    expect(screen.getByText("Здесь появятся элементы после добавления.")).toBeInTheDocument();
  });

  it("renders custom heading when heading prop provided", () => {
    render(<EmptyState heading="Нет подключений" />);
    expect(screen.getByText("Нет подключений")).toBeInTheDocument();
    expect(screen.queryByText("Ничего нет")).not.toBeInTheDocument();
  });

  it("renders custom body when body prop provided", () => {
    render(<EmptyState body="Добавьте первый сервер для начала работы." />);
    expect(screen.getByText("Добавьте первый сервер для начала работы.")).toBeInTheDocument();
  });

  it("renders icon when icon prop provided", () => {
    render(<EmptyState icon={<span data-testid="test-icon">icon</span>} />);
    expect(screen.getByTestId("test-icon")).toBeInTheDocument();
  });

  it("renders action slot when action prop provided", () => {
    render(<EmptyState action={<button>Добавить</button>} />);
    expect(screen.getByRole("button", { name: "Добавить" })).toBeInTheDocument();
  });
});
