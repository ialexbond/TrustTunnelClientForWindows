import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { open } from "@tauri-apps/plugin-shell";
import i18n from "../shared/i18n";
import { ChangelogModal } from "./ChangelogModal";
import { parseReleaseNotes } from "../shared/utils/parseReleaseNotes";
// The window's own source and the package manifest, as text. Vite's `?raw` rather than `node:fs`:
// @types/node is not in this package's tsconfig, and `?raw` resolves the path at transform time so
// the assertions below do not depend on the runner's cwd. Same device as UpdateCard.test.tsx.
import changelogModalSource from "./ChangelogModal.tsx?raw";
import packageManifestSource from "../../package.json?raw";
import releaseNotesRaw from "../shared/release-notes/RELEASE_NOTES.ru.md?raw";

/**
 * Contract tests for the «Что нового» window.
 *
 * These are a REWRITE, not a patch of the previous file. Three of its assertions died with the
 * redesign and could not be carried over: the generic English close name (`aria-label="Close"`),
 * the fixed 320px maximum height on the scroll container, and the single `releaseNotes` string
 * prop. Each is now asserted against what the design actually specifies — a named close control,
 * a dedicated scroll column, and two independently-sourced sections.
 */

/** Заметки установленной версии — свой образец, чтобы разбор боевого файла не стал образцом. */
const INSTALLED_FIXTURE = `Приложение получило новый внешний вид.

- «Панель управления» собрана заново.
- Исправлено: выход из одного окна больше не разрывает соединение, поднятое другим.

Полный список — на [странице выпусков](https://example.test/releases).`;

/** Заметки вышедшей версии — то, что приезжает вместе с ответом проверки обновлений. */
const AVAILABLE_FIXTURE = `- Вкладка «О программе» переехала на новый вид.
- Заметки о выпуске открываются в любой момент.`;

/** Версия, которой в боевом файле заметок заведомо нет — образец состояния «показывать нечего». */
const VERSION_WITHOUT_A_SECTION = "9.9.9";

/** Версия, раздел для которой в боевом файле есть — образец «файл доехал до экрана». */
const VERSION_WITH_A_SECTION = "3.0.0";

function sectionKinds(): string[] {
  return Array.from(document.querySelectorAll("[data-notes-section]")).map(
    (el) => el.getAttribute("data-notes-section") ?? "",
  );
}

