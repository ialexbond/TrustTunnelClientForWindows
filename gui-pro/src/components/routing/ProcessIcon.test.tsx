import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { ProcessIcon } from "./ProcessIcon";
import { resetProcessIconCache } from "./useProcessIcons";

// The Tauri bridge is mocked globally in src/test/setup.ts; each test drives the batch answer.
const invokeMock = vi.mocked(invoke);

describe("ProcessIcon", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
    invokeMock.mockReset();
    // The icon cache is module-level and app-session-lived, which means it also outlives a single
    // test: a name resolved (or left hanging on a never-settling promise) by one test would answer
    // — or suppress — the next test's request. Only this line was added; every assertion below is
    // exactly as it was written when the component fetched for itself.
    resetProcessIconCache();
  });

  it("shows a placeholder while the icon is still being resolved", () => {
    // A promise that never settles is the honest model of "the backend is still asking the shell".
    invokeMock.mockReturnValue(new Promise(() => {}));

    const { container } = render(<ProcessIcon name="chrome.exe" />);

    expect(
      container.querySelector('[data-process-icon="pending"]'),
    ).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("renders the resolved Windows icon as a PNG data URL", async () => {
    invokeMock.mockResolvedValue([
      { name: "chrome.exe", icon: "data:image/png;base64,iVBORw0KGgo=" },
    ]);

    const { container } = render(<ProcessIcon name="chrome.exe" />);

    await waitFor(() => {
      expect(
        container.querySelector('[data-process-icon="resolved"]'),
      ).toBeInTheDocument();
    });
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    // Decorative on purpose: the row prints the process name in text right next to the slot, so a
    // populated alt would make a screen reader announce the same program twice per row.
    expect(img?.getAttribute("alt")).toBe("");
  });

  it("falls back to the Lucide glyph when the backend reports no icon", async () => {
    // icon: null is what a protected, elevated or already-exited process yields — the D-03 trigger.
    invokeMock.mockResolvedValue([{ name: "msmpeng.exe", icon: null }]);

    const { container } = render(<ProcessIcon name="msmpeng.exe" />);

    const glyph = await screen.findByRole("img", { name: "Значок недоступен" });
    expect(glyph.tagName.toLowerCase()).toBe("svg");
    expect(
      container.querySelector('[data-process-icon="unavailable"]'),
    ).toBeInTheDocument();
    // Never a broken-image box: the fallback branch renders no <img> at all.
    expect(container.querySelector("img")).toBeNull();
  });

  it("falls back to the Lucide glyph when the icon batch itself fails", async () => {
    invokeMock.mockRejectedValue("snapshot failed");

    const { container } = render(<ProcessIcon name="typed-by-hand.exe" />);

    await waitFor(() => {
      expect(
        container.querySelector('[data-process-icon="unavailable"]'),
      ).toBeInTheDocument();
    });
  });

  it("keeps the slot geometry identical in every state so rows never reflow", async () => {
    invokeMock.mockResolvedValue([{ name: "code.exe", icon: null }]);

    const { container } = render(<ProcessIcon name="code.exe" size={24} />);

    const pendingSlot = container.querySelector("[data-process-icon]") as HTMLElement;
    expect(pendingSlot.style.width).toBe("24px");
    expect(pendingSlot.style.height).toBe("24px");

    await waitFor(() => {
      const settledSlot = container.querySelector(
        '[data-process-icon="unavailable"]',
      ) as HTMLElement;
      expect(settledSlot.style.width).toBe("24px");
      expect(settledSlot.style.height).toBe("24px");
    });
  });

  it("drops the muted plate once the real icon lands", async () => {
    // The plate is a stand-in, not a frame. Windows artwork carries its own transparent margin, so
    // the plate showed through it as a grey square the icon looked stuck onto (owner, 2026-08-26).
    // Asserted on the inline style because the plate IS an inline style — jsdom loads no Tailwind,
    // so a class assertion would prove nothing about what actually paints.
    invokeMock.mockResolvedValue([
      { name: "chrome.exe", icon: "data:image/png;base64,iVBORw0KGgo=" },
    ]);

    const { container } = render(<ProcessIcon name="chrome.exe" />);

    await waitFor(() => {
      const slot = container.querySelector<HTMLElement>('[data-process-icon="resolved"]');
      expect(slot?.style.backgroundColor).toBe("transparent");
    });
    const slot = container.querySelector<HTMLElement>('[data-process-icon="resolved"]');
    // The rounded clip travels with the plate: it shaved the corners off square Windows icons.
    expect(slot?.className).not.toContain("overflow-hidden");
    // …and so does the hairline. A real icon is not a slot waiting to be filled.
    expect(slot?.getAttribute("style")).not.toMatch(/border:\s*1px/);
  });

  it("keeps the plate under the fallback glyph — there it IS the placeholder", async () => {
    invokeMock.mockResolvedValue([{ name: "msmpeng.exe", icon: null }]);

    const { container } = render(<ProcessIcon name="msmpeng.exe" />);

    await waitFor(() => {
      const slot = container.querySelector<HTMLElement>('[data-process-icon="unavailable"]');
      expect(slot).not.toBeNull();
      expect(slot?.style.backgroundColor).not.toBe("transparent");
      expect(slot?.className).toContain("overflow-hidden");
      // The hairline is what keeps the slot visible on the saved list's striped rows, where the row
      // behind it is painted with the very token the plate is filled with. Without it the plate is
      // invisible on every other row and the glyph floats with no slot around it.
      expect(slot?.getAttribute("style")).toMatch(/border:\s*1px solid var\(--color-border\)/);
    });
  });

  it("asks the backend for names only — never for a filesystem path", async () => {
    invokeMock.mockResolvedValue([{ name: "chrome.exe", icon: null }]);

    render(<ProcessIcon name="chrome.exe" />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    // The command surface is deliberately name-keyed: a path argument would turn it into an
    // arbitrary-file icon-read primitive for anything running in the webview.
    expect(invokeMock).toHaveBeenCalledWith("get_process_icons", {
      names: ["chrome.exe"],
    });
  });
});
