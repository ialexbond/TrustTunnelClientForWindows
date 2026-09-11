import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../i18n";
import { TabsInline } from "./TabsInline";

beforeEach(() => {
  i18n.changeLanguage("ru");
});

describe("TabsInline", () => {
  const TABS = [
    { id: "http1", label: "HTTP/1", content: <div>http1 panel</div> },
    { id: "http2", label: "HTTP/2", content: <div>http2 panel</div> },
    { id: "quic", label: "QUIC", content: <div>quic panel</div> },
  ];

  it("renders all tabs and activates the first by default", () => {
    render(<TabsInline tabs={TABS} ariaLabel="Listen protocols" />);
    expect(
      screen.getByRole("tablist", { name: "Listen protocols" })
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "HTTP/1" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "HTTP/2" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
    expect(screen.getByText("http1 panel")).toBeInTheDocument();
  });

  it("clicking a tab activates it and shows its panel", () => {
    render(<TabsInline tabs={TABS} />);
    fireEvent.click(screen.getByRole("tab", { name: "HTTP/2" }));
    expect(screen.getByRole("tab", { name: "HTTP/2" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("http2 panel")).toBeInTheDocument();
    expect(screen.queryByText("http1 panel")).not.toBeInTheDocument();
  });

  it("ArrowRight moves focus to the next tab without activating", () => {
    render(<TabsInline tabs={TABS} defaultTab="http1" />);
    const tab1 = screen.getByRole("tab", { name: "HTTP/1" });
    tab1.focus();
    fireEvent.keyDown(tab1, { key: "ArrowRight" });
    // Manual activation: focus moved but tab1 still selected
    expect(screen.getByRole("tab", { name: "HTTP/1" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("tab", { name: "HTTP/2" })).toHaveAttribute(
      "aria-selected",
      "false"
    );
  });

  it("Home/End move focus to first/last tab without activating", () => {
    render(<TabsInline tabs={TABS} defaultTab="http2" />);
    const tab2 = screen.getByRole("tab", { name: "HTTP/2" });
    tab2.focus();
    fireEvent.keyDown(tab2, { key: "End" });
    // Selected tab unchanged (manual activation)
    expect(screen.getByRole("tab", { name: "HTTP/2" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    fireEvent.keyDown(tab2, { key: "Home" });
    expect(screen.getByRole("tab", { name: "HTTP/2" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("respects defaultTab prop", () => {
    render(<TabsInline tabs={TABS} defaultTab="quic" />);
    expect(screen.getByRole("tab", { name: "QUIC" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("quic panel")).toBeInTheDocument();
  });

  it("returns null for empty tabs array", () => {
    const { container } = render(<TabsInline tabs={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("links tab and tabpanel via aria-controls / aria-labelledby", () => {
    render(<TabsInline tabs={TABS} idPrefix="proto" />);
    const tab = screen.getByRole("tab", { name: "HTTP/1" });
    const panel = screen.getByRole("tabpanel");
    expect(tab.getAttribute("aria-controls")).toBe("panel-proto-http1");
    expect(tab.id).toBe("tab-proto-http1");
    expect(panel.getAttribute("aria-labelledby")).toBe("tab-proto-http1");
    expect(panel.id).toBe("panel-proto-http1");
  });
});
