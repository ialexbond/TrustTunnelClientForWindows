import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ArrowUpCircle,
  CheckCircle2,
  CloudOff,
  Download,
  FileText,
  Loader2,
  RefreshCw,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
// `PanelHeader`, not `CardHeader` (G-30-17b). The two are different treatments, and «Настройки»
// plus «Маршрутизация» both render `PanelHeader` — the 28px tinted chip that REPLACED the bare
// accent glyph when those tabs were redesigned. This tab was the one left on the old one, which is
// why the owner read its headings as not matching «Настройки». `CardHeader` also centres the glyph
// against the whole title+description block, so on a card that HAS a description — this one — the
// glyph floats between the two lines and reads as a stray square: exactly the failure `PanelHeader`
// documents as the reason «Маршрутизация» moved off it. `CardHeader` itself stays untouched; a
// dozen legacy call sites still render it and must keep their current look.
import { Button, Card, PanelHeader, ProgressBar } from "../../shared/ui";
import { useSnackBar } from "../../shared/ui/SnackBarContext";
import { useActivityLog } from "../../shared/hooks/useActivityLog";
import { formatError } from "../../shared/utils/formatError";
import { formatRelativeCheck } from "../../shared/utils/formatRelativeCheck";
import type { UpdateInfo } from "../../shared/types";

/**
 * Backend rejection code → the i18n key naming the CAUSE, exhaustively and with NO passthrough.
 *
 * THE DEFECT THIS REMOVES. The catch arm used to be `pushSnack(formatError(e), "error")`, and
 * `formatError` returns `e.message` verbatim. `self_update` rejects with rendered strings —
 * «Download failed: {e}», «Cannot determine exe path: {e}», «Download HTTP error: {status}» — so a
 * filesystem path, a URL or an HTTP status DID reach the user's screen. The card's own structural
 * invariant (`PlateShape` has no field able to hold such a thing) and the hygiene gate's rule 3
 * both measured the failure PLATE only, and the snackbar sits beside them looking as if it were
 * covered. That is the same shape of over-claim this phase already corrected once for images: an
 * absence proves only what it covers.
 *
 * Modelled on `useUpdateChecker`'s `FAILURE_BY_REASON_CODE` rather than invented: the backend mints
 * stable ASCII tokens, the presentation boundary is the single place that knows what they mean, and
 * a token nobody recognised resolves to the generic cause instead of being carried through. There
 * is no code path here that can put a backend string on screen.
 *
 * The integrity codes get their own line because they say something the generic one cannot: the
 * download completed and did NOT match what the release published, so «попробуйте позже» would be
 * the wrong advice. Every other rejection is ambiguous from the user's side and takes the honest
 * default — the same «ambiguity resolves to the safe wording» rule `30-RESEARCH.md` §3 sets for the
 * check.
 */
const SELF_UPDATE_CAUSE_KEY: Record<string, string> = {
  UPDATE_CHECKSUM_MISSING: "about.update_failed_integrity",
  UPDATE_CHECKSUM_MALFORMED: "about.update_failed_integrity",
  UPDATE_CHECKSUM_MISMATCH: "about.update_failed_integrity",
};

function selfUpdateCauseKey(rejected: unknown): string {
  const code = rejected instanceof Error ? rejected.message : rejected;
  return (
    (typeof code === "string" ? SELF_UPDATE_CAUSE_KEY[code] : undefined) ?? "about.update_failed"
  );
}

/**
 * The honest state set of the app-update check.
 *
 * A check that fails names WHICH failure it was, because «нет интернета» and «сервер не ответил»
 * ask the user for two different things. `retry-in-flight` is not an eighth outcome — it is the
 * failure plate while a retry runs, and it exists as its own value so that nothing is removed or
 * replaced while the retry is in flight.
 *
 * Ported from the story tier's own drawing of this card rather than re-drawn. That drawing has since
 * been deleted: the showcase now renders THIS component, so the витрина and the shipped card are not
 * merely the same JSX — they are the same code, and cannot drift.
 */
