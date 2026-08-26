import { useState, useMemo, type UIEvent } from "react";
import { useTranslation } from "react-i18next";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Search, Loader2, AlertTriangle, FolderOpen } from "lucide-react";
import { Modal, Button, Checkbox, Input, EmptyState } from "../../shared/ui";
import { ProcessIcon } from "./ProcessIcon";
import {
  ICON_BATCH_SIZE,
  resolveProcessIconForPath,
  useProcessIcons,
} from "./useProcessIcons";
import type { ProcessInfo } from "./useRoutingState";

/**
 * How many rows get a real icon before the user scrolls, and how much that grows per scroll.
 *
 * Tied to the command's batch size on purpose: one window step is exactly one command call, so the
 * user's scroll and the backend's unit of work advance in lockstep. This is the laziness D-02 asks
 * for — the picker can list ~200 processes, and a cold shell icon cache costs single-digit seconds
 * to resolve them all, so asking for everything on open would freeze the modal for seconds before it
 * ever appeared. Rows past the window still render, at the same size, with an empty icon slot; they
 * are below the fold, and the first scroll gesture pulls their icons in.
 */
const ICON_WINDOW_STEP = ICON_BATCH_SIZE;

/** Stable empty array so the closed picker declares nothing and never re-triggers the request effect. */
const NO_NAMES: string[] = [];

/**
 * The file name at the end of a Windows path, with the directory dropped.
 *
 * Both separators are honoured because the OS dialog is not the only thing that has ever produced a
 * path in this app. The result is returned EXACTLY as it was spelled — no lowercasing, no trimming
 * of the extension: what the user picked is what gets stored, and process-name semantics belong to
 * the core, which folds case on both sides of its own comparison.
 */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * The ONE comparison key for a program name, everywhere in this file.
 *
 * D-05 locks a two-part rule: COMPARE FOLDED, STORE VERBATIM. `addProcess` implements the folded
 * compare (`useRoutingState.ts`), and this file used to disagree with it in three separate places —
 * the already-added test, the row dedup, and the picked-file merge all compared exact strings. The
 * consequence was not cosmetic: a program saved as `Foo.exe` (the file-picker door stores exactly
 * what the user picked) read as un-added next to the enumerator's lowercase `foo.exe`, so the row
 * was tickable, the button counted it, and `addProcess` then folded, matched, and returned the
 * previous state — nothing added, nothing said.
 *
 * Folding here is a LOOKUP KEY only. Nothing this function touches is ever stored or sent: the
 * names that leave through `onConfirm` are the caller's own spelling, because process-name
 * semantics belong to the C++ core and normalizing on our side would rewrite the user's rule.
 */
function foldName(name: string): string {
  return name.toLowerCase();
}

/** Drop repeats by the folded key while keeping each name's first, verbatim spelling. */
function dedupeFolded(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const name of names) {
    const key = foldName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }
  return unique;
}

interface ProcessPickerModalProps {
  open: boolean;
  processes: ProcessInfo[];
  loading: boolean;
  /**
   * Translated message when the running-process enumeration FAILED. Distinct from an empty
   * `processes` array on purpose — see the render below for why conflating the two was a lie.
   */
  error?: string;
  alreadyAdded: string[];
  onConfirm: (selected: string[]) => void;
  onClose: () => void;
}

