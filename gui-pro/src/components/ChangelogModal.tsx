import { useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { FileText, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-shell";
import { Modal } from "../shared/ui/Modal";
import { Badge } from "../shared/ui/Badge";
import { Divider } from "../shared/ui/Divider";
import { parseReleaseNotes } from "../shared/utils/parseReleaseNotes";
// Заметки установленной версии приезжают ИЗ САМОЙ СБОРКИ, а не из сети и не с диска: Vite
// подставляет содержимое файла строковой константой на этапе сборки. Поэтому окно «Что нового»
// работает без интернета, всегда содержит текст и всегда остаётся русским — ровно то, ради чего
// файл и заведён (плана 30-02, D-20). Тот же приём уже применён к образцу вывода замера скорости
// (`components/server/benchmark/parser.test.ts`): текстовый ресурс под `src/`, подтянутый запросом
// `?raw`, разрешается по пути на этапе преобразования и не зависит ни от рабочей папки, ни от
// файловой системы во время работы приложения.
import releaseNotesRaw from "../shared/release-notes/RELEASE_NOTES.ru.md?raw";

type CP = { children?: ReactNode };

/**
 * Набор правил «тег → оформление» для текста выпуска.
 *
 * Каждое правило берёт цвет и размер из токенов — своего цвета у окна нет. Два свойства набора
 * важнее остальных и НЕ ПОДЛЕЖАТ ОСЛАБЛЕНИЮ (memory/v3/screens/about.md §«Как показывается
 * разметка» — обязательное требование дизайна, а не пожелание):
 *
 *  1. Ссылка. Щелчок перехватывается, стандартный переход отменяется, адрес отдаётся системному
 *     браузеру. Внутри окна приложения ссылка не открывается никогда — текст выпуска новой версии
 *     приходит снаружи, и переход по нему не должен становиться навигацией внутри приложения.
 *  2. Картинка не рисуется НИКОГДА. Тег изображения сопоставлен правилу, которое не рисует
 *     ничего, — и защита именно в этом правиле, а не в его отсутствии.
 *
 *     КАК БЫЛО И ПОЧЕМУ ПЕРЕДЕЛАНО. Раньше правила для тега изображения здесь просто НЕ БЫЛО, а
 *     комментарий и тест T-30-17 объявляли это отсутствие защитой. Проверка на живом наборе
 *     (`react-markdown` версии 9) показала обратное: незаданный тег обрабатывается собственным
 *     правилом библиотеки по умолчанию, и текст выпуска вида `![x](https://…/y.png)` разворачивался
 *     в настоящий `<img src="https://…">`. То есть отсутствие правила ничего не запрещало.
 *     Единственным, что реально не давало окну потянуть внешний файл, была политика содержимого
 *     приложения (`src-tauri/tauri.conf.json`, `img-src 'self' data: asset:
 *     https://asset.localhost`) — она заведена задолго до этой вкладки, к ней отношения не имеет и
 *     может быть ослаблена когда-нибудь ради совсем другой задачи.
 *
 *     Поэтому обещание перенесено туда, где оно и объявлено: узел изображения теперь не появляется
 *     в разметке вовсе. Политика содержимого остаётся вторым рубежом, а не единственным.
 *
 *     Надстройка для необработанной разметки по-прежнему не подключена — здесь отсутствие работает,
 *     потому что без неё библиотека исполняемую разметку из текста не берёт по построению. Это
 *     закреплено тестом по исходнику (T-30-16), а само правило для изображения — тестом на
 *     отрисовке (T-30-17), а не на исходнике: проверять надо поведение, а не наличие строки.
 */
const notesComponents = {
  h1: ({ children }: CP) => (
    <h1 className="mb-[var(--space-2)] mt-0 text-sm font-semibold text-[var(--color-text-primary)]">
      {children}
    </h1>
  ),
  // Заголовок второго уровня набор знает, хотя в разобранном разделе его быть не должно: в файле
  // заметок версии разделены именно им, и `parseReleaseNotes` заголовок версии вырезает. Строку
  // «Версия X.Y.Z» окно рисует само — см. NotesSection.
  h2: ({ children }: CP) => (
    <h2 className="mb-[var(--space-2)] mt-0 text-sm font-semibold text-[var(--color-text-primary)]">
      {children}
    </h2>
  ),
  h3: ({ children }: CP) => (
    <h3 className="mb-[var(--space-1)] mt-[var(--space-3)] text-xs font-semibold text-[var(--color-text-secondary)]">
      {children}
    </h3>
  ),
  p: ({ children }: CP) => (
    <p className="mb-[var(--space-2)] text-xs leading-relaxed text-[var(--color-text-secondary)]">
      {children}
    </p>
  ),
  strong: ({ children }: CP) => (
    <strong className="font-semibold text-[var(--color-text-primary)]">{children}</strong>
  ),
  em: ({ children }: CP) => (
    <em className="italic text-[var(--color-text-secondary)]">{children}</em>
  ),
  ul: ({ children }: CP) => (
    <ul className="mb-[var(--space-2)] list-disc space-y-0.5 pl-4">{children}</ul>
  ),
  ol: ({ children }: CP) => (
    <ol className="mb-[var(--space-2)] list-decimal space-y-0.5 pl-4">{children}</ol>
  ),
  li: ({ children }: CP) => (
    <li className="text-xs text-[var(--color-text-secondary)]">{children}</li>
  ),
  hr: () => <hr className="my-[var(--space-3)] border-[var(--color-border)]" />,
  code: ({ children, className }: { children?: ReactNode; className?: string }) => {
    // Блок кода отличается от вставки внутри строки наличием класса языка: без него это короткая
    // вставка, с ним — отдельный блок.
    const isBlock = Boolean(className);
    if (isBlock) {
      return (
        <pre className="mb-[var(--space-2)] overflow-x-auto rounded-[var(--radius-md)] bg-[var(--color-bg-elevated)] p-[var(--space-3)] font-mono text-xs text-[var(--color-text-primary)]">
          <code>{children}</code>
        </pre>
      );
    }
    return (
      <code className="rounded-[var(--radius-sm)] bg-[var(--color-bg-hover)] px-1 py-0.5 font-mono text-xs text-[var(--color-text-primary)]">
        {children}
      </code>
    );
  },
  // Тег изображения — правило, которое НИЧЕГО не рисует. Не украшение и не заглушка: это тот самый
  // запрет из пункта 2 наверху. Возврат `null` означает, что узла изображения в разметке не
  // возникнет, а значит окну неоткуда обратиться за внешним файлом — независимо от политики
  // содержимого приложения. Убрать это правило = вернуть отрисовку картинок из чужого текста
  // выпуска: незаданный тег библиотека рисует сама.
  img: () => null,
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a
      href={href}
      className="cursor-pointer text-[var(--color-accent-fg)] underline underline-offset-2 opacity-80 hover:opacity-100"
      onClick={(e) => {
        // Перехват — не оптимизация, а правило: адрес из текста выпуска уходит системному
        // браузеру, окно приложения на него не переходит.
        e.preventDefault();
        if (href) open(href);
      }}
    >
      {children}
    </a>
  ),
};

/**
 * Спокойная плитка «заметок нет».
 *
 * СТРУКТУРНЫЙ ИНВАРИАНТ. У плитки нет ни одного свойства — ни для сообщения, ни для подробности,
 * ни для пути, ни для адреса. Это та же честность, что и у плиток отказа в карточке обновления
 * (`about/UpdateCard.tsx`, T-30-02): раз слота под технический текст не существует, он и не может
 * туда попасть. Именно это позволяет держать окно доступным всегда — даже когда показать нечего,
 * показывать сбой не придётся. Обе строки берутся из словаря локализации и больше ниоткуда.
 */
function NotesUnavailablePlate() {
  const { t } = useTranslation();

  return (
    <div className="flex items-start gap-[var(--space-3)] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-[var(--space-3)]">
      <FileText
        className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-muted)]"
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-[var(--space-2)]">
        <p className="text-sm font-medium text-[var(--color-text-primary)]">
          {t("about.notes_none_title")}
        </p>
        <p className="text-xs text-[var(--color-text-secondary)]">
          {t("about.notes_none_body")}
        </p>
      </div>
    </div>
  );
}