export type UpdateCardState =
  | "checking"
  | "up-to-date"
  | "update-available"
  | "no-internet"
  | "server-unreachable"
  | "retry-in-flight"
  | "downloading";

/**
 * One plate per state — glyph, one-line heading, one optional body line, and which affordances the
 * plate offers.
 *
 * STRUCTURAL INVARIANT (T-30-02 / OBL-1f). There is deliberately NO field able to receive an error
 * string, an exception message, a URL, a host or an HTTP status code. The card states a cause
 * CATEGORY and never the technical detail behind it: `headingKey` and `bodyKey` are i18n keys, not
 * text, so the only strings that can reach the screen are ones that already live in ru.json. That
 * is also why the shared `ErrorBanner` is not used here — its single `message` prop is exactly the
 * forbidden slot, and it is the window-level message device rather than a plate inside a card.
 *
 * The affordance flags live in the table rather than in `state === "…"` comparisons at the render
 * site: with them here, adding an eighth state is one row, and forgetting to handle it is a
 * compile error rather than a plate that silently renders without its buttons.
 */
interface PlateShape {
  icon: LucideIcon;
  /** The glyph turns while an operation is in flight — the only motion the card has. */
  spin?: boolean;
  /** Every colour is a token reference: emphasis is fill plus outline, never an edge or a ring. */
  glyph: string;
  fill: string;
  outline: string;
  /** i18n key, written as a LITERAL — the dead-key gate is a substring match over the corpus. */
  headingKey: string;
  bodyKey?: string;
  /** Which version number the heading interpolates, when it takes one at all. */
  versionFrom?: "current" | "latest";
  // NO `offersRetry` / `retryBusy` (G-30-16). The failure plates used to draw their own
  // «Попробовать снова» — wired to `onCheck`, the SAME handler as the header's «Проверить
  // обновления». Not a variant of the action: literally the action, twice, both live at once.
  // The rule this card is otherwise built on says the header steps aside when the plate owns
  // something the header does not have — `update-available` and `downloading` disable it via
  // `checkPointless`, `checking` marks it busy. Re-checking IS the header's own action, so the
  // failure plates had nothing of their own to offer and the second button was pure duplication;
  // `retry-in-flight` additionally spun two glyphs for one operation. The plate now states the
  // cause and the body line says «…и повторите», pointing at the one button that has always been
  // there, in the same place, in every state.
  /**
   * «Обновить» / «Скачать» — the two actions that only exist when there IS something to download.
   *
   * «Что нового» is deliberately NOT in this flag: the notes window is offered by every plate (see
   * the actions row at the render site), because «а что вообще у меня изменилось» is a question
   * about the version already installed and does not depend on an update being pending.
   */
  offersUpdateActions?: boolean;
  /**
   * The two actions that would START a download are held while one runs. «Что нового» is NOT held:
   * reading the notes conflicts with nothing.
   */
  updateActionsHeld?: boolean;
  /** The inline download progress bar. */
  showsProgress?: boolean;
  /** The header's check button is busy. */
  checkBusy?: boolean;
  /** The header's check button is pointless — an update is already found or already downloading. */
  checkPointless?: boolean;
}

