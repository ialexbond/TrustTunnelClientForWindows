import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { open } from "@tauri-apps/plugin-shell";
// The component's own source, as text — same `?raw` device as `UpdateCard.test.tsx`.
import footerLinksSource from "./FooterLinks.tsx?raw";
import ru from "../../shared/i18n/locales/ru.json";
import i18n from "../../shared/i18n";
import { FooterLinks } from "./FooterLinks";
import { renderWithProviders as render } from "../../test/test-utils";

const REPOSITORY_URL = "https://github.com/ialexbond/TrustTunnelClient";
const WELCOME_TOUR_EVENT = "tt-show-welcome-tour";

describe("FooterLinks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("рисует три пункта в один ряд, а точки-разделители скрыты от диктора", () => {
    const { container } = render(<FooterLinks />);

    // Three ITEMS on the row, but only TWO of them are controls — the copyright is a static
    // line (D-30-22). Asserting the split rather than a single count is what keeps a future
    // edit from quietly promoting the copyright back to a handler-less button.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(
      screen.getByText(
        ru.about.copyright.replace("{{year}}", String(new Date().getFullYear())),
      ),
    ).toBeInTheDocument();

    // The separators are decoration: assistive technology must not read a middle dot
    // as if it were content between the items.
    const separators = container.querySelectorAll('[aria-hidden="true"]');
    expect(separators.length).toBeGreaterThanOrEqual(2);
    Array.from(container.querySelectorAll("span"))
      .filter((span) => span.textContent === "·")
      .forEach((dot) => expect(dot).toHaveAttribute("aria-hidden", "true"));
  });

  it("до обоих настоящих пунктов доходит Tab, а копирайт остановки не занимает", async () => {
    const user = userEvent.setup();
    render(<FooterLinks />);

    const items = screen.getAllByRole("button");

    await user.tab();
    expect(items[0]).toHaveFocus();
    await user.tab();
    expect(items[1]).toHaveFocus();

    // A THIRD Tab must leave the row entirely. The copyright used to be a handler-less
    // `<button>`, so Tab landed on it and Enter did nothing — the row promised a third
    // action it did not have. Nothing focusable may remain behind the two real controls.
    await user.tab();
    expect(items[0]).not.toHaveFocus();
    expect(items[1]).not.toHaveFocus();
  });

  it("копирайт — обычный текст: ни кнопки, ни ссылки, ни кольца фокуса", () => {
    render(<FooterLinks />);

    const copyright = screen.getByText(
      ru.about.copyright.replace("{{year}}", String(new Date().getFullYear())),
    );

    // A control that announces itself pressable and does nothing is a defect, and for a
    // keyboard user it is the worse of the two failures — it reads as the application being
    // broken rather than as a line of text. So: plain element, no tabindex, no ring.
    expect(copyright.tagName).toBe("SPAN");
    expect(copyright.closest("button")).toBeNull();
    expect(copyright.closest("a")).toBeNull();
    expect(copyright).not.toHaveAttribute("tabindex");
    expect(copyright.className).not.toContain("focus-visible:shadow-[var(--focus-ring)]");
  });

  it("у пункта репозитория есть имя, которое говорит куда он ведёт и что уводит из окна", () => {
    render(<FooterLinks />);

    // The visible label is a bare product name, so the accessible name has to carry both
    // facts: WHERE it goes and THAT it leaves the application window.
    const repository = screen.getByRole("button", { name: ru.about.github_aria });
    expect(repository).toHaveTextContent("GitHub");
  });

  it("нажатие на пункт репозитория отдаёт адрес системному браузеру и не уводит окно", async () => {
    const user = userEvent.setup();
    render(<FooterLinks />);

    await user.click(screen.getByRole("button", { name: ru.about.github_aria }));

    expect(vi.mocked(open)).toHaveBeenCalledWith(REPOSITORY_URL);
    // Nothing in the row could navigate the window even in principle: this design
    // introduces no in-app link style, so there is no anchor here at all.
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(footerLinksSource).not.toMatch(/<a[\s>]/);
  });

  it("нажатие на пункт тура посылает окну событие приветственного тура", async () => {
    const user = userEvent.setup();
    const onTour = vi.fn();
    window.addEventListener(WELCOME_TOUR_EVENT, onTour);

    render(<FooterLinks />);
    await user.click(screen.getByRole("button", { name: ru.about.show_welcome_tour }));

    expect(onTour).toHaveBeenCalledTimes(1);
    window.removeEventListener(WELCOME_TOUR_EVENT, onTour);
  });

  it("год в копирайте вычисляется, а не вписан руками", () => {
    render(<FooterLinks />);

    const expected = ru.about.copyright.replace(
      "{{year}}",
      String(new Date().getFullYear()),
    );
    expect(screen.getByText(expected)).toBeInTheDocument();

    // A year typed into the markup is wrong from the first of January and nobody is
    // watching for it, so the source may not contain one at all.
    expect(footerLinksSource).not.toMatch(/\b20[0-9]{2}\b/);
  });

  it("у каждого настоящего пункта есть кольцо фокуса при фокусе с клавиатуры", () => {
    render(<FooterLinks />);

    screen.getAllByRole("button").forEach((item) => {
      expect(item.className).toContain("focus-visible:shadow-[var(--focus-ring)]");
    });
  });

  it("story-only проп фокуса не переехал в боевой компонент", () => {
    // The demo drives focus through a `focusedItem` prop so the showcase can render the
    // indicator deterministically. Production has no use for it and must not carry it.
    expect(footerLinksSource).not.toContain("focusedItem");
  });
});
