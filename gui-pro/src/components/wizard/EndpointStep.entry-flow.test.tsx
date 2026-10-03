import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { EndpointStep } from "./EndpointStep";
import { makeWizardState } from "./testHelpers";

/**
 * Characterization tests pinning the SHIPPED round-2 behavior (06-12, verify-only).
 *
 * These do NOT add or change feature code — D-06 (install-enters-on-Settings) and
 * D-07 (cert-type block colors) already landed in commits bd609e2e (flow + colors)
 * and 01dbaa32 (no false «Всё готово» flash). This file is a dedicated, separate
 * test file (NOT EndpointStep.test.tsx, which 06-08 owns in the same wave) so 06-12
 * has zero file overlap with 06-08 and no depends_on is needed.
 *
 * Purpose: guard the shipped entry-flow + cert-color contract against a silent
 * regression from the 06-09/10/11 advanced-settings edits that touch the SAME
 * EndpointStep component.
 */
describe("EndpointStep — D-06 entry-flow + D-07 cert-color characterization (verify-only)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  // Mirror EndpointStep.test.tsx's harness: isValidEmail must be a real function or
  // the component throws when it calls w.isValidEmail(...).
  const validEmailFn = (e: string) =>
    !e.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

  // ── D-06: install-enters-on-Settings back-button branch (EndpointStep.tsx:272-285) ──

  it("D-06 fresh install: back button reads «Выйти» (control.exit) and clicking it EXITS via onClose, never setWizardStep", () => {
    // Fresh install entry from the Control Panel «Установить»: installEntry=true, no
    // in-wizard server/«проверка» step preceded Settings, NOT cameFromFound, server
    // not installed → back EXITS the wizard (onClose), label is «Выйти».
    const onClose = vi.fn();
    const setWizardStep = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      installEntry: true,
      cameFromFound: false,
      serverInfo: null,
      onClose,
      setWizardStep,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    // The fresh-install back action reads «Выйти».
    const backBtn = screen.getByText(i18n.t("control.exit"));
    expect(backBtn).toBeInTheDocument();
    fireEvent.click(backBtn);
    expect(onClose).toHaveBeenCalled();
    expect(setWizardStep).not.toHaveBeenCalled();
  });

  it("D-06 reinstall via cameFromFound: back button reads «Назад» (buttons.back) and clicking it navigates to «found»", () => {
    const setWizardStep = vi.fn();
    const setCameFromFound = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      installEntry: true,
      cameFromFound: true,
      serverInfo: null,
      setWizardStep,
      setCameFromFound,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    const backBtn = screen.getByText(i18n.t("buttons.back"));
    expect(backBtn).toBeInTheDocument();
    fireEvent.click(backBtn);
    expect(setCameFromFound).toHaveBeenCalledWith(false);
    expect(setWizardStep).toHaveBeenCalledWith("found");
  });

  it("D-06 reinstall via serverInfo.installed: back button reads «Назад» and navigates to «found»", () => {
    const setWizardStep = vi.fn();
    const setCameFromFound = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      installEntry: true,
      cameFromFound: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serverInfo: { installed: true, users: [], version: "1.0", serviceActive: true, os: "linux" } as any,
      setWizardStep,
      setCameFromFound,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    const backBtn = screen.getByText(i18n.t("buttons.back"));
    expect(backBtn).toBeInTheDocument();
    fireEvent.click(backBtn);
    expect(setWizardStep).toHaveBeenCalledWith("found");
  });

  // ── D-07: cert-type block per-type selected-state colors (EndpointStep.tsx:89-136) ──
  //
  // The three cert cards are raw <button>s with ONLY a class ternary — they carry NO
  // aria-pressed/aria-selected/data-* hook. The honest characterization is therefore
  // the per-type SELECTED-STATE token CLASS string (LE success-tint / self-signed
  // warning-tint / custom text-muted+bg-active). We assert the class as a STRING, never
  // a computed hex. Do NOT add an aria/data hook to the cards — this plan is verify-only.

  it("D-07 click: each cert card calls setCertType with the right type", () => {
    const setCertType = vi.fn();
    const w = makeWizardState({
      step: "endpoint",
      setCertType,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);

    fireEvent.click(screen.getByText("Let's Encrypt"));
    expect(setCertType).toHaveBeenCalledWith("letsencrypt");

    fireEvent.click(screen.getByText(i18n.t("wizard.endpoint.self_signed")));
    expect(setCertType).toHaveBeenCalledWith("selfsigned");

    fireEvent.click(screen.getByText(i18n.t("wizard.endpoint.provided_cert")));
    expect(setCertType).toHaveBeenCalledWith("provided");
  });

  it("D-07 Let's Encrypt selected card carries the per-type GREEN (success-tint) token class", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "letsencrypt",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    // Pin the SHIPPED token-class contract (no aria hook exists on the cards; do not add one).
    const leCard = screen.getByText("Let's Encrypt").closest("button")!;
    expect(leCard.className).toContain("success-tint-40");
    expect(leCard.className).toContain("success-tint-08");
  });

  it("D-07 Self-signed selected card carries the per-type YELLOW (warning-tint) token class", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "selfsigned",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    // Pin the SHIPPED token-class contract (no aria hook exists on the cards; do not add one).
    const selfSignedCard = screen
      .getByText(i18n.t("wizard.endpoint.self_signed"))
      .closest("button")!;
    expect(selfSignedCard.className).toContain("warning-tint-40");
    expect(selfSignedCard.className).toContain("warning-tint-08");
  });

  it("D-07 Custom/provided selected card carries the per-type GRAY (text-muted/bg-active) neutral token class", () => {
    const w = makeWizardState({
      step: "endpoint",
      certType: "provided",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      isValidEmail: validEmailFn as any,
    });
    render(<EndpointStep {...w} />);
    // Pin the SHIPPED neutral token-class contract — custom is gray, NOT the brand
    // accent (user request: LE green / self-signed yellow / custom gray). No aria hook
    // exists on the cards; do not add one.
    const customCard = screen
      .getByText(i18n.t("wizard.endpoint.provided_cert"))
      .closest("button")!;
    expect(customCard.className).toContain("text-muted");
    expect(customCard.className).toContain("bg-active");
  });
});