const plateConfig: Record<UpdateCardState, PlateShape> = {
  checking: {
    icon: Loader2,
    spin: true,
    glyph: "var(--color-accent-fg)",
    fill: "var(--color-accent-tint-08)",
    outline: "var(--color-accent-tint-20)",
    headingKey: "about.checking_title",
    bodyKey: "about.checking_body",
    checkBusy: true,
  },
  "up-to-date": {
    icon: CheckCircle2,
    glyph: "var(--color-success-fg)",
    fill: "var(--color-success-tint-06)",
    outline: "var(--color-status-connected-border)",
    // The plate names the INSTALLED version so it can be read without scrolling back to the hero —
    // which is why this is `up_to_date_versioned` and not the older bare `about.up_to_date`.
    headingKey: "about.up_to_date_versioned",
    bodyKey: "about.up_to_date_body",
    versionFrom: "current",
  },
  "update-available": {
    icon: ArrowUpCircle,
    glyph: "var(--color-accent-fg)",
    fill: "var(--color-accent-tint-08)",
    outline: "var(--color-accent-tint-20)",
    headingKey: "about.update_available",
    bodyKey: "about.update_available_body",
    versionFrom: "latest",
    offersUpdateActions: true,
    checkPointless: true,
  },
  "no-internet": {
    icon: WifiOff,
    glyph: "var(--color-warning-fg)",
    fill: "var(--color-warning-tint-08)",
    outline: "var(--color-warning-tint-20)",
    headingKey: "about.check_failed_no_internet",
    bodyKey: "about.check_failed_no_internet_body",
  },
  "server-unreachable": {
    icon: CloudOff,
    glyph: "var(--color-warning-fg)",
    fill: "var(--color-warning-tint-08)",
    outline: "var(--color-warning-tint-20)",
    headingKey: "about.check_failed_server",
    bodyKey: "about.check_failed_server_body",
  },
  "retry-in-flight": {
    icon: CloudOff,
    glyph: "var(--color-warning-fg)",
    fill: "var(--color-warning-tint-08)",
    outline: "var(--color-warning-tint-20)",
    // The failure plate, UNCHANGED, while a re-check runs: same glyph, same copy, nothing added
    // and nothing removed. Only the header's button is busy — which is now the ONLY button
    // involved (G-30-16). This state still earns its own value: without it the card would swap
    // the failure plate for «Проверяем обновления…» and the user would lose the cause they were
    // reading mid-sentence. The heading deliberately stays on the server-unreachable wording —
    // see `deriveState`, which routes the no-internet retry here too and is the one place that
    // would have to change if the two ever needed to differ.
    headingKey: "about.check_failed_server",
    bodyKey: "about.check_failed_server_body",
    checkBusy: true,
  },
  downloading: {
    icon: Download,
    glyph: "var(--color-accent-fg)",
    fill: "var(--color-accent-tint-08)",
    outline: "var(--color-accent-tint-20)",
    // NOT `update.downloading`: that string is the sidecar cascade's own wording («скачано X из Y»)
    // and belongs to the other update track. Merging the two vocabularies is forbidden.
    headingKey: "about.downloading_version",
    versionFrom: "latest",
    offersUpdateActions: true,
    updateActionsHeld: true,
    showsProgress: true,
    checkPointless: true,
  },
};

/**
 * Which plate to show, derived from state and never stored.
 *
 * Storing the state member would give the card a second source of truth that could disagree with
 * `updateInfo`; deriving it means the card cannot show «актуальная версия» while `checkError` is
 * set, because there is no assignment that could put it there.
 *
 * Order is the contract: a running download outranks everything; a retry is a check that already
 * has a failure behind it, so it has to be tested before the plain in-flight case; and `checkError`
 * is tested before `available`, which is what makes the up-to-date plate unreachable after a failed
 * check (T-30-01).
 */
function deriveState(updateInfo: UpdateInfo, updating: boolean): UpdateCardState {
  // A RUNNING DOWNLOAD OUTRANKS A CHECK. `checking` used to be tested first, and the 24h
  // `setInterval` in `useUpdateChecker` fires a background check unconditionally — it does not know
  // a download is running, and `checkPointless` only disables the BUTTON, not the timer. So mid
  // download the plate switched to «Проверяем обновления…», the ProgressBar unmounted (the user
  // lost all feedback while an elevated installer was being fetched), and when the check came back
  // with `available: true` the plate became `update-available`, whose actions are NOT held — so
  // «Обновить» went live again while the first download was still running and a second press
  // started a second `self_update`. The check has no side effects; the download does, and the
  // operation with side effects is the one the card must keep showing.
  if (updating) return "downloading";
  const failure = updateInfo.checkError ?? null;
  if (failure && updateInfo.checking) return "retry-in-flight";
  if (updateInfo.checking) return "checking";
  if (failure) return failure;
  if (updateInfo.available) return "update-available";
  return "up-to-date";
}

/** The three-field payload the Rust self-update emits on `update-progress`. */
interface UpdateProgressPayload {
  stage: string;
  percent: number;
  message: string;
}

