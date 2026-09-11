import { useTranslation } from "react-i18next";
import { AppWindow } from "lucide-react";
import { Skeleton } from "../../shared/ui";
import { useProcessIcon } from "./useProcessIcons";

interface ProcessIconProps {
  /** Process name exactly as the user stored it — the backend compares case-insensitively. */
  name: string;
  /** Slot edge in px. The default matches the icon slot the picker rows already draw. */
  size?: number;
}

/**
 * The application-icon slot for a process row (D-01).
 *
 * Three states, one geometry. The wrapper keeps its size in every state so a row never reflows as
 * icons fill in — a list that jumps while it loads is worse than a list with no icons at all:
 *
 *   • unresolved yet → a Skeleton, because the backend has to open the process and ask the shell;
 *   • resolved       → the real Windows icon as an `<img>` with an EMPTY alt: the row already
 *                      spells the process name in text next to it, so announcing it twice is noise;
 *   • unresolvable   → a neutral Lucide glyph in the muted token colour (D-03). Deliberately NOT a
 *                      letter avatar: the project runs one icon family (Lucide), and a letter tile
 *                      would introduce a second visual idiom right next to real application
 *                      artwork. Protected, elevated and hand-typed entries land here by design.
 *
 * ONLY TWO OF THE THREE STATES DRAW A TILE. The muted plate (and the rounded clip that goes with it)
 * belongs to the states that have nothing of their own to show. A resolved icon gets neither, and
 * that is the fix for what the plate actually did: Windows artwork carries its own silhouette and
 * its own transparent margin, so the plate showed THROUGH that margin as a grey square the real icon
 * appeared to be stuck onto, and the rounded clip shaved the corners off square icons. The plate
 * stays exactly where it earns its keep — under the Skeleton, which needs a ground to be visible at
 * all, and under the fallback glyph, where the plate IS the placeholder for a program with no icon.
 * (Owner's call, 2026-08-26: «если есть иконка — нашу заглушку убирать».)
 *
 * THE PLATE CARRIES A HAIRLINE, and that is not decoration. The saved list stripes its rows with the
 * SAME muted token the plate is filled with, so on every other row the plate had exactly the colour
 * of the surface behind it and vanished — the fallback glyph floated with no slot around it, and the
 * picker's not-yet-requested rows (which draw the same plate with nothing inside) read as an empty
 * gap rather than a slot waiting for its icon. A fill alone cannot survive a background that happens
 * to match it; the border can, because it is drawn ON TOP of whatever is behind. It is the app's own
 * hairline token, so nothing new is introduced.
 *
 * The wrapper keeps its width and height in every state regardless — the border sits inside the box
 * (the global border-box rule), so neither dropping the plate nor adding the hairline moves anything:
 * a row still never reflows when an icon lands.
 *
 * WHERE THE VALUE COMES FROM. The component no longer fetches for itself. It declares the name it
 * needs to the shared session cache (`useProcessIcons`) and renders whatever that cache currently
 * knows. The rendered contract above is unchanged — only the plumbing moved. It had to move: this
 * same component now draws every row of a picker that can list ~200 processes, and one command per
 * row would have made a single scroll into a request storm. The hook owns the batching, the
 * debounce, the in-flight de-duplication and the negative cache; this file owns only the picture.
 */
export function ProcessIcon({ name, size = 24 }: ProcessIconProps) {
  const { t } = useTranslation();
  // undefined = still asking, string = resolved data URL, null = give up and show the glyph.
  const icon: string | null | undefined = useProcessIcon(name);

  const state =
    icon === undefined ? "pending" : icon === null ? "unavailable" : "resolved";

  // The tile belongs to the two states that draw nothing of their own — see the note above.
  const hasTile = state !== "resolved";

  return (
    <span
      // data-process-icon is the state hook the tests query: jsdom loads no Tailwind, so asserting
      // on appearance would prove nothing, but which BRANCH rendered is a real, checkable fact.
      data-process-icon={state}
      className={`inline-flex shrink-0 items-center justify-center${
        hasTile ? " overflow-hidden rounded-[var(--radius-md)]" : ""
      }`}
      style={{
        width: size,
        height: size,
        backgroundColor: hasTile ? "var(--color-bg-hover)" : "transparent",
        // Keeps the slot legible where the row behind it shares the plate's colour — see above.
        border: hasTile ? "1px solid var(--color-border)" : "none",
      }}
    >
      {icon === undefined ? (
        <Skeleton variant="card" width={size} height={size} />
      ) : icon === null ? (
        <AppWindow
          className="h-3.5 w-3.5"
          style={{ color: "var(--color-text-muted)" }}
          role="img"
          aria-label={t("routing.iconUnavailable")}
        />
      ) : (
        <img
          src={icon}
          alt=""
          width={size}
          height={size}
          className="h-full w-full object-contain"
        />
      )}
    </span>
  );
}
