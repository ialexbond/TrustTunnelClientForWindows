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

  // ── D-18/D-19: Enter inserts the exact typed value when it is a known value ──
  describe("Enter: exact typed value beats the automatic highlight (D-18)", () => {
    const ivory = ["ua", "uk", "us"];

    it("query 'uk' -> Enter inserts geoip:uk, not the highlighted geoip:ua", () => {
      render(
        <GeoAutocomplete
          prefix="geoip"
          query="uk"
          categories={ivory}
          downloaded={true}
          onSelect={onSelect}
          onClose={onClose}
        />,
      );
      fireEvent.keyDown(document, { key: "Enter" });
      expect(onSelect).toHaveBeenCalledWith("geoip:uk");
      expect(onSelect).not.toHaveBeenCalledWith("geoip:ua");
    });

    it("query 'UK' (case-insensitive) -> Enter inserts the canonical geoip:uk", () => {
      render(
        <GeoAutocomplete
          prefix="geoip"
          query="UK"
          categories={ivory}
          downloaded={true}
          onSelect={onSelect}
          onClose={onClose}
        />,
      );
      fireEvent.keyDown(document, { key: "Enter" });
      expect(onSelect).toHaveBeenCalledWith("geoip:uk");
    });

    it("query 'u' (not exact) -> Enter inserts the highlighted suggestion as today", () => {
      render(
        <GeoAutocomplete
          prefix="geoip"
          query="u"
          categories={ivory}
          downloaded={true}
          onSelect={onSelect}
          onClose={onClose}
        />,
      );
      // filtered = ["ua", "uk", "us"] (alphabetical, all start with "u"); first is highlighted.
      fireEvent.keyDown(document, { key: "Enter" });
      expect(onSelect).toHaveBeenCalledWith("geoip:ua");
    });

    it("a keystroke followed immediately by Enter acts on the LATEST query, not the previous render's list", () => {
      const { rerender } = render(
        <GeoAutocomplete
          prefix="geoip"
          query="u"
          categories={ivory}
          downloaded={true}
          onSelect={onSelect}
          onClose={onClose}
        />,
      );
      // Simulate a fast rerender (query changed to "uk") immediately followed by Enter, before
      // any effect/timeout from the "u" render has had a chance to run.
      rerender(
        <GeoAutocomplete
          prefix="geoip"
          query="uk"
          categories={ivory}
          downloaded={true}
          onSelect={onSelect}
          onClose={onClose}
        />,
      );
      fireEvent.keyDown(document, { key: "Enter" });
      expect(onSelect).toHaveBeenCalledWith("geoip:uk");
      expect(onSelect).not.toHaveBeenCalledWith("geoip:ua");
    });

    it("an explicit ArrowDown choice after the last keystroke is honoured over the exact-value rule", () => {
      render(
        <GeoAutocomplete
          prefix="geosite"
          query="google"
          categories={["google", "google-cn"]}
          downloaded={true}
          onSelect={onSelect}
          onClose={onClose}
        />,
      );
      // filtered = ["google", "google-cn"]; "google" is an exact match AND is highlighted by
      // default (index 0). Move to "google-cn" with ArrowDown — that explicit pick wins.
      fireEvent.keyDown(document, { key: "ArrowDown" });
      fireEvent.keyDown(document, { key: "Enter" });
      expect(onSelect).toHaveBeenCalledWith("geosite:google-cn");
    });

    it("typing again after an arrow choice resets it — the exact-value rule applies again", () => {
      const { rerender } = render(
        <GeoAutocomplete
          prefix="geosite"
          query="goog"
          categories={["google", "google-cn"]}
          downloaded={true}
          onSelect={onSelect}
          onClose={onClose}
        />,
      );
      fireEvent.keyDown(document, { key: "ArrowDown" }); // picks google-cn (index 1)
      // The person types one more character — the query changes, so the arrow pick must not
      // survive: the exact-value rule (query "google" matches a known category exactly) applies.
      rerender(
        <GeoAutocomplete
          prefix="geosite"
          query="google"
          categories={["google", "google-cn"]}
          downloaded={true}
          onSelect={onSelect}
          onClose={onClose}
        />,
      );
      fireEvent.keyDown(document, { key: "Enter" });
      expect(onSelect).toHaveBeenCalledWith("geosite:google");
    });
  });

  // ── IN-02 (03-REVIEW.md): activeIndex must never go negative ──
  it("IN-02: ArrowDown while filtered is empty, then filtered becomes non-empty without the query changing — Enter still selects the first item", () => {
    const { rerender } = render(
      <GeoAutocomplete
        prefix="geoip"
        query="z"
        categories={["ru"]}
        downloaded={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    // filtered = [] here (nothing starts with "z"), so ArrowDown would previously drive
    // activeIndex to -1 (Math.min(prev + 1, -1)).
    fireEvent.keyDown(document, { key: "ArrowDown" });
    // categories change WITHOUT the query changing, so the query-keyed reset effect does not
    // fire and activeIndex stays whatever ArrowDown left it at; filtered becomes non-empty.
    rerender(
      <GeoAutocomplete
        prefix="geoip"
        query="z"
        categories={["za"]}
        downloaded={true}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("geoip:za");
  });
});
