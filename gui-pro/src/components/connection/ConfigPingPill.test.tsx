import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { renderWithProviders } from "../../test/test-utils";
import { ConfigPingPill } from "./ConfigPingPill";

// Resolve every string through i18n so the test is language-agnostic (jsdom defaults to
// en-US): «N ms» numeric / «Unreachable»~«Недоступен» / «—» no-data / «Measuring…».
const L = {
  unit: i18n.t("connection.ping.unit"),
  unreachable: i18n.t("connection.ping.unreachable"),
  no_data: i18n.t("connection.ping.no_data"),
  measuring: i18n.t("connection.ping.measuring"),
};

describe("ConfigPingPill", () => {
  // Truth (D-16 numeric bands): green ≤150ms renders «N ms» in a SUCCESS badge.
  it("green band renders «N ms» as a success badge", () => {
    renderWithProviders(<ConfigPingPill ping={{ band: "green", valueMs: 42 }} />);
    const label = screen.getByText(`42 ${L.unit}`);
    const badge = label.closest("[data-variant]");
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute("data-variant", "success");
  });

  // Truth: yellow band (151–300ms) renders «N ms» in a WARNING badge.
  it("yellow band renders «N ms» as a warning badge", () => {
    renderWithProviders(<ConfigPingPill ping={{ band: "yellow", valueMs: 220 }} />);
    const label = screen.getByText(`220 ${L.unit}`);
    const badge = label.closest("[data-variant]");
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute("data-variant", "warning");
  });

  // Truth: red band (>300ms) renders «N ms» in a DANGER badge.
  it("red band renders «N ms» as a danger badge", () => {
    renderWithProviders(<ConfigPingPill ping={{ band: "red", valueMs: 410 }} />);
    const label = screen.getByText(`410 ${L.unit}`);
    const badge = label.closest("[data-variant]");
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute("data-variant", "danger");
  });

  // Truth: the timeout/unreachable state renders the WORD «Недоступен» (NOT a number) in a
  // danger badge — the D-16 distinction between "slow" and "no answer".
  it("timeout band renders «Недоступен» as a danger badge, never a number", () => {
    renderWithProviders(<ConfigPingPill ping={{ band: "timeout" }} />);
    const label = screen.getByText(L.unreachable);
    const badge = label.closest("[data-variant]");
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute("data-variant", "danger");
    // It is a word, not «N ms».
    expect(screen.queryByText(new RegExp(`\\d+\\s*${L.unit}`))).not.toBeInTheDocument();
  });

  // Truth: the measuring (first-ever probe) state announces itself via role="status" with
  // the «Измерение…» accessible label and shows NO text — the loader is a decorative skeleton.
  it("measuring band is a role=status loader with no text", () => {
    renderWithProviders(<ConfigPingPill ping={{ band: "measuring" }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-label", L.measuring);
    expect(status.textContent?.trim()).toBe("");
    // No numeric / unreachable value while in flight.
    expect(screen.queryByText(L.unreachable)).not.toBeInTheDocument();
  });

  // Truth: a re-measure of an already-known config (measuring:true + a prior valueMs) keeps
  // the same role=status «Измерение…» loader. It reserves the prior value's width with an
  // INVISIBLE, aria-hidden copy — so the value is not announced, and the only accessible
  // name is «Измерение…» (the screen reader hears the probe in flight, not a stale number).
  it("re-measuring a known band stays a role=status loader, prior value aria-hidden", () => {
    renderWithProviders(<ConfigPingPill ping={{ band: "green", valueMs: 88, measuring: true }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-label", L.measuring);
    // The reserved «88 ms» copy is hidden from assistive tech (width-reservation only).
    const reserved = screen.getByText(`88 ${L.unit}`);
    expect(reserved).toHaveAttribute("aria-hidden", "true");
    // The numeric value is NOT exposed as an accessible name on the loader.
    expect(screen.queryByRole("status", { name: `88 ${L.unit}` })).not.toBeInTheDocument();
  });

  // Truth: the no-data state renders the neutral «—» (NEVER red) — a neutral badge carrying
  // a StatusIndicator dot to read as "no signal", not an error.
  it("no-data band renders the neutral «—», never red", () => {
    renderWithProviders(<ConfigPingPill ping={{ band: "no-data" }} />);
    const dash = screen.getByText(L.no_data);
    const badge = dash.closest("[data-variant]");
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute("data-variant", "neutral");
    expect(badge).not.toHaveAttribute("data-variant", "danger");
    // The "no signal" dot is present (StatusIndicator → role="img").
    expect(screen.getByRole("img")).toBeInTheDocument();
  });
});
