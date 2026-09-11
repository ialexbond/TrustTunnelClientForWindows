import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge", () => {
  it("renders default disconnected variant with label from i18n", () => {
    render(<StatusBadge />);
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
  });

  it("renders connected variant with label from i18n", () => {
    render(<StatusBadge variant="connected" />);
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("renders connecting variant with label from i18n", () => {
    render(<StatusBadge variant="connecting" />);
    expect(screen.getByText("Connecting...")).toBeInTheDocument();
  });

  it("renders error variant with label from i18n", () => {
    render(<StatusBadge variant="error" />);
    expect(screen.getByText("Error")).toBeInTheDocument();
  });

  it("custom label prop overrides default label text", () => {
    render(<StatusBadge variant="connected" label="VPN активен" />);
    expect(screen.getByText("VPN активен")).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("each variant has a dot indicator element", () => {
    const { container } = render(<StatusBadge variant="connected" />);
    const dot = container.querySelector("[data-testid='status-dot']");
    expect(dot).toBeInTheDocument();
  });
});
