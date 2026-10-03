import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
// The component's own source, as text. Vite's `?raw` suffix rather than `node:fs`:
// @types/node is not in this package's tsconfig, and `?raw` resolves the path at
// transform time so the assertions below do not depend on the runner's cwd.
// (Same device as `UpdateCard.test.tsx` — see its header.)
import aboutHeroSource from "./AboutHero.tsx?raw";
import { AboutHero } from "./AboutHero";
import { renderWithProviders as render } from "../../test/test-utils";

const VERSION = "3.0.0";
const BUILD_HASH = "a3f9k2";

describe("AboutHero", () => {
  // ─── The build label, present and absent (ABOUT-01 / T-30-21) ───

  it("с вшитой меткой сборки ярлык показывает версию и метку одной строкой", () => {
    render(<AboutHero version={VERSION} buildHash={BUILD_HASH} />);

    const chip = screen.getByText(`v${VERSION}-${BUILD_HASH}`);
    expect(chip).toBeInTheDocument();
    // One node, one line: the version and the label are not split across two elements,
    // because a tester reads the whole string off the screen in one glance.
    expect(chip.textContent).toBe(`v${VERSION}-${BUILD_HASH}`);
  });

  it("без метки сборки ярлык показывает голый номер версии, и в блоке больше ничего не меняется", () => {
    const { container } = render(<AboutHero version={VERSION} buildHash="" />);

    expect(screen.getByText(`v${VERSION}`)).toBeInTheDocument();
    // No dangling separator: `v3.0.0-` would be a label that looks truncated.
    expect(screen.queryByText(`v${VERSION}-`)).toBeNull();

    // The rest of the band is identical to the labelled state.
    expect(screen.getByRole("heading")).toHaveTextContent("TrustTunnelPRO");
    expect(container.querySelectorAll("img")).toHaveLength(2);
  });

  // ─── The label may not be weakened (T-30-21 prohibition) ───

  it("ярлык не кнопка, не ссылка и не несёт копирования", () => {
    render(<AboutHero version={VERSION} buildHash={BUILD_HASH} />);

    const chip = screen.getByText(`v${VERSION}-${BUILD_HASH}`);
    expect(chip.tagName).toBe("SPAN");
    expect(chip.closest("button")).toBeNull();
    expect(chip.closest("a")).toBeNull();
    // Nothing in the band is pressable at all — no copy control, no disclosure.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    // No hover-gated reveal: the label is not a tooltip's payload.
    expect(chip).not.toHaveAttribute("title");
  });

  it("ярлык не переносится: он держится в одну строку на самой узкой ширине окна", () => {
    render(<AboutHero version={VERSION} buildHash={BUILD_HASH} />);

    const chip = screen.getByText(`v${VERSION}-${BUILD_HASH}`);
    expect(chip.className).toContain("whitespace-nowrap");
    // Monospaced, so the label can be compared character by character.
    expect(chip.className).toContain("font-mono");
  });

  // ─── The wordmark ───

  it("название и бейдж PRO складываются в один заголовок", () => {
    render(<AboutHero version={VERSION} buildHash={BUILD_HASH} />);

    const headings = screen.getAllByRole("heading");
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("TrustTunnelPRO");
  });

  it("логотип нельзя перетащить мышью", () => {
    const { container } = render(<AboutHero version={VERSION} buildHash={BUILD_HASH} />);

    const logos = container.querySelectorAll("img");
    expect(logos).toHaveLength(2);
    logos.forEach((logo) => expect(logo).toHaveAttribute("draggable", "false"));
  });

  // ─── The contrast rule phase 29 paid for (T-30-24) ───
  //
  // Asserted on the SOURCE as well as on the render: the token is applied through an
  // inline style, and jsdom does not resolve CSS custom properties, so a render case
  // alone could not tell `--color-text-secondary` from `--color-text-muted`.

  // ─── Шапка — полоса, а не карточка (G-30-17a) ───
  //
  // Спека экрана требует «полоса во всю ширину, А НЕ КАРТОЧКА… читается как шапка экрана, а не
  // как ещё один блок в общем столбце», и формулирует принцип на подвале: блок легче карточки
  // обновления не берёт её оболочку. Шапка приехала в продакшн ровно с оболочкой карточки —
  // радиус, обводка и `bg-elevated`, — и в столбце читалась третьей карточкой; нашёл владелец в
  // приёмке. Правка снимает три класса, поэтому её так же дёшево отменить: без этого теста
  // возврат подложки одной строкой оставил бы весь набор зелёным.
  //
  // Проверяем КОНТЕЙНЕР, а не текст файла: вставка «вайб-кодинга» в соседней карточке законно
  // стоит на своей подложке, и запрет `bg-` по исходнику ловил бы чужое.

  it("контейнер шапки не носит оболочку карточки: ни подложки, ни обводки, ни скругления", () => {
    const { container } = render(<AboutHero version={VERSION} buildHash={BUILD_HASH} />);

    const hero = container.firstElementChild as HTMLElement;
    expect(hero).toBeTruthy();
    // Ищем по подстроке класса, а не по вычисленному стилю: jsdom не собирает Tailwind, так что
    // `getComputedStyle` здесь вернул бы пусто и тест был бы вечнозелёным.
    expect(hero.className).not.toMatch(/\bborder\b/);
    expect(hero.className).not.toMatch(/\bbg-/);
    expect(hero.className).not.toMatch(/\brounded/);
  });

  it("воздух у шапки сохранён — отступы, а не оболочка, отделяют её от карточек", () => {
    const { container } = render(<AboutHero version={VERSION} buildHash={BUILD_HASH} />);

    // Оболочку сняли, но блок обязан остаться просторнее карточек под ним — иначе «полоса»
    // превращается в прижатый к соседям кусок текста, и следующая правка вернёт подложку,
    // чтобы «вернуть воздух».
    const hero = container.firstElementChild as HTMLElement;
    expect(hero.className).toContain("px-[var(--space-5)]");
    expect(hero.className).toContain("py-[var(--space-7)]");
  });

  it("ярлык окрашен вторичным токеном текста, а не приглушённым", () => {
    render(<AboutHero version={VERSION} buildHash={BUILD_HASH} />);

    const chip = screen.getByText(`v${VERSION}-${BUILD_HASH}`);
    expect(chip.getAttribute("style")).toContain("var(--color-text-secondary)");

    expect(aboutHeroSource).not.toContain("color-text-muted");
  });

  it("измеренные значения контраста остались в комментарии рядом с ярлыком", () => {
    // Phase 29 measured both candidates on the rendered story. Without the numbers the
    // next reader has no way to know the token choice was deliberate, and the cheapest
    // «cleanup» is to dim the label back to muted.
    expect(aboutHeroSource).toContain("4.16");
    expect(aboutHeroSource).toContain("4.42");
    expect(aboutHeroSource).toContain("5.10");
    expect(aboutHeroSource).toContain("5.31");
  });

  // ─── Контраст бейджа PRO ───
  //
  // Бейдж уехал в продакшн с --color-accent-interactive и провалил WCAG AA в обеих темах:
  // 4.11:1 в тёмной и 3.58:1 в светлой при пороге 4.5:1 (11px bold — это НЕ «крупный текст»
  // по WCAG, послабление до 3:1 к нему не применяется). Измерено в живом Storybook с
  // отключёнными переходами. С --color-accent-on-tint стало 6.21 / 4.98.
  //
  // Проверяем на САМОМ элементе, а не на тексте файла: слово «Tunnel» в названии законно
  // красится тем же --color-accent-interactive, поэтому запрет по всему исходнику был бы
  // ложным срабатыванием и сломал бы вордмарк.

  it("бейдж PRO окрашен токеном для текста на тинте, а не интерактивным акцентом", () => {
    render(<AboutHero version={VERSION} buildHash={BUILD_HASH} />);

    const badge = screen.getByText("PRO");
    expect(badge.getAttribute("style")).toContain("var(--color-accent-on-tint)");
    // Именно этот токен провалил контраст — он не должен вернуться на бейдж.
    expect(badge.getAttribute("style")).not.toContain("var(--color-accent-interactive)");
    // Подложка остаётся тинтом: чинили текст, а не фон.
    expect(badge.getAttribute("style")).toContain("var(--color-accent-tint-10)");
  });

  it("вордмарк по-прежнему использует интерактивный акцент — правка бейджа его не задела", () => {
    render(<AboutHero version={VERSION} buildHash={BUILD_HASH} />);

    // Страховка от «починки» слишком широким мазком: «Tunnel» сидит на обычной подложке,
    // а не на тинте, и его цвет менять не требовалось.
    const tunnel = screen.getByText("Tunnel");
    expect(tunnel.getAttribute("style")).toContain("var(--color-accent-interactive)");
  });

  it("измеренный контраст бейджа остался в комментарии рядом с ним", () => {
    // Тот же приём, что и для ярлыка сборки: без цифр следующий читатель не отличит
    // выбранный токен от случайного и вернёт бейджу яркий акцент.
    expect(aboutHeroSource).toContain("4.11");
    expect(aboutHeroSource).toContain("3.58");
    expect(aboutHeroSource).toContain("6.21");
    expect(aboutHeroSource).toContain("4.98");
  });

  it("в исходнике нет ни одного захваченного значения цвета", () => {
    expect(aboutHeroSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });
});