/**
 * Одна порция заметок: строка «Версия X.Y.Z» с меткой рядом, под ней — размеченный текст выпуска.
 *
 * Заголовок и метка стоят В ОДНУ СТРОКУ, а не столбиком. Столбиком метка читалась как отдельный
 * блок над заголовком и забирала на себя первый взгляд, хотя главное здесь — какая это версия;
 * метка лишь уточняет, стоит она уже или только вышла. Заголовок поэтому крупнее текста заметок на
 * один шаг шкалы, а метка прижата к нему. Перенос на вторую строку разрешён (`flex-wrap`): в узком
 * окне длинная метка не должна выдавливать номер версии за край. Значок у новой версии живёт
 * ВНУТРИ метки: снаружи он был третьим предметом в ряду и спорил с заголовком за внимание.
 *
 * ИМЯ СВОЙСТВА. В витрине (`about/ChangelogWindow.stories.tsx`) это свойство называлось иначе —
 * синонимом, которого канон имён не знает. Канон проекта для «какого рода эта штука» — `variant`
 * (memory/v3/design-system/naming.md), и плодить второе имя для того же смысла запрещено. Поэтому
 * при переносе кода свойство переименовано, а для тестов вид порции выставлен атрибутом
 * `data-notes-section`, а не вторым именем свойства.
 *
 * Строку «Версия X.Y.Z» рисует ИМЕННО ЭТОТ компонент, из номера версии, который ему передали.
 * Разбор файла заголовок версии вырезает (`parseReleaseNotes`), поэтому размеченный текст не может
 * принести номер версии второй раз — и никакого заголовка к телу здесь не приписывается.
 */
