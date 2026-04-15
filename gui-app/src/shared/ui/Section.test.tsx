import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Section, SectionHeader } from "./Section";

describe("Section", () => {
  it("renders children content", () => {
    render(
      <Section>
        <p>Section content</p>
      </Section>
    );
    expect(screen.getByText("Section content")).toBeInTheDocument();
  });

  it("renders title via SectionHeader when title prop provided", () => {
    render(
      <Section title="My Title">
        <p>content</p>
      </Section>
    );
    expect(screen.getByText("My Title")).toBeInTheDocument();
  });

  it("renders description when description prop provided", () => {
    render(
      <Section title="Title" description="Subtitle text">
        <p>content</p>
      </Section>
    );
    expect(screen.getByText("Subtitle text")).toBeInTheDocument();
  });

  it("collapsible section toggles content visibility on header click", () => {
    render(
      <Section title="Collapsible" collapsible defaultOpen>
        <p>Collapsible content</p>
      </Section>
    );
    expect(screen.getByText("Collapsible content")).toBeInTheDocument();

    const header = screen.getByRole("button");
    fireEvent.click(header);
    expect(screen.getByText("Collapsible content")).not.toBeVisible();
  });

  it("defaultOpen=false starts collapsed", () => {
    render(
      <Section title="Starts Closed" collapsible defaultOpen={false}>
        <p>Hidden content</p>
      </Section>
    );
    expect(screen.getByText("Hidden content")).not.toBeVisible();
  });

  it("renders action slot in SectionHeader", () => {
    render(
      <Section title="With Action" action={<button>Action btn</button>}>
        <p>content</p>
      </Section>
    );
    expect(screen.getByRole("button", { name: "Action btn" })).toBeInTheDocument();
  });
});
