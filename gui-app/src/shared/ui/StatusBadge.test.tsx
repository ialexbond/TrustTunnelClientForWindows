import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it("renders default disconnected variant with label 'Отключено'", () => {
    render(<StatusBadge />);
    expect(screen.getByText("Отключено")).toBeInTheDocument();
  });

  it("renders connected variant with label 'Подключено'", () => {
    render(<StatusBadge variant="connected" />);
    expect(screen.getByText("Подключено")).toBeInTheDocument();
  });

  it("renders connecting variant with label 'Подключение...'", () => {
    render(<StatusBadge variant="connecting" />);
    expect(screen.getByText("Подключение...")).toBeInTheDocument();
  });

  it("renders error variant with label 'Ошибка'", () => {
    render(<StatusBadge variant="error" />);
    expect(screen.getByText("Ошибка")).toBeInTheDocument();
  });

  it("custom label prop overrides default label text", () => {
    render(<StatusBadge variant="connected" label="VPN активен" />);
    expect(screen.getByText("VPN активен")).toBeInTheDocument();
    expect(screen.queryByText("Подключено")).not.toBeInTheDocument();
  });

  it("each variant has a dot indicator element", () => {
    const { container } = render(<StatusBadge variant="connected" />);
    const dot = container.querySelector("[data-testid='status-dot']");
    expect(dot).toBeInTheDocument();
  });
});
