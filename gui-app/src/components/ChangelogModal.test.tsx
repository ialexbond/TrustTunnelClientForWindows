import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChangelogModal } from "./ChangelogModal";

describe("ChangelogModal", () => {
  let onClose: () => void;

  beforeEach(() => {
    onClose = vi.fn() as unknown as () => void;
  });

  // UPD-01: modal opens when open=true, hides when open=false
  it("renders modal content when open=true", () => {
    render(
      <ChangelogModal
        open={true}
        onClose={onClose}
        version="2.3.0"
        releaseNotes="Hello world"
      />,
    );
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders nothing when open=false", () => {
    render(
      <ChangelogModal
        open={false}
        onClose={onClose}
        version="2.3.0"
        releaseNotes="Hello world"
      />,
    );
    expect(screen.queryByText("Hello world")).not.toBeInTheDocument();
  });

  // UPD-01: title uses i18n key modal.changelog_title with version interpolation
  it("displays changelog title with version from i18n", () => {
    render(
      <ChangelogModal
        open={true}
        onClose={onClose}
        version="2.3.0"
        releaseNotes=""
      />,
    );
    expect(screen.getByText("What's new in v2.3.0")).toBeInTheDocument();
  });

  // UPD-01: close button uses i18n key buttons.close
  it("renders close button with i18n text", () => {
    render(
      <ChangelogModal
        open={true}
        onClose={onClose}
        version="2.3.0"
        releaseNotes=""
      />,
    );
    // Footer close button (not the X icon button)
    expect(screen.getByText("Close")).toBeInTheDocument();
  });

  // UPD-01: onClose is called when close button is clicked
  it("calls onClose when footer close button is clicked", async () => {
    const user = userEvent.setup();
    render(
      <ChangelogModal
        open={true}
        onClose={onClose}
        version="2.3.0"
        releaseNotes=""
      />,
    );
    await user.click(screen.getByText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // UPD-01: onClose called when X icon button is clicked
  it("calls onClose when X icon button (aria-label=Close) is clicked", async () => {
    const user = userEvent.setup();
    render(
      <ChangelogModal
        open={true}
        onClose={onClose}
        version="2.3.0"
        releaseNotes=""
      />,
    );
    // The header X button has aria-label="Close"; the footer button contains text "Close"
    await user.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // UPD-01: markdown h1 renders as an h1 element
  it("renders markdown h1 as an h1 element", () => {
    render(
      <ChangelogModal
        open={true}
        onClose={onClose}
        version="2.3.0"
        releaseNotes="# Release Title"
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Release Title" })).toBeInTheDocument();
  });

  // UPD-01: markdown h2 renders as an h2 element
  it("renders markdown h2 as an h2 element", () => {
    render(
      <ChangelogModal
        open={true}
        onClose={onClose}
        version="2.3.0"
        releaseNotes="## Section Title"
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Section Title" })).toBeInTheDocument();
  });

  // UPD-01: markdown h3 renders as an h3 element
  it("renders markdown h3 as an h3 element", () => {
    render(
      <ChangelogModal
        open={true}
        onClose={onClose}
        version="2.3.0"
        releaseNotes="### Sub-section"
      />,
    );
    expect(screen.getByRole("heading", { level: 3, name: "Sub-section" })).toBeInTheDocument();
  });

  // UPD-01: markdown bold renders as <strong>
  it("renders markdown bold text as strong element", () => {
    render(
      <ChangelogModal
        open={true}
        onClose={onClose}
        version="2.3.0"
        releaseNotes="This is **bold text**"
      />,
    );
    const strong = document.querySelector("strong");
    expect(strong).toBeInTheDocument();
    expect(strong?.textContent).toBe("bold text");
  });

  // UPD-01: markdown italic renders as <em>
  it("renders markdown italic text as em element", () => {
    render(
      <ChangelogModal
        open={true}
        onClose={onClose}
        version="2.3.0"
        releaseNotes="This is *italic text*"
      />,
    );
    const em = document.querySelector("em");
    expect(em).toBeInTheDocument();
    expect(em?.textContent).toBe("italic text");
  });

  // UPD-01: markdown unordered list renders as <ul> with <li> items
  it("renders markdown unordered list as ul with li items", () => {
    render(
      <ChangelogModal
        open={true}
        onClose={onClose}
        version="2.3.0"
        releaseNotes={"- Item one\n- Item two\n- Item three"}
      />,
    );
    const list = document.querySelector("ul");
    expect(list).toBeInTheDocument();
    const items = document.querySelectorAll("ul li");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toBe("Item one");
    expect(items[1].textContent).toBe("Item two");
    expect(items[2].textContent).toBe("Item three");
  });

  // UPD-01: markdown ordered list renders as <ol> with <li> items
  it("renders markdown ordered list as ol with li items", () => {
    render(
      <ChangelogModal
        open={true}
        onClose={onClose}
        version="2.3.0"
        releaseNotes={"1. First\n2. Second"}
      />,
    );
    const list = document.querySelector("ol");
    expect(list).toBeInTheDocument();
    const items = document.querySelectorAll("ol li");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toBe("First");
    expect(items[1].textContent).toBe("Second");
  });

  // UPD-02: scroll container has overflow-y-auto class and maxHeight style
  it("scroll container has overflow-y-auto class and maxHeight style", () => {
    render(
      <ChangelogModal
        open={true}
        onClose={onClose}
        version="2.3.0"
        releaseNotes="Some content"
      />,
    );
    const scrollContainer = document.querySelector(".overflow-y-auto");
    expect(scrollContainer).toBeInTheDocument();
    expect((scrollContainer as HTMLElement).style.maxHeight).toBe("320px");
  });
});
