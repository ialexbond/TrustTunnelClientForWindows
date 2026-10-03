import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { FirstUserAdvanced } from "./FirstUserAdvanced";
import { DEFAULT_DEEPLINK, type DeeplinkFields } from "../server/useUserFormState";

function renderBlock(overrides: Partial<DeeplinkFields> = {}, updateField = vi.fn()) {
  const deeplink: DeeplinkFields = { ...DEFAULT_DEEPLINK, ...overrides };
  render(<FirstUserAdvanced deeplink={deeplink} updateField={updateField} />);
  return { updateField };
}

describe("FirstUserAdvanced", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  it("is COLLAPSED by default — the advanced composition is not rendered until expanded", () => {
    renderBlock();
    // The disclosure toggle is present...
    expect(
      screen.getByText(i18n.t("wizard.endpoint.first_user_advanced_label")),
    ).toBeInTheDocument();
    // ...but the section + banner are not rendered while collapsed.
    expect(
      screen.queryByText(i18n.t("wizard.endpoint.first_user_advanced_banner")),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(i18n.t("server.users.section_deeplink")),
    ).not.toBeInTheDocument();
  });

  it("renders the non-blocking optional banner with the exact D-11 RU copy when expanded", () => {
    renderBlock();
    fireEvent.click(screen.getByText(i18n.t("wizard.endpoint.first_user_advanced_label")));
    expect(
      screen.getByText(i18n.t("wizard.endpoint.first_user_advanced_banner")),
    ).toBeInTheDocument();
  });

  it("renders ONLY the 3 trimmed controls (anti-DPI / display name / DNS) when expanded (06-uat fix 3)", () => {
    renderBlock();
    fireEvent.click(screen.getByText(i18n.t("wizard.endpoint.first_user_advanced_label")));
    // The 3 controls that remain.
    expect(screen.getByText(i18n.t("server.users.toggle_anti_dpi"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.users.field_display_name"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("server.users.field_dns_upstreams"))).toBeInTheDocument();
  });

  it("does NOT render the removed controls (custom SNI / upstream / skip-verify / pin-cert / CIDR) — 06-uat fix 3", () => {
    renderBlock();
    fireEvent.click(screen.getByText(i18n.t("wizard.endpoint.first_user_advanced_label")));
    expect(screen.queryByText(i18n.t("server.users.field_custom_sni"))).not.toBeInTheDocument();
    expect(
      screen.queryByText(i18n.t("server.users.field_upstream_protocol")),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("server.users.toggle_skip_verify"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("server.users.toggle_pin_cert"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("server.users.cidr_label"))).not.toBeInTheDocument();
  });

  it("reflects the Users-tab DEFAULTS — anti-DPI is ON by default (C-04)", () => {
    renderBlock(); // DEFAULT_DEEPLINK → antiDpi: true
    fireEvent.click(screen.getByText(i18n.t("wizard.endpoint.first_user_advanced_label")));
    const antiDpiToggle = screen.getByRole("switch", {
      name: i18n.t("server.users.toggle_anti_dpi"),
    });
    expect(antiDpiToggle).toBeChecked();
  });

  it("anti-DPI OFF posture is reflected (updateField-driven, no silent default)", () => {
    renderBlock({ antiDpi: false });
    fireEvent.click(screen.getByText(i18n.t("wizard.endpoint.first_user_advanced_label")));
    const antiDpiToggle = screen.getByRole("switch", {
      name: i18n.t("server.users.toggle_anti_dpi"),
    });
    expect(antiDpiToggle).not.toBeChecked();
  });

  it("toggling a field calls updateField with the changed value", () => {
    const { updateField } = renderBlock();
    fireEvent.click(screen.getByText(i18n.t("wizard.endpoint.first_user_advanced_label")));
    const antiDpiToggle = screen.getByRole("switch", {
      name: i18n.t("server.users.toggle_anti_dpi"),
    });
    fireEvent.click(antiDpiToggle); // default ON → OFF
    expect(updateField).toHaveBeenCalledWith("antiDpi", false);
  });

  it("marks NO field required — no `*` marker inside the advanced block", () => {
    renderBlock();
    fireEvent.click(screen.getByText(i18n.t("wizard.endpoint.first_user_advanced_label")));
    // Every advanced field is optional (C-04) — the block must not introduce a `*`.
    expect(screen.queryByText("*")).not.toBeInTheDocument();
  });
});
