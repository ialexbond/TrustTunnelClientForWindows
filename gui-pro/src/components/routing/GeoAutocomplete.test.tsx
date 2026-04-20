import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { GeoAutocomplete } from "./GeoAutocomplete";

// jsdom does not implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

describe("GeoAutocomplete", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onSelect: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onClose: any;

  const categories = ["ru", "us", "cn", "de", "fr", "jp", "gb"];

  beforeEach(() => {
    i18n.changeLanguage("ru");
    onSelect = vi.fn();
    onClose = vi.fn();
  });

  it("renders without crashing", () => {
    render(
      <GeoAutocomplete
        prefix="geoip"
        query=""
        categories={categories}
        downloaded={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    // Should show the list of categories
    expect(screen.getByText("cn")).toBeInTheDocument();
    expect(screen.getByText("ru")).toBeInTheDocument();
  });

  it("shows download prompt when not downloaded", () => {
    render(
      <GeoAutocomplete
        prefix="geoip"
        query=""
        categories={categories}
        downloaded={false}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("Сначала скачайте геоданные")).toBeInTheDocument();
  });

  it("filters categories by query", () => {
    render(
      <GeoAutocomplete
        prefix="geoip"
        query="r"
        categories={categories}
        downloaded={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("ru")).toBeInTheDocument();
    expect(screen.queryByText("cn")).not.toBeInTheDocument();
    expect(screen.queryByText("us")).not.toBeInTheDocument();
  });

  it("shows 'no matches' when query has no results", () => {
    render(
      <GeoAutocomplete
        prefix="geoip"
        query="zzz"
        categories={categories}
        downloaded={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("Нет совпадений")).toBeInTheDocument();
  });

  it("selects item on mousedown", () => {
    render(
      <GeoAutocomplete
        prefix="geoip"
        query=""
        categories={categories}
        downloaded={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    const option = screen.getByText("ru");
    fireEvent.mouseDown(option);
    expect(onSelect).toHaveBeenCalledWith("geoip:ru");
    expect(onClose).toHaveBeenCalled();
  });

  it("selects item with geosite prefix", () => {
    render(
      <GeoAutocomplete
        prefix="geosite"
        query=""
        categories={["google", "facebook", "youtube"]}
        downloaded={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    fireEvent.mouseDown(screen.getByText("google"));
    expect(onSelect).toHaveBeenCalledWith("geosite:google");
  });

  it("handles keyboard Escape to close", () => {
    render(
      <GeoAutocomplete
        prefix="geoip"
        query=""
        categories={categories}
        downloaded={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("handles keyboard Enter to select active item", () => {
    render(
      <GeoAutocomplete
        prefix="geoip"
        query=""
        categories={categories}
        downloaded={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    // First item is active by default (sorted alphabetically: cn)
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("geoip:cn");
  });

  it("navigates with ArrowDown and selects", () => {
    render(
      <GeoAutocomplete
        prefix="geoip"
        query=""
        categories={categories}
        downloaded={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    // Move down one position (from cn to de)
    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("geoip:de");
  });

  it("displays items sorted alphabetically", () => {
    render(
      <GeoAutocomplete
        prefix="geoip"
        query=""
        categories={["us", "ru", "cn"]}
        downloaded={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("cn");
    expect(options[1]).toHaveTextContent("ru");
    expect(options[2]).toHaveTextContent("us");
  });

  it("renders with empty categories list", () => {
    render(
      <GeoAutocomplete
        prefix="geoip"
        query=""
        categories={[]}
        downloaded={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    expect(screen.getByText("Нет совпадений")).toBeInTheDocument();
  });

  it("highlights active item on mouse enter", () => {
    render(
      <GeoAutocomplete
        prefix="geoip"
        query=""
        categories={categories}
        downloaded={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    const ruOption = screen.getByText("ru").closest("[role='option']")!;
    fireEvent.mouseEnter(ruOption);
    expect(ruOption).toHaveAttribute("aria-selected", "true");
  });
});
