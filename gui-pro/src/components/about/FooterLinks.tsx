import { useTranslation } from "react-i18next";
import { Compass, ExternalLink, Github } from "lucide-react";
import { open } from "@tauri-apps/plugin-shell";

/** The repository the first footer item opens. Not a link target in the DOM sense — see below. */
const REPOSITORY_URL = "https://github.com/ialexbond/TrustTunnelClient";

/**
 * The event the welcome-tour item raises.
 *
 * The application root already listens for it and mounts the tour, deliberately bypassing the
 * auto-skip that hides the tour from a user who is already configured. That is the WHOLE reason the
 * item exists: without it a configured user can never watch the introduction again, because every
 * automatic path to it is closed to them. Anyone tempted to delete this item as decoration is
 * removing the only remaining way in.
 */
const WELCOME_TOUR_EVENT = "tt-show-welcome-tour";

/**
 * The design system's accessibility focus indicator, as the shared `Button` spells it.
 *
 * Both of the row's REAL controls carry it, so a keyboard user reaches each of them and sees where
 * they are. This is the one ring the design allows: it is the focus indicator, not decoration.
 * The copyright line is not a control and therefore does not carry it — see `FOOTER_TEXT` below.
 */
const FOCUS_RING = "outline-none focus-visible:shadow-[var(--focus-ring)]";

const FOOTER_ITEM =
  `inline-flex items-center gap-[var(--space-1)] rounded-[var(--radius-sm)] px-[var(--space-1)] ` +
  `text-xs text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)] ${FOCUS_RING}`;

/**
 * The copyright line: the same size, colour and rhythm as the two items beside it, and none of
 * their affordances — no hover change, no focus ring, no control semantics.
 *
 * It is deliberately NOT `FOOTER_ITEM` minus a class. Sharing the interactive style and then
 * removing pieces of it is how a static line ends up looking pressable again after the next edit;
 * the two roles get two constants so the difference is visible at the point of use.
 */
const FOOTER_TEXT =
  `inline-flex items-center px-[var(--space-1)] text-xs text-[var(--color-text-muted)]`;

/**
 * The footer row: the repository, the welcome-tour re-trigger and the copyright.
 *
 * Ported from the story tier's own drawing of this row, which has since been deleted — the showcase
 * now renders THIS component. Before the port the row lived inline in `AboutPanel` with
 * hover-opacity feedback and no focus treatment at all.
 *
 * A ROW, NOT A CARD. Wrapping the least important block on the screen in a card would give it the
 * same visual weight as the update card, which is the block the screen exists for. It stays a
 * centred, wrapping row in the muted text alias with middle-dot separators, below the last card.
 *
 * THE TWO BEHAVIOURS THIS DESIGN MUST NOT LOSE.
 *  · The repository item opens the address in the SYSTEM BROWSER through the shell opener — it is
 *    a button, not an anchor, and the design introduces no in-app link style, so there is nothing
 *    here that could ever navigate the application window away from itself.
 *  · The welcome-tour item raises the window event described at `WELCOME_TOUR_EVENT` above.
 *
 * The copyright's year is COMPUTED, never written: a year typed into a design is wrong from the
 * first of January, and nobody is watching for it.
 *
 * NO PROPS, ON PURPOSE. Either a callback for the tour or a direct dispatch was allowed; the direct
 * dispatch is what the application already does, and it keeps the composing panel free of a prop it
 * would only forward. Nor is there a parameter that would let a caller declare which item is
 * focused: the story tier used to carry one so a state page could paint the ring, and when the
 * showcase started rendering this component the parameter was NOT copied across. A story that wants
 * the ring now focuses the real button, which is the only version of that picture that can be
 * trusted — a prop-painted ring can appear on an element that could not hold focus at all.
 */
export function FooterLinks() {
  const { t } = useTranslation();

  return (
    // `py-[var(--space-1)]` rather than the demo's `pt-` alone: the focus ring is an OUTER shadow,
    // so without room below it the ring on a focused item is clipped by the window's edge — and
    // about.md §«Подвал» binds the ring being visible IN FULL, not merely present.
    <div className="flex flex-wrap items-center justify-center gap-[var(--space-2)] py-[var(--space-1)]">
      {/* «GitHub» is the name of the service and stays as it is in every language, so the visible
          label needs no key. The ACCESSIBLE name does need one — see below. */}
      <button
        type="button"
        className={FOOTER_ITEM}
        // The visible label is a bare product name, so the accessible name has to say what pressing
        // it actually does — and that it leaves the application.
        aria-label={t("about.github_aria")}
        onClick={() => void open(REPOSITORY_URL)}
      >
        <Github className="h-3.5 w-3.5" aria-hidden="true" />
        GitHub
        <ExternalLink className="h-3 w-3 opacity-50" aria-hidden="true" />
      </button>

      <span aria-hidden="true" className="text-[var(--color-border)]">
        ·
      </span>

      <button
        type="button"
        className={FOOTER_ITEM}
        onClick={() => window.dispatchEvent(new CustomEvent(WELCOME_TOUR_EVENT))}
      >
        <Compass className="h-3.5 w-3.5" aria-hidden="true" />
        {t("about.show_welcome_tour")}
      </button>

      <span aria-hidden="true" className="text-[var(--color-border)]">
        ·
      </span>

      {/* The copyright is PLAIN TEXT, not a control.
          It shipped as a real `<button>` with no handler for one wave (D-30-19), because
          about.md §«Подвал» said all three items were «настоящие интерактивные элементы» reachable
          by Tab. Three sources gave two readings — the story tier's own comment says only TWO items
          are pressable — and the tie was broken in favour of honesty: a control that announces
          itself pressable and does nothing when pressed is a defect, and it is a worse one for a
          keyboard user than a skipped stop, because Tab landing on it and Enter doing nothing reads
          as the application being broken. So: no button semantics, not focusable, no focus ring.
          about.md §«Подвал» was corrected in the same commit to say what the screen does — two
          interactive items plus a static copyright line — rather than the reverse (D-30-22).
          The year is still read off the clock at render rather than typed. */}
      <span className={FOOTER_TEXT}>
        {t("about.copyright", { year: new Date().getFullYear() })}
      </span>
    </div>
  );
}
