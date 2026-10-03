import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
// The component's own source, as text — same `?raw` device as `UpdateCard.test.tsx`.
import appInfoCardSource from "./AppInfoCard.tsx?raw";
// The Russian bundle is read as DATA, not repeated as literals. That is the whole point of the two
// byte-identity cases below: if someone rewords either product claim in the bundle, the suite must
// go red rather than pass quietly against a copy of the old wording frozen into the test.
import ru from "../../shared/i18n/locales/ru.json";
import i18n from "../../shared/i18n";
import { AppInfoCard } from "./AppInfoCard";
// «Настройки» rendered for real, as the REFERENCE the About tab must match. Comparing against the
// other tab rather than against a copy of PanelHeader's current class list is the point: if the
// shared treatment is ever restyled, both tabs move together and this test stays green — it fails
// only when they DIVERGE, which is the actual defect (G-30-17b).
import { SettingsCard } from "../../shared/ui/SettingsCard";
import { renderWithProviders as render } from "../../test/test-utils";

/** The section-glyph chip a header renders: the only `aria-hidden` span in that header. */
function headerChip(root: HTMLElement): HTMLElement {
  const chip = root.querySelector('span[aria-hidden="true"]');
  if (!chip) throw new Error("section header chip not found");
  return chip as HTMLElement;
}

describe("AppInfoCard", () => {
  beforeEach(() => {
    i18n.changeLanguage("ru");
  });

  // ─── Заголовок секции — тот же, что в «Настройках» (G-30-17b) ───
  //
  // Вкладка приехала в продакшн на `CardHeader`, который рисует значок ГОЛЫМ, тогда как
  // «Настройки» и «Маршрутизация» давно на `PanelHeader` с тинтованным чипом 28 px. Владелец
  // заметил расхождение глазами — и это была ПОВТОРНАЯ жалоба, поэтому тест сравнивает две
  // вкладки между собой: пока они рендерят один компонент, он зелёный; разойдутся — красный.

  it("заголовок карточки рисует значок в чипе — ровно как карточка «Настроек»", () => {
    const about = render(<AppInfoCard />);
    const aboutChip = headerChip(about.container);

    const settings = render(
      <SettingsCard icon={<svg />} title="Оформление">
        <div />
      </SettingsCard>,
    );
    const settingsChip = headerChip(settings.container);

    expect(aboutChip.className).toBe(settingsChip.className);
    // И это действительно чип, а не пустая обёртка вокруг голого глифа: 28 px в обе стороны.
    expect(aboutChip.className).toContain("h-7");
    expect(aboutChip.className).toContain("w-7");
  });

  it("исходник карточки не тянет старый заголовок с голым значком", () => {
    // Парный к тесту выше и намеренно грубый: сравнение классов пройдёт и в том случае, если
    // кто-то скопирует разметку чипа руками вместо общего компонента — а копия и есть то, из-за
    // чего вкладки разъезжаются.
    expect(appInfoCardSource).toContain("PanelHeader");
    expect(appInfoCardSource).not.toMatch(/<CardHeader/);
  });

  it("рисует одну карточку: заголовок, абзац описания и утопленную вставку", () => {
    const { container } = render(<AppInfoCard />);

    expect(
      screen.getByRole("heading", { name: ru.about.app_info_title }),
    ).toBeInTheDocument();
    expect(screen.getByText(ru.about.description)).toBeInTheDocument();
    expect(screen.getByText(ru.about.vibe_coding)).toBeInTheDocument();

    // The note is INSIDE the card, not beside it — one card, not two. The shared `Card`
    // is the only element on this surface carrying the large radius; the recessed inset
    // uses the medium one, so counting radius-lg counts cards.
    const cards = container.querySelectorAll('[class*="radius-lg"]');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toContainElement(screen.getByText(ru.about.vibe_coding));
  });

  // ─── The two product claims reach the screen unreworded (T-30-25) ───

  it("текст описания совпадает со значением из ru.json посимвольно", () => {
    render(<AppInfoCard />);

    expect(screen.getByText(ru.about.description).textContent).toBe(ru.about.description);
  });

  it("текст пометки о вайб-кодинге совпадает со значением из ru.json посимвольно", () => {
    render(<AppInfoCard />);

    expect(screen.getByText(ru.about.vibe_coding).textContent).toBe(ru.about.vibe_coding);
  });

  // ─── The card does nothing ───

  it("в карточке нет ни одной кнопки и ни одного переключателя", () => {
    render(<AppInfoCard />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  // ─── The narrow window (about.md §«О приложении», state `narrow`) ───

  it("на самой узкой ширине вставка держит столбец со значком, а переносится абзац", () => {
    render(<AppInfoCard />);

    const note = screen.getByText(ru.about.vibe_coding);
    // `min-w-0 flex-1`: without it a long line squeezes the glyph out of its own column
    // instead of wrapping, and the heart ends up sitting on top of the text.
    expect(note.className).toContain("min-w-0");
    expect(note.className).toContain("flex-1");

    // The glyph never shrinks and never wraps into the paragraph. Selected as the note's own
    // preceding sibling rather than as «the first svg on the surface» — the first svg is the
    // card header's icon, and a query that loose would pass while the heart column was broken.
    const glyph = note.previousElementSibling;
    expect(glyph?.tagName.toLowerCase()).toBe("svg");
    expect(glyph?.getAttribute("class")).toContain("shrink-0");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
  });

  it("в исходнике нет ни одного захваченного значения цвета", () => {
    expect(appInfoCardSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });
});