function NotesSection({
  version,
  variant,
  notes,
}: {
  version: string;
  variant: "new" | "installed";
  notes: string;
}) {
  const { t } = useTranslation();
  const isNew = variant === "new";

  return (
    <section data-notes-section={variant} className="flex flex-col gap-[var(--space-2)]">
      <div className="flex flex-wrap items-center gap-x-[var(--space-2)] gap-y-[var(--space-1)]">
        <h3 className="text-base font-semibold leading-snug text-[var(--color-text-primary)]">
          {t("about.notes_version_heading", { version })}
        </h3>
        <Badge variant={isNew ? "info" : "neutral"} size="sm">
          {isNew && <Sparkles className="h-3 w-3" aria-hidden="true" />}
          {isNew ? t("about.notes_label_new") : t("about.notes_label_installed")}
        </Badge>
      </div>
      <ReactMarkdown components={notesComponents}>{notes}</ReactMarkdown>
    </section>
  );
}

export interface ChangelogModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Версия, которая стоит у пользователя: её номер стоит в подзаголовке и в заголовке порции. */
  installedVersion: string;
  /**
   * Заметки установленной версии.
   *
   * Приложение это свойство НЕ передаёт: окно само достаёт свой раздел из вложенного в сборку
   * файла — источник у установленной порции один, и он принадлежит окну, а не месту, где окно
   * подвешено. Явное значение здесь — переопределение для тестов и витрины, чтобы разбор порции
   * можно было проверить на своём образце, не превращая боевой файл заметок в тестовый образец.
   * `null` означает «раздела для этой версии в файле нет» и рисует плитку, а не пустой раздел.
   */
  installedNotes?: string | null;
  /** Версия, которая вышла. Задаётся только тогда, когда обновление действительно найдено. */
  availableVersion?: string;
  /** Заметки вышедшей версии — их приносит ответ проверки обновлений, приложение их не писало. */
  availableNotes?: string;
}

