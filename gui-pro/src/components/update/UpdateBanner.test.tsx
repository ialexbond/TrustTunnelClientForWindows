import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "../../shared/i18n";
import { UpdateBanner } from "./UpdateBanner";

describe("UpdateBanner", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
  });

  it("renders message и version (v3.0.1) на русском", () => {
    render(
      <UpdateBanner
        version="3.0.1"
        onUpdate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Доступно обновление протокола"),
    ).toBeVisible();

    const versionEl = screen.getByTestId("update-banner-version");
    expect(versionEl).toBeVisible();
    expect(versionEl).toHaveTextContent("v3.0.1");
  });

  it("calls onUpdate when «Обновить» button clicked", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const onDismiss = vi.fn();

    render(
      <UpdateBanner
        version="3.0.1"
        onUpdate={onUpdate}
        onDismiss={onDismiss}
      />,
    );

    await user.click(screen.getByTestId("update-banner-update"));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("calls onDismiss when X button clicked", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn();
    const onDismiss = vi.fn();

    render(
      <UpdateBanner
        version="3.0.1"
        onUpdate={onUpdate}
        onDismiss={onDismiss}
      />,
    );

    await user.click(screen.getByTestId("update-banner-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("имеет правильные ARIA атрибуты (role=region + aria-label банера)", () => {
    render(
      <UpdateBanner
        version="3.0.1"
        onUpdate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const banner = screen.getByTestId("update-banner");
    expect(banner).toHaveAttribute("role", "region");
    expect(banner).toHaveAttribute(
      "aria-label",
      "Уведомление об обновлении",
    );
  });

  it("dismiss кнопка имеет aria-label «Закрыть» (RU)", () => {
    render(
      <UpdateBanner
        version="3.0.1"
        onUpdate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const dismissBtn = screen.getByTestId("update-banner-dismiss");
    expect(dismissBtn).toHaveAttribute("aria-label", "Закрыть");
  });

  it("отображает version в mono font (text-mono-sm class)", () => {
    render(
      <UpdateBanner
        version="3.0.1"
        onUpdate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const versionEl = screen.getByTestId("update-banner-version");
    expect(versionEl.className).toMatch(/text-mono-sm/);
    // Verify it's a <code> element (semantic mono)
    expect(versionEl.tagName).toBe("CODE");
  });

  it("switches to English when i18n.changeLanguage('en')", async () => {
    await i18n.changeLanguage("en");

    render(
      <UpdateBanner
        version="3.0.1"
        onUpdate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    expect(screen.getByText("Protocol update available")).toBeVisible();
    expect(screen.getByTestId("update-banner-update")).toHaveTextContent(
      "Update",
    );

    const banner = screen.getByTestId("update-banner");
    expect(banner).toHaveAttribute("aria-label", "Update notification");

    const dismissBtn = screen.getByTestId("update-banner-dismiss");
    expect(dismissBtn).toHaveAttribute("aria-label", "Dismiss");
  });

  it("handles long version (3.0.1-beta.99-rc.45) без crashe", () => {
    render(
      <UpdateBanner
        version="3.0.1-beta.99-rc.45"
        onUpdate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const versionEl = screen.getByTestId("update-banner-version");
    expect(versionEl).toHaveTextContent("v3.0.1-beta.99-rc.45");
  });

  it("uses CSS tokens для colors (no hardcoded hex)", () => {
    render(
      <UpdateBanner
        version="3.0.1"
        onUpdate={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    const banner = screen.getByTestId("update-banner");
    const style = banner.getAttribute("style") || "";
    // Verify CSS variables are used, not hardcoded hex
    expect(style).toMatch(/var\(--color-status-info/);
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,6}/);
  });
});
