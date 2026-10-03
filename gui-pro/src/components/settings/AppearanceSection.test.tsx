import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import i18n from "../../shared/i18n";
import { AppearanceSection } from "./AppearanceSection";

/**
 * Phase 28 (28-06): the section moved from two `Select` dropdowns to two `SegmentedControl`
 * radiogroups. The assertions below were MIGRATED rather than duplicated — every case that used to
 * open a dropdown and click an option now picks a radio, so there is one set of expectations for
 * this section, not an old set and a new set disagreeing about what it renders.
 */
describe("AppearanceSection", () => {
  const defaultProps = {
    theme: "system" as const,
    onThemeChange: vi.fn(),
    language: "ru",
    onLanguageChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  const themeGroup = () => screen.getByRole("radiogroup", { name: "Тема оформления" });
  const languageGroup = () => screen.getByRole("radiogroup", { name: "Язык интерфейса" });

  // 27 D-13: the section is «Внешний вид» everywhere, INCLUDING the visible title. Only the VALUE
  // of settings.app.appearance_title changed (it held «Оформление»); the key is untouched, so the
  // i18n dead-key gate is unaffected.
  it("renders the section title «Внешний вид»", () => {
    render(<AppearanceSection {...defaultProps} />);
    expect(screen.getByText("Внешний вид")).toBeInTheDocument();
    expect(screen.queryByText("Оформление")).not.toBeInTheDocument();
  });

  // Every other row on the tab carries a description under its label; these two were the only ones
  // with a bare label. Each caption is asserted for the FACT it carries, not for its exact wording:
  // «Системная» tracking Windows, and the language applying without a restart.
  it("gives both rows a description under the label", () => {
    render(<AppearanceSection {...defaultProps} />);
    expect(screen.getByText(/«Системная».*Windows/)).toBeInTheDocument();
    expect(screen.getByText(/Меняется сразу/)).toBeInTheDocument();
  });

  it("renders the theme row as a radiogroup of three named options", () => {
    render(<AppearanceSection {...defaultProps} />);
    const options = within(themeGroup()).getAllByRole("radio");
    expect(options.map((option) => option.textContent)).toEqual([
      "Системная",
      "Тёмная",
      "Светлая",
    ]);
  });

  it("renders the language row as a radiogroup of two named options", () => {
    render(<AppearanceSection {...defaultProps} />);
    const options = within(languageGroup()).getAllByRole("radio");
    expect(options.map((option) => option.textContent)).toEqual(["Русский", "English"]);
  });

  it("marks the current theme and the current language as the checked options", () => {
    render(<AppearanceSection {...defaultProps} />);
    expect(within(themeGroup()).getByRole("radio", { name: "Системная" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(within(languageGroup()).getByRole("radio", { name: "Русский" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("calls onThemeChange exactly once with the chosen theme", () => {
    render(<AppearanceSection {...defaultProps} />);
    fireEvent.click(within(themeGroup()).getByRole("radio", { name: "Тёмная" }));
    expect(defaultProps.onThemeChange).toHaveBeenCalledTimes(1);
    expect(defaultProps.onThemeChange).toHaveBeenCalledWith("dark");
  });

  it("calls onLanguageChange exactly once with the chosen language", () => {
    render(<AppearanceSection {...defaultProps} />);
    fireEvent.click(within(languageGroup()).getByRole("radio", { name: "English" }));
    expect(defaultProps.onLanguageChange).toHaveBeenCalledTimes(1);
    expect(defaultProps.onLanguageChange).toHaveBeenCalledWith("en");
  });

  it("moves the theme selection with →, so the keyboard is not limited to clicking", () => {
    render(<AppearanceSection {...defaultProps} />);
    fireEvent.keyDown(within(themeGroup()).getByRole("radio", { name: "Системная" }), {
      key: "ArrowRight",
    });
    expect(defaultProps.onThemeChange).toHaveBeenCalledWith("dark");
  });

  // The tab confirms every change with «Настройки сохранены», and that confirmation is wired to
  // these callbacks — so a no-op press must report nothing, or the app announces a save that never
  // happened.
  it("reports nothing when the already-selected theme is chosen again", () => {
    render(<AppearanceSection {...defaultProps} />);
    fireEvent.click(within(themeGroup()).getByRole("radio", { name: "Системная" }));
    expect(defaultProps.onThemeChange).not.toHaveBeenCalled();
  });

  it("reports nothing when the already-selected language is chosen again", () => {
    render(<AppearanceSection {...defaultProps} />);
    fireEvent.click(within(languageGroup()).getByRole("radio", { name: "Русский" }));
    expect(defaultProps.onLanguageChange).not.toHaveBeenCalled();
  });

  // The negative half of the migration: the two dropdowns are gone, and the five options they used
  // to hide are all on screen at once.
  it("has no dropdown left — both choices are radiogroups with every option visible", () => {
    render(<AppearanceSection {...defaultProps} />);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getAllByRole("radiogroup")).toHaveLength(2);
    expect(screen.getAllByRole("radio")).toHaveLength(5);
  });

  // A flag names a country, not a language; and the names themselves are written each in its own
  // language rather than translated, so they read the same whatever the interface language is.
  it("renders the language names untranslated and without a flag icon", () => {
    render(<AppearanceSection {...defaultProps} />);
    expect(languageGroup().querySelectorAll("svg")).toHaveLength(0);

    i18n.changeLanguage("en");
    render(<AppearanceSection {...defaultProps} />);
    const groups = screen.getAllByRole("radiogroup", { name: "Language" });
    expect(within(groups[0]).getAllByRole("radio").map((o) => o.textContent)).toEqual([
      "Русский",
      "English",
    ]);
  });

  // Both values apply in place: nothing is sent anywhere, so there is nothing to wait for and
  // nothing that can fail. The absence of those two states is a property of the section, not a gap.
  it("renders no loading and no error state", () => {
    render(<AppearanceSection {...defaultProps} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