export function ProcessPickerModal({
  open,
  processes,
  loading,
  error,
  alreadyAdded,
  onConfirm,
  onClose,
}: ProcessPickerModalProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  /**
   * Programs the user picked off the disk during THIS visit to the picker.
   *
   * A file the user chose is very often not running, so it has no entry in `processes` and would
   * disappear from the rendered rows the instant it was selected — selected but invisible, which
   * reads as "nothing happened". Merging these names into the list is what keeps the pick visible
   * and tickable. Held locally and cleared on close: this is a scratch pad for one visit, not a
   * second store of saved programs.
   */
  const [pickedFiles, setPickedFiles] = useState<string[]>([]);

  /**
   * A failure of the OS file dialog, already translated.
   *
   * Kept SEPARATE from the enumeration failure, because the two have very different blast radii.
   * An enumeration failure means the list is genuinely missing, so it takes the list's place. A
   * dialog failure means one button did not open a window — the ~200 running processes are still
   * sitting right there. Merging the two (`error || pickError`, feeding the region that replaces
   * the list) meant one dialog hiccup wiped the entire list and left the user with «Не удалось
   * открыть выбор файла» where their programs had been, with no way back except closing and
   * reopening the modal.
   */
  const [pickError, setPickError] = useState("");

  const alreadySet = useMemo(() => new Set(alreadyAdded.map(foldName)), [alreadyAdded]);

  const listed = useMemo(() => {
    // Picked files go FIRST: they are what the user just did, so they belong where the eye already
    // is, and being at the top also puts them inside the initial icon window.
    const running = new Set(processes.map((p) => foldName(p.name)));
    const extra: ProcessInfo[] = pickedFiles
      .filter((name) => !running.has(foldName(name)))
      .map((name) => ({ name }));
    return extra.length === 0 ? processes : [...extra, ...processes];
  }, [processes, pickedFiles]);

  const filtered = useMemo(() => {
    const seen = new Set<string>();
    const unique: ProcessInfo[] = [];
    for (const p of listed) {
      const key = foldName(p.name);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(p);
      }
    }

    if (!search.trim()) return unique;
    // Name only. The old clause also searched `p.path`, a field the backend never populated —
    // dead code reading as live, over data that must not be on screen in the first place.
    const q = foldName(search);
    return unique.filter((p) => foldName(p.name).includes(q));
  }, [listed, search]);

  // The icon window, derived rather than reset by an effect. A key change (the picker opening or the
  // query changing) invalidates the stored count instead of a setState-in-effect rewinding it, which
  // keeps this free of the cascading extra render that eslint's react-hooks/set-state-in-effect
  // rejects — and means a new search always starts its icons from the top of the new result list.
  const windowKey = `${open ? "open" : "closed"}|${search}`;
  const [grownWindow, setGrownWindow] = useState({ key: windowKey, count: ICON_WINDOW_STEP });
  const iconWindow = grownWindow.key === windowKey ? grownWindow.count : ICON_WINDOW_STEP;

  // Declare only what the user can plausibly be looking at. A closed picker declares nothing at all:
  // ProcessFilterSection keeps this component mounted with a full process list behind it, so without
  // the guard the modal would warm up icons for a list nobody has opened.
  const visibleNames = useMemo(
    () => (open ? filtered.slice(0, iconWindow).map((p) => p.name) : NO_NAMES),
    [open, filtered, iconWindow]
  );
  useProcessIcons(visibleNames);

  const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const total = filtered.length;
    if (iconWindow >= total) return;

    // Grow to cover WHERE THE USER IS, not how close they are to the end of the list.
    //
    // This used to read `scrollTop + clientHeight >= scrollHeight - 200`, i.e. "within 200px of the
    // bottom of everything". Every row is rendered (there is no virtualisation), so with ~200
    // programs scrollHeight is the full ~8000px: scrolling to row 40 left that condition false and
    // the window frozen at its first step. The reported symptom was exact — icons on the first
    // couple of screens, empty slots for the rest, and icons appearing again as soon as a search
    // shortened the list enough for the whole thing to sit near its own bottom.
    //
    // Rows are uniform and all present, so the scroll offset maps linearly onto a row index. Cover
    // the last row the user can currently see plus one step of lookahead, rounded to a whole step so
    // the request stays batch-aligned.
    const rowHeight = el.scrollHeight / Math.max(total, 1);
    // A zero-height layout means nothing is really on screen (jsdom, or a not-yet-measured list).
    // Bail rather than guess — the previous formula's real defect was that it read TRUE under
    // exactly these zero values, which is why its test passed while the feature did not work.
    if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;

    const lastVisibleRow = Math.ceil((el.scrollTop + el.clientHeight) / rowHeight);
    const needed = Math.min(
      total,
      Math.ceil((lastVisibleRow + ICON_WINDOW_STEP) / ICON_WINDOW_STEP) * ICON_WINDOW_STEP
    );
    if (needed > iconWindow) {
      setGrownWindow({ key: windowKey, count: needed });
    }
  };

  /**
   * The selection, keyed for comparison. The set itself holds the names VERBATIM because that is
   * what `onConfirm` hands to `addProcess`; this derived set is only for asking "is this row in".
   */
  const selectedSet = useMemo(() => new Set([...selected].map(foldName)), [selected]);

  const toggleProcess = (name: string) => {
    setSelected((prev) => {
      // Removal is by folded key, not by exact string: the row that offers the toggle may be
      // spelled differently from the entry a file pick put in (`Foo.exe` vs `foo.exe`), and an
      // exact `delete` would silently miss it and leave the program selected while the checkbox
      // showed empty.
      const key = foldName(name);
      const next = new Set([...prev].filter((n) => foldName(n) !== key));
      if (next.size === prev.size) next.add(name);
      return next;
    });
  };

  /**
   * Pick one or more programs off the disk (D-04).
   *
   * The picked files are added to the SAME `selected` set a ticked row lands in — deliberately not
   * committed here. That single detail is what makes this one door instead of two: the user can
   * pick two files, tick three running programs, and press confirm once, and every one of those
   * five additions leaves through `handleConfirm` and meets the same duplicate rule. The version
   * this replaces committed each file immediately from a second button on the card, with a second
   * duplicate check of its own — two paths that could, and did, drift apart.
   */
  const handlePickFiles = async () => {
    // A new attempt retires the previous failure, up front. Clearing only on SUCCESS meant the
    // cancel path (which returns early below) left a stale error on screen indefinitely.
    setPickError("");
    let picked: string | string[] | null;
    try {
      picked = await openFileDialog({
        multiple: true,
        filters: [{ name: "Executable", extensions: ["exe"] }],
      });
    } catch {
      // The raw failure never reaches the screen — a dialog error can carry a file system path,
      // and a path embeds the Windows user name.
      setPickError(t("routing.pickExeFileError"));
      return;
    }

    // A cancelled dialog is a no-op, not a failure: the user changed their mind, and telling them
    // something went wrong would be a lie.
    if (!picked) return;

    const paths = (Array.isArray(picked) ? picked : [picked]).filter(
      (path) => baseName(path).length > 0
    );
    const names = paths.map(baseName);
    if (names.length === 0) return;

    // Ask for each file's own icon from the path we hold RIGHT NOW, while the dialog's consent for
    // this exact file is still what we are acting on. The path is used for this one call and then
    // dropped — only the base name is kept, selected and eventually stored. A picked program is
    // usually not running, so the name-based lookup could never resolve it; without this the row
    // would sit on the neutral fallback glyph even though the real icon was one call away.
    for (let i = 0; i < paths.length; i++) {
      void resolveProcessIconForPath(paths[i], names[i]);
    }

    // Folded dedup, first spelling wins — the same ONE rule the rows use. An exact-string `Set`
    // here let `Foo.exe` and a later `foo.exe` become two rows for one program.
    setPickedFiles((prev) => dedupeFolded([...prev, ...names]));
    // Only what can actually be committed joins the selection. A picked file that is already saved
    // renders as an «добавлен» row below, and `addProcess` would refuse it anyway — counting it in
    // «Добавить выбранные (N)» would promise an addition that can never happen.
    setSelected(
      (prev) =>
        new Set(dedupeFolded([...prev, ...names.filter((n) => !alreadySet.has(foldName(n)))]))
    );
  };

  const resetVisit = () => {
    setSelected(new Set());
    setSearch("");
    setPickedFiles([]);
    setPickError("");
  };

  const handleConfirm = () => {
    onConfirm([...selected]);
    resetVisit();
  };

  const handleClose = () => {
    resetVisit();
    onClose();
  };

  return (
    // UAT-F04: render directly on the shared Modal surface. Modal already owns
    // the surface/border/radius/shadow/padding — the old nested rounded-2xl +
    // shadow-2xl + border box drew a SECOND frame (double border). We keep only
    // an inner flex column for layout (no frame of its own) and let Modal supply
    // the corner X (showCloseButton) + title. size="md" replaces the hardcoded
    // w-[420px] so the width follows the shared sizing scale.
    <Modal
      isOpen={open}
      onClose={handleClose}
      // Stays `md`. The footer carries three actions since D-04 folded the file pick
      // in here, and that briefly overflowed — but the cause was a renamed label
      // («Указать файл…» instead of the «Обзор» the card had always used), not the
      // width. With «Обзор» restored the row measures 341px of button against the
      // 378px `max-w-md` leaves, so widening the window would be an unrequested
      // change of a dialog the user already knows. Measured, not assumed.
      size="md"
      title={t("routing.selectProcesses")}
      showCloseButton
    >
      <div className="flex flex-col overflow-hidden">
        {/* Search — the shared Input primitive, same shape as the logs viewer's search field.
            The hand-rolled version this replaces positioned its own glyph absolutely, painted its
            own surface with inline input-background and input-border values, and had no clear
            affordance and no accessible name — a placeholder is a hint, not a name, so the field
            was unnameable to a screen reader. The primitive already owns the surface, the focus
            ring, the leading glyph and the clear ✕, so all of that markup went away rather than
            being re-styled. Filtering below is untouched: this is a re-skin, not a behaviour change. */}
        {/* «Найти программу» row: search among the running ones, or point at a file on disk.
            Both buttons answer the SAME question — where is the program I want — so they belong
            together, and away from the footer. «Обзор» started life in the footer beside Cancel and
            Add-selected; that was wrong. Those two are terminal verbs: they close the window, one
            keeping the work and one discarding it. «Обзор» closes nothing — it adds a row to the
            list above, exactly like typing in the search field narrows it. Grouping it with the
            terminal verbs told the user it was a third way to finish. (Owner's call, 2026-08-19.) */}
        <div className="flex items-start gap-2 pb-3">
          <div className="flex-1 min-w-0">
            <Input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("routing.searchProcess")}
              icon={<Search className="w-3.5 h-3.5" />}
              clearable
              aria-label={t("routing.searchProcess")}
              autoFocus
            />
          </div>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            icon={<FolderOpen className="w-3.5 h-3.5" />}
            onClick={handlePickFiles}
          >
            {t("routing.pickExeFile")}
          </Button>
        </div>

        {/* The file-dialog failure, inline and small, directly under the control that raised it —
            it moved up here with the button. It is a failure of ONE action, not of the list: the
            programs stay on screen and the user can carry on ticking them. It clears on the next
            «Обзор» press, including a press the user then cancels. */}
        {pickError && (
          <div
            role="alert"
            className="flex items-center gap-2 pb-3 text-xs"
            style={{ color: "var(--color-danger-fg)" }}
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{pickError}</span>
          </div>
        )}

        {/* Process list */}
        <div
          className="flex-1 overflow-y-auto -mx-2 px-2 pb-2"
          style={{ minHeight: "200px", maxHeight: "320px" }}
          onScroll={handleListScroll}
          // Named so the icon-laziness tests can drive a scroll on the element that actually
          // scrolls; there is no other stable handle on this container.
          data-process-list=""
        >
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2
                className="w-5 h-5 animate-spin"
                style={{ color: "var(--color-accent-fg)" }}
              />
            </div>
          ) : error ? (
            /* The ENUMERATION failure has its own region, and that is the entire point. Before
               this, a backend that could not enumerate anything produced an empty array, and the
               empty array fell through to «Процессы не найдены» — the picker calmly reporting that
               the machine was running no programs at all. It was telling the user the opposite of
               the truth, and it made the failure look like their problem rather than ours. Two
               distinguishable states now: nothing found, and could not look. Only the translated
               message is rendered — the raw backend error never reaches the screen.
               A file-dialog failure deliberately does NOT come through here: it does not mean the
               list is missing, so it must not take the list's place. It renders below the list
               instead, next to the button that raised it. */
            <div role="alert">
              <EmptyState
                icon={<AlertTriangle className="w-6 h-6" />}
                heading={error}
                body={t("routing.processListErrorHint")}
              />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                {t("routing.noProcessesFound")}
              </span>
            </div>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((proc, index) => {
                const isAdded = alreadySet.has(foldName(proc.name));
                const isSelected = selectedSet.has(foldName(proc.name));
                const checked = isSelected || isAdded;

                return (
                  // 21-06 (D-01): the row is a <div>, NOT a <button>. The shared
                  // Checkbox is itself a <button role="checkbox">, so nesting it
                  // inside a row <button> would be invalid HTML/a11y and break the
                  // tests' .closest("button") selectors. The Checkbox is the single
                  // interactive control; a SIBLING clickable region carries the
                  // whole-row click. Because that region is a sibling (not an
                  // ancestor) of the Checkbox, each click fires exactly one toggle
                  // — no double-fire. Selection tint + already-added muting move
                  // onto this container; behaviour is unchanged.
                  <div
                    key={proc.name}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors${
                      isAdded ? " opacity-40" : ""
                    }`}
                    style={{
                      backgroundColor: isSelected
                        ? "var(--color-accent-tint-08)"
                        : "transparent",
                    }}
                  >
                    {/* Selection indicator — shared Checkbox primitive (D-01).
                        checked = isSelected || isAdded, disabled when already
                        added; toggling runs the same toggleProcess. aria-label
                        names the icon-only control with the process name. */}
                    <Checkbox
                      checked={checked}
                      disabled={isAdded}
                      onChange={() => toggleProcess(proc.name)}
                      aria-label={proc.name}
                      className="shrink-0"
                    />

                    {/* Sibling clickable info region — preserves whole-row click
                        without nesting under the Checkbox. Guarded by isAdded so
                        already-added rows stay inert, mirroring the old disabled
                        row button. */}
                    <div
                      onClick={() => {
                        if (!isAdded) toggleProcess(proc.name);
                      }}
                      className={`flex-1 min-w-0 flex items-center gap-3${
                        isAdded ? "" : " cursor-pointer"
                      }`}
                    >
                      {/* The real Windows application icon (D-01) — this list is the one the user
                          scans to find their program, so it has to read like the Windows apps list
                          rather than a column of filenames. The Cpu glyph that used to sit here was
                          the same placeholder in every row, which told the user nothing.
                          Rows past the icon window keep an identical empty 24px box: same geometry,
                          so nothing shifts when the scroll pulls their icons in. It copies the
                          ProcessIcon plate exactly — muted fill PLUS the hairline — because the fill
                          alone disappears against any surface of the same colour, and an empty slot
                          that disappears reads as a missing icon rather than one still on its way. */}
                      {index < iconWindow ? (
                        <ProcessIcon name={proc.name} />
                      ) : (
                        <span
                          data-process-icon-deferred=""
                          className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-md)]"
                          style={{
                            width: 24,
                            height: 24,
                            backgroundColor: "var(--color-bg-hover)",
                            border: "1px solid var(--color-border)",
                          }}
                        />
                      )}

                      {/* The program's name, and nothing else. A second line rendering the full
                          image path used to sit here against a field the backend never populated;
                          it was a ready-made surface for putting `C:\Users\<name>\…` — the Windows
                          user name — on screen, which this module keeps off every other channel.
                          Removed together with the field itself, on both sides of the bridge. */}
                      <div className="flex-1 min-w-0">
                        <span
                          className="text-xs block truncate"
                          style={{ color: "var(--color-text-primary)" }}
                        >
                          {proc.name}
                        </span>
                      </div>

                      {isAdded && (
                        <span
                          className="text-xs shrink-0 px-1.5 py-0.5 rounded"
                          style={{
                            color: "var(--color-text-muted)",
                            backgroundColor: "var(--color-bg-hover)",
                          }}
                        >
                          {t("routing.alreadyAdded")}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer — the window's two TERMINAL actions and nothing else: Cancel abandons, AddSelected
            (primary, right) keeps. Border-top + top padding only; horizontal padding comes from the
            shared Modal surface (UAT-F04). «Обзор» deliberately does NOT live here — it does not end
            the window's job, it feeds the list above, so it sits in the find-a-program row at the top. */}
        <div
          className="flex items-center justify-end gap-2 pt-3 mt-1 border-t"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleClose}>
              {t("buttons.cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={selected.size === 0}
              onClick={handleConfirm}
            >
              {t("routing.addSelected")}
              {selected.size > 0 && ` (${selected.size})`}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