export interface UpdateCardProps {
  updateInfo: UpdateInfo;
  /** Run a check. A retry IS a check — the panel threads the same handler for both. */
  onCheck: () => void;
  /** Open the release page in the system browser (the manual «Скачать» path). */
  onOpenDownload: () => void;
  /**
   * Open the changelog window the panel owns.
   *
   * REQUIRED, and that is the point. It used to be optional «so the card can be rendered on its own
   * in tests and in the showcase» — but the button is rendered unconditionally, so an omitted
   * handler produced an enabled, focusable, screen-reader-announced button that did nothing when
   * pressed. That is the very defect plan 30-06 removed from the footer copyright line: «a control
   * that announces itself pressable and does nothing when pressed is a defect». It could not be
   * fixed by hiding the button either — `about.md` §«Карточка обновления» binds «Что нового» to
   * every plate, working even while a download runs. So the handler is mandatory and the compiler
   * is what enforces it.
   */
  onOpenChangelog: () => void;
}

/**
 * The «Обновление приложения» card: header with the check action, one state plate, and the space
 * beneath it where the last-successful-check line goes.
 *
 * IN-FLIGHT RULE: a control that is busy is DISABLED, never removed and never replaced by an
 * invented placeholder. Both busy affordances come from `Button`'s own `loading` flag, which
 * already sets `disabled` — hand-rolling a spinner beside a still-clickable button is how the two
 * states drift apart.
 */