/**
 * Окно «Что нового».
 *
 * Это общее модальное окно приложения — то же затемнение с размытием, то же закрытие по Esc и по
 * щелчку мимо окна. Своего оверлея окно не заводит, и собственной коробки вокруг общего примитива
 * тоже: раньше здесь была ещё одна панель фиксированной ширины поверх `Modal`, теперь оболочку
 * целиком держит общий примитив, а окно только снимает с него отступы и прокрутку.
 *
 * Внутри — две части: шапка с названием, подзаголовком и крестиком, и прокручиваемая колонка
 * заметок. Шапка и крестик стоят на месте: прокручивается только колонка. Нижнего ряда с кнопкой
 * «Закрыть» больше нет — крестик в шапке, Esc и щелчок мимо окна и так дают три выхода, а
 * четвёртый занимал место, которое нужнее заметкам.
 *
 * ДВЕ ВЕРСИИ — ОДНА КОЛОНКА, БЕЗ ВКЛАДОК. Когда обновление найдено, сверху идёт порция новой
 * версии с меткой, под ней — порция установленной. Вкладки на два раздела в окне такой ширины
 * прятали бы половину содержимого за щелчком, которого читатель не просил.
 *
 * ОКНО ОТКРЫВАЕТСЯ ВСЕГДА. Раньше оно показывало ровно одну порцию заметок, приходившую строкой
 * снаружи, и кнопка его открытия была привязана к найденному обновлению — то есть на вопрос «а что
 * вообще у меня изменилось» приложение отвечало только тогда, когда было что скачивать. Теперь у
 * окна два источника: вложенный в сборку файл для установленной версии и ответ проверки
 * обновлений — для новой.
 */
export function ChangelogModal({
  isOpen,
  onClose,
  installedVersion,
  installedNotes,
  availableVersion,
  availableNotes,
}: ChangelogModalProps) {
  const { t } = useTranslation();

  // Разбор файла — чистая функция над строковой константой уровня модуля, поэтому его результат
  // зависит ровно от номера версии. `useMemo` здесь не про скорость (файл маленький), а про
  // ссылочную устойчивость разбора при каждой перерисовке окна.
  const resolvedInstalledNotes = useMemo(
    () =>
      installedNotes !== undefined
        ? installedNotes
        : parseReleaseNotes(releaseNotesRaw, installedVersion),
    [installedNotes, installedVersion],
  );

  // Порция новой версии показывается только когда обновление действительно найдено И его текст
  // приехал. Обещать раздел, которого нет, окно не станет.
  const hasUpdate = Boolean(availableVersion && availableNotes);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      closeOnBackdrop
      closeOnEscape
      role="dialog"
      ariaLabelledby="changelog-window-title"
      ariaModal
      // Панель окна рисуется целиком внутри: у общей коробки снимаются её собственные отступы и
      // прокрутка, чтобы шапка легла встык к краю, а прокручивалась только колонка заметок.
      className="max-w-[520px] overflow-hidden p-0"
    >
      {/* Шапка: название, версия и крестик. Из окна она не уезжает. */}
      <div className="flex items-start justify-between gap-[var(--space-3)] border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-[var(--space-4)] py-[var(--space-3)]">
        <div className="flex min-w-0 flex-col gap-[var(--space-0-5)]">
          <h2
            id="changelog-window-title"
            className="text-sm font-semibold text-[var(--color-text-primary)]"
          >
            {t("about.notes_window_title")}
          </h2>
          <p className="truncate text-xs text-[var(--color-text-secondary)]">
            {hasUpdate
              ? t("about.notes_subtitle_with_update", {
                  installed: installedVersion,
                  available: availableVersion,
                })
              : t("about.notes_subtitle_installed", { version: installedVersion })}
          </p>
        </div>
        <button
          type="button"
          // Собственное имя у крестика: подпись «Закрыть» повторяется в приложении много раз и сама
          // по себе не говорит, что именно закрывают. Раньше здесь стояло английское «Close» прямо
          // в коде — мимо словаря локализации и мимо этого правила.
          aria-label={t("about.notes_close_aria")}
          onClick={onClose}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-muted)] outline-none transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:shadow-[var(--focus-ring)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Колонка заметок — единственное, что двигается. Высота ограничена, прокрутка своя. */}
      <div
        data-notes-column="true"
        className="scroll-visible max-h-[360px] overflow-y-auto p-[var(--space-4)]"
      >
        {resolvedInstalledNotes === null && !hasUpdate ? (
          <NotesUnavailablePlate />
        ) : (
          <div className="flex flex-col gap-[var(--space-3)]">
            {hasUpdate && availableNotes && (
              <NotesSection
                version={availableVersion ?? ""}
                variant="new"
                notes={availableNotes}
              />
            )}
            {hasUpdate && resolvedInstalledNotes !== null && <Divider />}
            {resolvedInstalledNotes !== null ? (
              <NotesSection
                version={installedVersion}
                variant="installed"
                notes={resolvedInstalledNotes}
              />
            ) : (
              <NotesUnavailablePlate />
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default ChangelogModal;
