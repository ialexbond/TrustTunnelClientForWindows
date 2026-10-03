import { describe, it, expect } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { WindowControls } from "./WindowControls";

/**
 * G-32-16, paired symptom.
 *
 * The close button's highlight lives in React state, set on `onMouseEnter` and cleared on
 * `onMouseLeave`. Hiding the window to the tray moves no pointer, so no `mouseleave` is emitted and
 * the button stays lit — the highlight comes back with the window, over a webview the pointer has
 * never been in. Named in the comment on the old `tauri://blur` fix as «WindowControls hover-state
 * stuck», and reported again by the owner alongside the tooltip: «это не единственное место».
 *
 * Driven through DOM `blur`/`focus` on the webview, not `tauri://blur`: `getCurrentWindow()` throws
 * under vitest, so `appWindow` is null here and the component's old Tauri subscription returned
 * early before binding anything. That is why the stuck highlight was never covered by a test.
 */
describe("WindowControls — pointer presence (G-32-16)", () => {
  const close = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>(".window-control-close")!;

  const minimize = (container: HTMLElement) =>
    container.querySelectorAll<HTMLButtonElement>(".window-control-btn")[0];

  it("lights the close button while the pointer is on it", () => {
    const { container } = render(<WindowControls />);
    const btn = close(container);

    expect(btn.getAttribute("style")).toContain("transparent");
    fireEvent.mouseEnter(btn);
    expect(btn.getAttribute("style")).toContain("var(--color-destructive)");
  });

  it("does not keep the close highlight through a window hide and re-show", () => {
    const { container } = render(<WindowControls />);
    const btn = close(container);

    fireEvent.mouseEnter(btn);
    expect(btn.getAttribute("style")).toContain("var(--color-destructive)");

    // Tray click hides the window — no pointer movement, so no mouseleave.
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(btn.getAttribute("style")).not.toContain("var(--color-destructive)");

    // Tray icon brings it back. Still no pointer event of any kind.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(btn.getAttribute("style")).not.toContain("var(--color-destructive)");
  });

  it("drops the minimize highlight on the same sequence", () => {
    const { container } = render(<WindowControls />);
    const btn = minimize(container);

    fireEvent.mouseEnter(btn);
    expect(btn.getAttribute("style")).toContain("var(--color-bg-hover)");

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(btn.getAttribute("style")).not.toContain("var(--color-bg-hover)");
  });

  it("lights again when the pointer genuinely re-enters after the window returns", () => {
    const { container } = render(<WindowControls />);
    const btn = close(container);

    fireEvent.mouseEnter(btn);
    act(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(btn.getAttribute("style")).not.toContain("var(--color-destructive)");

    fireEvent.mouseEnter(btn);
    expect(btn.getAttribute("style")).toContain("var(--color-destructive)");
  });
});
