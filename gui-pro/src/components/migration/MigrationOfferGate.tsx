import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { TitleBar } from "../layout/TitleBar";
import { WindowControls } from "../layout/WindowControls";
import { MigrationOfferDialog } from "./MigrationOfferDialog";
import { MigrationFailedDialog } from "./MigrationFailedDialog";

/**
 * How long the probe is given before the gate gives up and shows the application.
 *
 * It is here because the failure it guards against is the worst one available at this seam: the
 * gate deliberately renders NOTHING while it waits, so a backend that never answers would be a
 * permanently blank window — an application that does not start, in exchange for a question almost
 * nobody is asked. Timing out into the application is the safe side: the adoption is withheld
 * rather than skipped, and the next launch asks again.
 *
 * **The bound is reachable, and this comment used to say it was not.** «One `exists()` call on a
 * marker file» describes every launch AFTER the first. On the launch this gate exists for, the
 * probe opens a registry key, canonicalises two paths, scans the legacy directory and reads every
 * `.toml` in it — on a cold disk, a redirected profile, or under an on-access scan of a folder an
 * installer has just finished writing, that can outrun this. So the timeout is a real outcome and
 * is reported as itself; see the race below.
 */
const PROBE_TIMEOUT_MS = 1500;

/**
 * What the race below settled on. Three outcomes, not two.
 *
 * `timeout` exists because folding it into `false` made «the probe ran out of time» and «there is
 * no previous version on this machine» the same answer, silently, on the one launch where the
 * difference is the user's entire server list.
 */
type ProbeResult = "offer" | "none" | "timeout";

type Phase = "checking" | "offering" | "working" | "failed" | "ready";

/**
 * Asks the migration question before the application renders anything of its own — and, crucially,
 * before the adoption behind it runs.
 *
 * **Why the gate wraps the application rather than overlaying it.** The data the offer is about is
 * the server list, the passwords and the routing rules; if the application mounted first it would
 * read an empty folder, draw an empty state, and then have the real servers appear underneath it a
 * second later. Data must be correct beneath the indicator, never popped in afterwards. Mounting
 * `children` only once the answer has been carried out makes that true by construction instead of
 * by a refresh call somebody has to remember.
 *
 * **The window chrome is drawn in every phase.** The application's own title bar is inside
 * `children`, so a gate that rendered only a dialog would leave a frameless window with no way to
 * move, minimise or close it — this window has no system frame. `TitleBar` + `WindowControls` are
 * the same components the application uses, not a copy of them.
 *
 * **Nothing is drawn while checking.** The alternative is a spinner that flashes for a few
 * milliseconds on every launch of every installation, which is worse than the blank frame React
 * already produces before it mounts.
 *
 * **A failed adoption is stated, and then does not wedge the application.** An accepted move that
 * could not be carried out raises `MigrationFailedDialog` — one screen, one action — and the
 * application starts behind it. Both halves are load-bearing: proceeding silently to `ready`, which
 * this gate did until the failure screen was added, showed the person whose data did NOT move
 * exactly what a successful move shows; and refusing to start would turn a recoverable migration
 * failure into an unusable product. The Rust side rolls its own copies back and writes no marker,
 * so the next launch retries — which is what the message tells the reader to do.
 */
export function MigrationOfferGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>("checking");

  useEffect(() => {
    // No once-guard ref here, deliberately. StrictMode runs this effect twice in development, and
    // the usual `didRun` ref combined with the `cancelled` flag below deadlocks that pair: the
    // first run's cleanup cancels the only in-flight probe, and the second run declines to start
    // another — leaving the gate stuck on `checking` forever, in development only. The probe is
    // read-only, so simply letting it run twice is both correct and cheaper than the guard.
    let cancelled = false;
    const probe: Promise<ProbeResult> = invoke<boolean>("migration_offer_pending")
      .then((pending) => (pending ? "offer" : "none"))
      .catch(() => {
        // Not on Tauri (tests, Storybook), or an older backend without the command. Either way there
        // is no offer to draw and the application must start.
        return "none" as const;
      });
    const bound = new Promise<ProbeResult>((resolve) => {
      setTimeout(() => resolve("timeout"), PROBE_TIMEOUT_MS);
    });
    void Promise.race([probe, bound]).then((result) => {
      if (cancelled) return;
      if (result === "timeout") {
        // Written down, not swallowed. The application still starts — that half was always right —
        // but a silent timeout is indistinguishable from «nothing to offer», and the two differ by
        // the user's whole server list. The line is fixed text: no path, no folder, no account.
        void invoke("write_activity_log", {
          tag: "MIGRATION",
          message: "the first-launch probe timed out; the question returns next launch",
          details: null,
        }).catch(() => {});
      }
      setPhase(result === "offer" ? "offering" : "ready");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const answer = (accept: boolean) => {
    setPhase("working");
    // Two-argument `then`, not `.catch().then()`: the two outcomes must stay mutually exclusive.
    // Chained, a throw inside the success arm would fall into the failure arm and raise the failure
    // screen over a migration that actually landed.
    void invoke<string>("resolve_migration_offer", { accept }).then(
      () => setPhase("ready"),
      (reason: unknown) => {
        if (accept) {
          // The person asked for their servers, passwords and settings to be moved and they were
          // not. Say so. Proceeding straight to `ready` here — which is what this window used to do
          // — shows them precisely what a successful move shows, which is the defect the Rust-side
          // `Err` was introduced to end; catching that `Err` and discarding it re-created it one
          // layer up.
          setPhase("failed");
          return;
        }
        // A REFUSAL that could not be written down is a different fact and must not wear the same
        // screen: nothing was copied and nothing was lost, and the only consequence is that the
        // question comes back next launch. It is recorded rather than announced.
        void invoke("write_activity_log", {
          tag: "MIGRATION",
          message: "the refusal could not be recorded; the question returns next launch",
          details: String(reason),
        }).catch(() => {});
        setPhase("ready");
      },
    );
  };

  if (phase === "ready") return <>{children}</>;
  if (phase === "checking") return null;

  return (
    <div
      className="h-screen flex flex-col"
      style={{ backgroundColor: "var(--color-bg-primary)", color: "var(--color-text-primary)" }}
    >
      <TitleBar>
        <WindowControls />
      </TitleBar>
      <div className="flex-1 flex items-center justify-center">
        {phase === "working" && (
          <div
            className="flex items-center gap-[var(--space-3)] text-sm"
            style={{ color: "var(--color-text-secondary)" }}
            role="status"
          >
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            <span>{t("migration.working")}</span>
          </div>
        )}
      </div>
      <MigrationOfferDialog
        isOpen={phase === "offering"}
        onAccept={() => answer(true)}
        onDecline={() => answer(false)}
        busy={phase !== "offering"}
      />
      <MigrationFailedDialog isOpen={phase === "failed"} onContinue={() => setPhase("ready")} />
    </div>
  );
}