describe("ChangelogModal", () => {
  let onClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    onClose = vi.fn();
    // `restoreMocks` is on (vite.config.ts), so the module mock's resolved value has to be set
    // inside each test rather than once at module scope.
    vi.mocked(open).mockResolvedValue(undefined);
  });

  // ─── The four states of the window (about.md §«Что нового») ───

  it("окно закрыто — не рисуется ничего", () => {
    render(
      <ChangelogModal
        isOpen={false}
        onClose={onClose}
        installedVersion={VERSION_WITH_A_SECTION}
        installedNotes={INSTALLED_FIXTURE}
      />,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("about.notes_window_title"))).not.toBeInTheDocument();
  });

  it("обновления нет — одна порция, помеченная как установленная, под строкой версии", () => {
    render(
      <ChangelogModal
        isOpen
        onClose={onClose}
        installedVersion={VERSION_WITH_A_SECTION}
        installedNotes={INSTALLED_FIXTURE}
      />,
    );

    // Окно названо своим заголовком, а не подписью «диалог».
    expect(
      screen.getByRole("dialog", { name: i18n.t("about.notes_window_title") }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        i18n.t("about.notes_subtitle_installed", { version: VERSION_WITH_A_SECTION }),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: i18n.t("about.notes_version_heading", { version: VERSION_WITH_A_SECTION }),
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(i18n.t("about.notes_label_installed"))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("about.notes_label_new"))).not.toBeInTheDocument();
    expect(sectionKinds()).toEqual(["installed"]);
  });

  it("обновление найдено — две порции в одной колонке, новая версия первой", () => {
    render(
      <ChangelogModal
        isOpen
        onClose={onClose}
        installedVersion={VERSION_WITH_A_SECTION}
        installedNotes={INSTALLED_FIXTURE}
        availableVersion="3.1.0"
        availableNotes={AVAILABLE_FIXTURE}
      />,
    );

    // ПОРЯДОК — часть договора: сначала то, что вышло, потом то, что стоит. Проверяется списком в
    // порядке обхода документа, а не двумя независимыми «есть/есть».
    expect(sectionKinds()).toEqual(["new", "installed"]);
    expect(screen.getByText(i18n.t("about.notes_label_new"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("about.notes_label_installed"))).toBeInTheDocument();
    expect(
      screen.getByText(
        i18n.t("about.notes_subtitle_with_update", {
          installed: VERSION_WITH_A_SECTION,
          available: "3.1.0",
        }),
      ),
    ).toBeInTheDocument();
    // Вкладок внутри окна нет: обе порции идут одной колонкой.
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("раздела для версии в файле нет — спокойная плитка, а не пустой раздел под заголовком", () => {
    // installedNotes НЕ передаётся: окно достаёт порцию само, и для этой версии в боевом файле
    // раздела нет. Так проверяется вся цепочка «файл → разбор → экран», а не только отрисовка.
    render(
      <ChangelogModal
        isOpen
        onClose={onClose}
        installedVersion={VERSION_WITHOUT_A_SECTION}
      />,
    );

    expect(screen.getByText(i18n.t("about.notes_none_title"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("about.notes_none_body"))).toBeInTheDocument();
    // Ни одной порции — то есть и заголовка версии с пустым телом под ним тоже нет.
    expect(sectionKinds()).toEqual([]);
    expect(
      screen.queryByRole("heading", {
        name: i18n.t("about.notes_version_heading", { version: VERSION_WITHOUT_A_SECTION }),
      }),
    ).not.toBeInTheDocument();
  });

  it("установленная порция приезжает из вложенного в сборку файла", () => {
    // Ключевая связь плана 30-02 → 30-04: текст, вкомпилированный в сборку, доходит до экрана без
    // сети и без обращения к диску. Ожидание считается из того же файла, а не переписано в тест —
    // иначе тест начал бы сторожить копию текста вместо самой связи.
    const body = parseReleaseNotes(releaseNotesRaw, VERSION_WITH_A_SECTION);
    expect(body, "в боевом файле должен быть раздел этой версии").not.toBeNull();
    const firstLine = (body ?? "").split("\n").find((line) => line.trim().length > 0) ?? "";
    expect(firstLine.length).toBeGreaterThan(20);

    const { container } = render(
      <ChangelogModal
        isOpen
        onClose={onClose}
        installedVersion={VERSION_WITH_A_SECTION}
      />,
    );

    expect(sectionKinds()).toEqual(["installed"]);
    expect(document.body.textContent ?? container.textContent ?? "").toContain(
      firstLine.slice(0, 40),
    );
  });

  // ─── The link rule (about.md §«Как показывается разметка», T-30-18) ───

  it("щелчок по ссылке уходит в системный браузер и НЕ уводит окно приложения", () => {
    render(
      <ChangelogModal
        isOpen
        onClose={onClose}
        installedVersion={VERSION_WITH_A_SECTION}
        installedNotes={INSTALLED_FIXTURE}
      />,
    );

    const link = screen.getByRole("link", { name: "странице выпусков" });
    // fireEvent возвращает false, когда обработчик отменил действие по умолчанию. Обе половины
    // правила проверяются вместе: ослабь любую — и этот случай покраснеет.
    const notCancelled = fireEvent.click(link);
    expect(notCancelled, "переход по умолчанию должен быть отменён").toBe(false);
    expect(open).toHaveBeenCalledWith("https://example.test/releases");
  });

  // ─── The close control (a11y) ───

  it("крестик находится по собственному имени, а не по общей английской подписи", () => {
    render(
      <ChangelogModal
        isOpen
        onClose={onClose}
        installedVersion={VERSION_WITH_A_SECTION}
        installedNotes={INSTALLED_FIXTURE}
      />,
    );

    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    const close = screen.getByRole("button", { name: i18n.t("about.notes_close_aria") });
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("нижнего ряда с кнопкой «Закрыть» в окне больше нет", () => {
    render(
      <ChangelogModal
        isOpen
        onClose={onClose}
        installedVersion={VERSION_WITH_A_SECTION}
        installedNotes={INSTALLED_FIXTURE}
      />,
    );

    // Единственная кнопка окна — крестик в шапке. Esc и щелчок мимо окна даёт общий примитив.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: i18n.t("buttons.close") })).not.toBeInTheDocument();
  });

  // ─── Scrolling (about.md: «двигается только колонка») ───

  it("длинные заметки прокручиваются внутри колонки, шапка с крестиком остаётся на месте", () => {
    const longNotes = Array.from({ length: 60 }, (_, i) => `- Пункт номер ${i + 1}`).join("\n");
    render(
      <ChangelogModal
        isOpen
        onClose={onClose}
        installedVersion={VERSION_WITH_A_SECTION}
        installedNotes={longNotes}
      />,
    );

    const column = document.querySelector("[data-notes-column]");
    expect(column).toBeTruthy();
    // Своя прокрутка и своя предельная высота — у колонки, а не у окна целиком.
    expect(column?.className).toContain("overflow-y-auto");
    expect(column?.className).toContain("max-h-[360px]");

    // Шапка ВНЕ прокручиваемой колонки: заголовок и крестик не могут уехать вместе с заметками.
    const close = screen.getByRole("button", { name: i18n.t("about.notes_close_aria") });
    const title = screen.getByRole("heading", { name: i18n.t("about.notes_window_title") });
    expect(column?.contains(close)).toBe(false);
    expect(column?.contains(title)).toBe(false);
    // …а сами заметки — внутри неё.
    expect(column?.textContent ?? "").toContain("Пункт номер 60");
  });

  // ─── The two load-bearing guarantees (T-30-16 / T-30-17) ───
  //
  // T-30-16 USED TO BE ASSERTED ONLY BY ABSENCE, on the reading that «with no raw-markup plugin
  // declared anywhere, the library does not execute embedded markup by construction». That reading
  // is correct TODAY — react-markdown escapes HTML by default — but it is a claim about a library
  // default, and the phase had already learned once (see T-30-17 below) that a default is not a
  // promise the app made. The suite would not have noticed if that default ever changed: both
  // assertions look at our source and at the manifest, and neither runs the markdown through the
  // renderer. So the behavioural test below was added and the two source/manifest assertions were
  // kept beside it — they now do what they are actually good at, which is naming the CAUSE the
  // moment the render test goes red.
  //
  // T-30-17 is the opposite and USED TO BE WRONG. It asserted that `notesComponents` has no `img:`
  // key and treated that absence as the protection. It is not. Rendering
  // `![x](https://example.com/evil.png)` through react-markdown@9 with `img` unmapped produces a
  // real `<img alt="x" src="https://example.com/evil.png">` — the library falls back to its own
  // default renderer, so the absence forbade nothing. The test passed while the property it claimed
  // to protect did not hold. It now exercises the behaviour instead: feed the window an image and
  // assert nothing renders. An absence assertion that never runs the code path is exactly the class
  // of defect this rewrite removes.

  it("T-30-17: картинка из чужого текста выпуска не рисуется", () => {
    const withImage = `Текст выпуска.

![вредонос](https://example.com/evil.png)

Ещё строка.`;

    const { container } = render(
      <ChangelogModal
        isOpen
        onClose={onClose}
        installedVersion={VERSION_WITH_A_SECTION}
        installedNotes={withImage}
      />,
    );

    // Ни одного узла изображения — значит окну неоткуда обратиться за внешним файлом. Это и есть
    // защита; политика содержимого приложения (`tauri.conf.json`, `img-src`) — второй рубеж, а не
    // единственный, и на неё этот тест намеренно не опирается.
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    // Остальной текст при этом на месте: правило гасит картинку, а не заметки целиком.
    expect(screen.getByText("Текст выпуска.")).toBeTruthy();
    expect(screen.getByText("Ещё строка.")).toBeTruthy();
  });

  it("T-30-17: у тега изображения есть ЯВНОЕ правило, а не отсутствие правила", () => {
    // Парный к предыдущему тест, и он нужен именно как страховка от отката: если кто-то уберёт
    // строку `img:` из набора, отрисовочный тест выше упадёт, а этот назовёт причину прямо.
    const source: string = changelogModalSource;
    const start = source.indexOf("const notesComponents = {");
    expect(start, "набор правил должен быть найден в исходнике").toBeGreaterThan(-1);
    const map = source.slice(start, source.indexOf("\n};", start));

    expect(
      /^\s*img\s*:\s*\(\s*\)\s*=>\s*null\s*,/m.test(map),
      "в наборе должно быть правило `img: () => null` — незаданный тег библиотека рисует сама",
    ).toBe(true);
  });

  it("T-30-16: исполняемая разметка из чужого текста выпуска приходит текстом, а не элементами", () => {
    // The behavioural half. Four shapes in one body, each chosen because it would do something
    // DIFFERENT if raw markup were being taken: a script, an inline event handler on an image, an
    // iframe, and an anchor whose href is a `javascript:` URL.
    const withRawMarkup = `Первая строка.

<script>window.__pwned = true;</script>

<img src="x" onerror="window.__pwned = true">

<iframe src="https://example.com/evil"></iframe>

<a href="javascript:window.__pwned=true">нажми</a>

Последняя строка.`;

    render(
      <ChangelogModal
        isOpen
        onClose={onClose}
        installedVersion={VERSION_WITH_A_SECTION}
        installedNotes={withRawMarkup}
      />,
    );

    // NOT A SINGLE ELEMENT of any of the four. Asked over the whole document, never over the render
    // container: this window renders through a PORTAL, so the container is empty and every scan
    // scoped to it would report clean no matter what the window drew.
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(document.querySelectorAll("iframe")).toHaveLength(0);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    // The anchors that DO exist are the ones our own `a` rule made from real markdown links; this
    // body contains no markdown links at all, so there must be none.
    expect(document.querySelectorAll("a")).toHaveLength(0);
    // And no handler survived as an attribute anywhere.
    expect(document.querySelectorAll("[onerror]")).toHaveLength(0);

    // The markup arrives as TEXT — the positive half, and the one that fails if a future change
    // starts stripping the markup instead of escaping it. Stripping would also be safe, but it
    // would be a different guarantee, and this test would then say so rather than staying green.
    const rendered = document.body.textContent ?? "";
    expect(rendered).toContain("<script>");
    expect(rendered).toContain("<iframe");
    expect(rendered).toContain("onerror=");

    // The surrounding notes still render normally: the guarantee is «inert», not «broken».
    expect(screen.getByText(/Первая строка\./)).toBeTruthy();
    expect(screen.getByText(/Последняя строка\./)).toBeTruthy();
  });

  it("T-30-16: надстройка для необработанной разметки не подключена и не объявлена", () => {
    const source: string = changelogModalSource;
    const manifest: string = packageManifestSource;
    expect(source.length).toBeGreaterThan(0);
    expect(manifest.length).toBeGreaterThan(0);

    // В компоненте: ни импорта надстройки, ни массива надстроек вообще — разметка проходит через
    // один построчный набор правил и больше ни через что.
    expect(/rehype/i.test(source), "компонент не должен подключать надстройку сырой разметки").toBe(
      false,
    );
    expect(/rehypePlugins|remarkPlugins/.test(source)).toBe(false);
    expect(/remark-gfm|remarkGfm/.test(source)).toBe(false);

    // В зависимостях приложения: надстройки сырой разметки нет ни в одном ярусе. `remark-gfm`
    // здесь намеренно НЕ проверяется по всему файлу — он живёт в ярусе разработки ради витрины и
    // в приложение не попадает; проверка выше доказывает, что компонент его не тянет.
    expect(/rehype/i.test(manifest), "в манифесте не должно быть надстройки сырой разметки").toBe(
      false,
    );
  });

  // ─── The plate says nothing the locale bundle does not (T-30-19) ───

  it("плитка «заметок нет» не показывает ни одной строки со стороны", () => {
    const { container } = render(
      <ChangelogModal
        isOpen
        onClose={onClose}
        installedVersion={VERSION_WITHOUT_A_SECTION}
      />,
    );

    const column = container.ownerDocument.querySelector("[data-notes-column]");
    const shown = (column?.textContent ?? "").trim();
    // Ровно две строки словаря и ничего сверх: ни номера версии, ни пути к файлу, ни адреса.
    expect(shown).toBe(
      `${i18n.t("about.notes_none_title")}${i18n.t("about.notes_none_body")}`,
    );
    expect(shown).not.toContain(VERSION_WITHOUT_A_SECTION);
    expect(shown).not.toContain("RELEASE_NOTES");
    expect(shown).not.toContain("http");
    expect(shown).not.toContain("/");
  });

  it("у плитки «заметок нет» нет ни одного свойства — сообщению некуда попасть", () => {
    // Структурный инвариант, а не отрисовка: слот под технический текст ловится по объявлению
    // компонента. Та же проверка, что и у плиток отказа в карточке обновления (T-30-02).
    const source: string = changelogModalSource;
    const declaration = /function NotesUnavailablePlate\(([^)]*)\)/.exec(source);
    expect(declaration, "объявление плитки должно быть найдено").not.toBeNull();
    expect(declaration?.[1].trim(), "плитка не должна принимать ничего").toBe("");
  });

  // ─── The naming canon (memory/v3/design-system/naming.md) ───

  it("вид порции назван по канону имён, а не синонимом из витрины", () => {
    const source: string = changelogModalSource;
    // Свойство компонента называется `variant` — так же, как у Badge и у всех остальных
    // примитивов. Синоним из витрины не должен был переехать вместе с геометрией.
    expect(/variant:\s*"new"\s*\|\s*"installed"/.test(source)).toBe(true);
    expect(/\btone\b/.test(source), "синоним канона в боевом коде запрещён").toBe(false);
  });
});