export function UpdateCard({
  updateInfo,
  onCheck,
  onOpenDownload,
  onOpenChangelog,
}: UpdateCardProps) {
  const { t } = useTranslation();
  const pushSnack = useSnackBar();
  // The diagnostic half of the error channel. The technical detail behind a failed self-update is
  // worth keeping — it is what a bug report needs — so it goes where this project already puts such
  // detail, the app log, and nowhere else. Screen and log are two channels with two different
  // audiences; the defect was routing one into the other.
  const { log: activityLog } = useActivityLog();
  // The self-update flow lives HERE rather than in AboutPanel (Phase 30): the progress bar it
  // drives is inside this card, and a state that only this card reads has no reason to sit a level
  // above it and be prop-drilled back down.
  const [updating, setUpdating] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgressPayload | null>(null);

  // Translate update progress message keys emitted by Rust.
  const translateProgress = useCallback(
    (payload: UpdateProgressPayload): UpdateProgressPayload => {
      const { message } = payload;
      if (message.startsWith("update.downloading|")) {
        const parts = message.split("|");
        return {
          ...payload,
          message: t("update.downloading", { downloaded: parts[1], total: parts[2] }),
        };
      }
      if (message.startsWith("update.")) {
        return { ...payload, message: t(message) };
      }
      return payload;
    },
    [t],
  );

  useEffect(() => {
    const unlisten = listen<UpdateProgressPayload>("update-progress", (event) => {
      setUpdateProgress(translateProgress(event.payload));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [translateProgress]);

  const handleSelfUpdate = async () => {
    if (!updateInfo.downloadUrl) return;
    // Re-entry guard. The plate's `updateActionsHeld` already disables «Обновить» while a download
    // runs, but that is a rendering rule; this is the invariant. Two concurrent `self_update`
    // calls would download and launch two elevated installers, so the guard belongs at the door
    // and not only in the styling.
    if (updating) return;
    setUpdating(true);
    setUpdateProgress({ stage: "download", percent: 0, message: t("status.preparing") });
    try {
      await invoke("self_update", {
        downloadUrl: updateInfo.downloadUrl,
        // The integrity expectation. Phase 30 moved its RESOLUTION into Rust
        // (`AppUpdateInfo.sha256`) but not its destination: it still arrives here and still reaches
        // `self_update`, so relocating the check did not quietly weaken the tamper control.
        expectedSha256: updateInfo.sha256 || "",
        language: localStorage.getItem("tt_language") || "ru",
        theme: localStorage.getItem("tt_theme") || "dark",
      });
      // `self_update` normally never returns: it launches the installer and ends this process. That
      // assumption used to be implicit — `updating` was cleared only in the `catch` — and an
      // assumption nothing states is an assumption nothing protects. If the call ever DOES resolve
      // (the installer spawns but the app is not killed, or a future early return is added on the
      // Rust side), the card was left pinned to «Скачиваем…» with the check button held by
      // `checkPointless` and «Обновить» held by `updateActionsHeld` — a frozen card with no way
      // back short of restarting the app. Releasing the flag here costs nothing on the normal path,
      // because on the normal path this line is never reached.
      setUpdating(false);
      setUpdateProgress(null);
    } catch (e) {
      // A CAUSE ON SCREEN, THE PAYLOAD IN THE LOG. Both lines are deliberate and both are one
      // statement each, so neither can drift into the other: `t(...)` of a key this file chose
      // cannot carry a path, and `activityLog` does not render.
      activityLog("ERROR", "about.self_update_failed", formatError(e));
      pushSnack(t(selfUpdateCauseKey(e)), "error");
      setUpdating(false);
      setUpdateProgress(null);
    }
  };

  const state = deriveState(updateInfo, updating);
  const plate = plateConfig[state];
  const PlateIcon = plate.icon;

  const version =
    plate.versionFrom === "current"
      ? updateInfo.currentVersion
      : plate.versionFrom === "latest"
        ? updateInfo.latestVersion
        : undefined;

  const percent = updateProgress?.percent ?? 0;

  // Ключ фразы и её число, а не готовая строка: `formatRelativeCheck` намеренно ничего не
  // переводит, и `t()` вызывается здесь, на границе отрисовки. Расчёт идёт на каждую перерисовку —
  // это одно вычитание дат, и запоминать его в useMemo значило бы заморозить фразу: «только что»
  // должно само становиться «5 минут назад», когда карточку перерисуют по другой причине.
  const lastCheck = formatRelativeCheck(updateInfo.lastChecked);

  return (
    <Card padding="md" className="w-full">
      <PanelHeader
        title={t("about.update_card_title")}
        description={t("about.update_card_desc")}
        icon={<RefreshCw className="w-4 h-4" />}
        action={
          <Button
            variant="secondary"
            size="sm"
            loading={plate.checkBusy}
            disabled={plate.checkPointless}
            icon={<RefreshCw className="w-3.5 h-3.5" />}
            onClick={onCheck}
          >
            {t("buttons.check_updates")}
          </Button>
        }
      />

      {/* One polite live region over the plate AND the space beneath it: a screen reader announces
          the move from «проверяем» to a result, and from a failure to a retry, instead of leaving
          the change silent. Polite rather than assertive — an update check never interrupts. */}
      <div aria-live="polite">
        <div
          className="flex items-start gap-[var(--space-3)] rounded-[var(--radius-md)] p-[var(--space-3)]"
          style={{ backgroundColor: plate.fill, border: `1px solid ${plate.outline}` }}
        >
          <PlateIcon
            className={`w-4 h-4 shrink-0 mt-0.5 ${plate.spin ? "animate-spin" : ""}`}
            style={{ color: plate.glyph }}
            aria-hidden="true"
          />
          <div className="flex min-w-0 flex-1 flex-col gap-[var(--space-2)]">
            <p className="text-sm font-medium" style={{ color: "var(--color-text-primary)" }}>
              {t(plate.headingKey, { version })}
            </p>
            {plate.bodyKey && (
              <p className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
                {t(plate.bodyKey)}
              </p>
            )}

            {plate.showsProgress && (
              // The app-update progress is INLINE in the card: one track, no overlay, no backdrop
              // and no step-by-step cascade list. That is what tells it apart at a glance from the
              // sidecar's update window, which is a modal over a darkened screen with four steps.
              // `ProgressBar` brings the progressbar role and a worded label; a width-styled div
              // would bring neither.
              <div className="flex flex-col gap-[var(--space-1)]">
                <ProgressBar
                  value={percent}
                  size="sm"
                  label={t("about.download_progress", { percent })}
                />
                {updateProgress?.message && (
                  <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                    {updateProgress.message}
                  </p>
                )}
              </div>
            )}

            {/* ОДИН ряд действий на все состояния.
                Раньше рядов было два — один для «Обновить/Скачать», другой для повтора, — и
                «Что нового» жила внутри первого, да ещё и за условием «в ответе проверки приехал
                текст заметок». Из-за этого вопрос «а что вообще у меня изменилось» пользователь мог
                задать только тогда, когда было что скачивать: при актуальной версии и после
                неудачной проверки кнопки просто не было (29 D-04).

                Теперь «Что нового» стоит в ряду ВСЕГДА и последней, а условие осталось только у
                тех кнопок, у которых ему и место: «Обновить»/«Скачать» — когда есть что качать.
                Кнопки повтора в ряду нет вовсе (G-30-16): повторная проверка — это действие шапки,
                и второй её экземпляр здесь был не выбором, а дублем. Заметки установленной версии
                окно достаёт из вложенного в сборку файла, поэтому показать ему есть что и без сети;
                а если раздела для версии в файле не нашлось, окно честно покажет плитку «заметок
                нет» — это лучше, чем недоступная кнопка, за которой не понять, есть там что-то. */}
            <div className="flex flex-wrap gap-[var(--space-2)] pt-[var(--space-1)]">
              {plate.offersUpdateActions && (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<ArrowUpCircle className="w-3.5 h-3.5" />}
                    disabled={plate.updateActionsHeld || !updateInfo.downloadUrl}
                    onClick={handleSelfUpdate}
                  >
                    {t("buttons.update")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Download className="w-3.5 h-3.5" />}
                    disabled={plate.updateActionsHeld}
                    onClick={onOpenDownload}
                  >
                    {t("buttons.download")}
                  </Button>
                </>
              )}

              {/* The failure plates used to draw a «Попробовать снова» here, on `onCheck` — the
                  same handler the header's «Проверить обновления» already carries. It is gone
                  (G-30-16): one action, one button, one place, in every state. See the note in
                  `PlateShape` for why the two were the same action rather than two of them, and
                  why this card's own rule made the duplicate visible. Its accessible-name key
                  `about.retry_aria` went with it — `buttons.retry` stays, three other surfaces
                  still use it. */}
              <Button
                variant="secondary"
                size="sm"
                icon={<FileText className="w-3.5 h-3.5" />}
                onClick={onOpenChangelog}
              >
                {t("buttons.whats_new")}
              </Button>
            </div>
          </div>
        </div>

        {/* Строка последней удачной проверки стоит ВНУТРИ живой области вместе с плиткой: диктору
            нужно проговорить пару «что случилось + когда в последний раз получилось» целиком, а не
            двумя объявлениями в неизвестном порядке.

            Неудачная проверка эту строку не стирает — и не потому, что здесь есть какое-то условие,
            а потому, что стирать нечего: `lastChecked` при отказе не переписывается (D-30-02), так
            что строка сама продолжает называть прежний момент.

            Когда проверок ещё не было, `formatRelativeCheck` возвращает null и не рисуется НИЧЕГО —
            ни прочерка, ни «неизвестно»: приложению нечего сказать, и оно молчит. */}
        {lastCheck && (
          <p className="text-xs mt-[var(--space-2)]" style={{ color: "var(--color-text-muted)" }}>
            {t("about.last_check", { when: t(lastCheck.key, lastCheck.values) })}
          </p>
        )}
      </div>

      {/*
        ЗАРЕЗЕРВИРОВАННОЕ МЕСТО — строка «Обновлять автоматически».

        Здесь намеренно не рисуется ничего. Приложение пока не умеет обновляться само, а
        выключенный переключатель с подписью «скоро» — это обещание, которого приложение не даёт;
        неактивный вид обещание не уменьшает.

        Место записано и в спецификации экрана: строка встанет ровно сюда, между строкой последней
        удачной проверки и нижним краем карточки, — карточку при этом переделывать не придётся.
        Отсутствие проверяется тестом по РОЛИ (switch / checkbox), а не поиском по исходнику: так
        ловится переключатель, добавленный любым способом, а не только знакомым компонентом.
      */}
    </Card>
  );
}
