import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Globe, Download, RefreshCw, Check, AlertCircle, PauseCircle } from "lucide-react";
import { Card, Button, PanelHeader, ProgressBar } from "../../shared/ui";
import { onGeodataAutoUpdateChanged } from "../../shared/utils/geodataAutoUpdateSignal";
import type { GeoDataStatus as GeoDataStatusType } from "./useRoutingState";

interface GeoDataProgressPayload {
  file: string;
  downloaded_bytes: number;
  total_bytes: number;
  percent: number;
  step: string;
}

interface GeoUpdateCheck {
  update_available: boolean;
  current_tag: string | null;
  latest_tag: string | null;
}

interface GeoDataStatusProps {
  status: GeoDataStatusType;
  downloading: boolean;
  /**
   * A geodata write is in flight somewhere OUTSIDE this card's own action — the background
   * scheduler, or another window. `downloading` covers only the download this card started.
   *
   * Optional so existing call sites and stories keep compiling; absent behaves exactly as before.
   */
  busy?: boolean;
  onDownload: () => Promise<void>;
}

export function GeoDataStatusCard({ status, downloading, busy = false, onDownload }: GeoDataStatusProps) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<GeoDataProgressPayload | null>(null);
  const [updateCheck, setUpdateCheck] = useState<GeoUpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  // Phase 23 (D-05/D-10/D-12): the auto-update switch used to LIVE here as session-local state
  // driving a 30-minute repeating timer — a cadence that only ran while this tab was mounted, which is why
  // the databases never updated by themselves. Both are gone: the switch is now a persisted app
  // setting in Settings → Основные and the cadence is a Rust background scheduler. The card only
  // READS the setting, and for exactly one purpose — deciding whether an available update is
  // actionable enough to badge. Seeded `true` because the setting defaults ON and the read is async.
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(true);

  useEffect(() => {
    // Read from the Tauri command rather than localStorage: the Rust scheduler owns this value, and
    // a web-storage copy could be tampered with into misreporting whether updates are automatic.
    const read = () => {
      invoke<boolean>("get_geodata_auto_update").then(setAutoUpdateEnabled).catch(() => {});
    };
    read();
    // CR-03: a mount-only read goes stale here, because this card is LONG-LIVED — App.tsx keeps
    // every tab panel rendered and hides the inactive ones (opacity/visibility), so RoutingPanel is
    // never unmounted on a tab switch and the effect would run exactly once per app launch. The
    // user turning the switch OFF in Settings would then leave the card believing updates are still
    // automatic and suppressing the D-05 badge for the whole session, fixable only by a restart.
    // Re-reading on the Settings write's broadcast keeps the two in step without a poll.
    return onGeodataAutoUpdateChanged(read);
  }, []);

  // Listen for progress events
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<GeoDataProgressPayload>("geodata-progress", (event) => {
      setProgress(event.payload);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Clear progress when the download finishes — whoever started it. `busy` is in the condition
  // because a background download reports on the same channel now; without it the last progress
  // frame of a scheduler run would stay on the card until a manual download happened to clear it.
  useEffect(() => {
    if (!downloading && !busy) {
      const timer = setTimeout(() => setProgress(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [downloading, busy]);

  // A monotonically increasing token so only the NEWEST check may write state. Committing new
  // geodata touches three files (geoip.dat, geosite.dat, then the meta), and the fs watcher emits
  // one `geodata-files-changed` per touch — so several checks are in flight at once, and the
  // earliest of them reads the meta BEFORE the new release tag is in it. Without this guard the
  // stale "an update is available" answer can land last and win, leaving the card offering a
  // release that is already installed. That is exactly what was observed on the first real
  // install: the scheduler had updated to 202608171005, and the button still said «Обновить».
  const checkSeq = useRef(0);

  const checkUpdates = useCallback(async () => {
    const seq = ++checkSeq.current;
    setChecking(true);
    try {
      const result = await invoke<GeoUpdateCheck>("check_geodata_updates");
      if (seq === checkSeq.current) setUpdateCheck(result);
    } catch (e) {
      console.error("Update check failed:", e);
    } finally {
      if (seq === checkSeq.current) setChecking(false);
    }
  }, []);

  // After download completes, reset update check and re-check
  const [wasDownloading, setWasDownloading] = useState(false);
  useEffect(() => {
    if (downloading) {
      setWasDownloading(true);
    } else if (wasDownloading) {
      setWasDownloading(false);
      setUpdateCheck(null);
      // Re-check for updates after download completes
      checkUpdates();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [downloading]);

  // Check for updates on mount if already downloaded
  useEffect(() => {
    if (status.downloaded && !updateCheck && !checking) {
      checkUpdates();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.downloaded]);

  // Phase 23 (D-10): the component's own repeating update check lived here. It is deliberately NOT
  // replaced by another timer — the 24h cadence runs in the Rust scheduler, window-independent. When
  // the scheduler commits new files the fs watcher emits `geodata-files-changed`, which
  // useRoutingState already consumes to refresh the status this card renders.

  // WR-01: ...but the cached UPDATE CHECK is not part of that status, and nothing was invalidating
  // it. `updateCheck` was refreshed by exactly three things — the mount effect (gated on
  // `status.downloaded`, so it does not re-fire once the value is already `true`), the
  // post-manual-download effect, and an explicit click. So when the scheduler silently committed a
  // release while the app was open, the version tag and the calm «Обновлено» caption updated
  // correctly while the primary button went on offering «Обновить → v<old latest_tag>` for a
  // release that had already landed — and clicking it re-downloads tens of megabytes for nothing,
  // because the manual path is a deliberate force-refresh. The removed 30-minute timer used to heal
  // this within half an hour; this listener heals it immediately, and only when files actually
  // changed.
  //
  // FAB-03: coalesced, because ONE commit is 6–15 fs events. The watcher sees geoip.dat, geosite.dat
  // and the meta, each as a `.tmp` create + write + rename inside the watched directory, and an
  // un-debounced listener turns every one of them into a GitHub API call. The unauthenticated limit
  // is 60/hour: a couple of manual updates plus a background cycle can exhaust it, after which the
  // check fails and the card cannot tell "up to date" from "rate-limited". One trailing call per
  // burst is all the information there is anyway — the burst describes a single commit.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let coalesce: ReturnType<typeof setTimeout> | null = null;
    listen("geodata-files-changed", () => {
      if (coalesce) clearTimeout(coalesce);
      coalesce = setTimeout(() => {
        coalesce = null;
        setUpdateCheck(null);
        checkUpdates();
      }, 1500);
    }).then((fn) => { unlisten = fn; });
    return () => {
      if (coalesce) clearTimeout(coalesce);
      unlisten?.();
    };
  }, [checkUpdates]);

  // Translate progress step strings from Rust to i18n
  const translateStep = (step: string): string => {
    if (step === "Connecting...") return t("routing.geodata.connecting");
    if (step === "Done!") return t("routing.geodata.done");
    if (step === "Parsing categories...") return t("routing.geodata.parsing");
    if (step.includes("downloaded")) return t("routing.geodata.downloaded", { file: step.split(" ")[0] });
    if (step.includes("Retry")) return t("routing.geodata.retry");
    if (step.includes("MB")) return step;
    return step;
  };

  // Format release tag for display: "202608171005" → "17.08.2026 10:05".
  //
  // The time used to be dropped, and that single omission is what made the card look broken on the
  // first real install: upstream publishes SEVERAL releases a day, so an installed
  // 202608170512 and an available 202608171005 both rendered as a bare «v17.08.2026» — the button
  // read «Обновить → v17.08.2026» while the version beside it said v17.08.2026. Identical strings,
  // so the honest offer looked like a bug. Two releases of the same day are only distinguishable by
  // the time, so the time is part of the identity and has to be shown.
  const formatTag = (tag: string): string => {
    if (tag.length === 12) {
      const y = tag.slice(0, 4);
      const m = tag.slice(4, 6);
      const d = tag.slice(6, 8);
      const hh = tag.slice(8, 10);
      const mm = tag.slice(10, 12);
      return `${d}.${m}.${y} ${hh}:${mm}`;
    }
    return tag;
  };

  // Determine button state. The button ladder below still offers the update whenever one exists —
  // the toggle only governs the BADGE (see below), never whether the manual action is available.
  const updateOffered = status.downloaded && updateCheck?.update_available;

  // Phase 23 (D-05): the amber "attention" badge additionally requires auto-update to be OFF. With
  // it ON a newer release is not a task for the user — the app is already handling it, so shouting
  // about it would advertise a state that resolves itself. With it OFF the release genuinely is
  // actionable and the badge stays exactly as before.
  const hasUpdate = updateOffered && !autoUpdateEnabled;

  // ─── Header status indicator ────────────────────────
  //
  // ONE form for every state: an icon plus its label, both in the SAME colour, no fill, no pill, no
  // border. Colour is the only thing that varies, and it carries the meaning.
  //
  // This is the third shape this slot has had, and the reason is worth recording. It started as a
  // `Badge` («ЗАГРУЖЕНО» stamped in permanent green). Replacing that, I mixed two vocabularies at
  // once — a tinted pill for «Обновлено»/«Обновление», bare text plus a green tick for «Актуально»,
  // bare text with no icon at all for the rest — so the same slot changed its physical form
  // depending on which state it was in. Owner caught it immediately, and correctly: a status
  // indicator is one component, not a family of look-alikes. Hence `statusLine` below — states
  // cannot drift apart in form because there is only one place that renders the form.
  const statusLine = (icon: ReactNode, label: string, color: string) => (
    <span
      className="inline-flex items-center gap-1.5 text-xs shrink-0"
      style={{ color }}
    >
      {icon}
      {label}
    </span>
  );

  // RULE — a division of labour, not a priority list:
  //   the HEADER states the condition of the DATA (missing / newer release / paused / up to date);
  //   the BUTTON states the ACTION in flight («Загрузка...», «Проверка...») and owns its spinner.
  //
  // Neither ever says what the other says, so nothing is duplicated; and because the header is not
  // an action indicator, a running download or check does NOT blank it — «Актуально» stays put
  // while the button spins. Both halves of that were shipped wrong in turn: first the header
  // repeated the button's word, then (over-correcting) it went empty during the operation and the
  // state line vanished. Splitting by WHAT IS DESCRIBED rather than by which state is "louder"
  // makes both impossible.
  //
  // Only ONE data state renders, in this order — the more actionable wins over the settled.
  const headerStatus = (() => {
    // Genuinely missing data IS actionable — routing by country/service cannot work without it.
    if (!status.downloaded) {
      return statusLine(
        <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" />,
        t("routing.geodataMissing"),
        "var(--color-danger-fg)",
      );
    }
    // D-05: the "attention" state survives ONLY for auto-update OFF, where a newer release really is
    // the user's task. With the switch ON the app is already fetching it, so there is nothing to
    // advertise.
    if (hasUpdate) {
      return statusLine(
        <Download className="w-3.5 h-3.5" aria-hidden="true" />,
        t("routing.geodataUpdateAvailable", "Доступно обновление"),
        "var(--color-warning-fg)",
      );
    }
    // Auto-update OFF outranks «Актуально» here: "up to date" is the less useful of the two facts
    // when nothing will keep it that way, and this is the only place the card admits that freshness
    // is now the user's job.
    if (!autoUpdateEnabled) {
      return statusLine(
        <PauseCircle className="w-3.5 h-3.5" aria-hidden="true" />,
        t("routing.geodataAutoOff"),
        "var(--color-text-muted)",
      );
    }
    // The single settled state. A separate «Обновлено» used to sit above this one for a day after
    // each download — owner's call to drop it: two states that both mean "the data is good" is one
    // state too many, and the freshened version beside it already says an update landed.
    if (updateCheck && !updateCheck.update_available) {
      return statusLine(
        <Check className="w-3.5 h-3.5" aria-hidden="true" />,
        t("routing.geodataUpToDateShort"),
        "var(--color-success-fg)",
      );
    }
    // Nothing worth saying. An ambient «Обновляется в фоне» filler used to sit here; it was noise —
    // it stated the app's standing policy rather than anything about right now, and it could even
    // contradict the button beside it (a pending update the user could still take manually). A calm
    // card says nothing when there is nothing to say.
    return null;
  })();

  return (
    <Card padding="md">
      {/* HEADER — chip + title on the LEFT, data-condition status on the RIGHT, description under
          the title. This used to be hand-built, because the only shared header available was
          `CardHeader`, which vertically CENTRES both the glyph and the action against the whole
          title+description block: with a description long enough to wrap — this card's is — the
          globe hung in the middle of the two lines and the status ran into the wrapped description.
          `PanelHeader` (the «Настройки» card header) aligns both to the TITLE line instead, which is
          exactly what this card was hand-built to achieve, so the hand-built copy is gone and the
          whole Routing tab now shares one header with Settings. The specced rule is unchanged and
          still holds: the icon never hangs between the title and the description. */}
      <PanelHeader
        icon={<Globe className="w-4 h-4" />}
        title={t("routing.geodataTitle")}
        description={t("routing.geodataDescription")}
        action={headerStatus}
      />

      {/* Status details — PanelHeader already supplies the gap below the header, so no top margin. */}
      <div className="space-y-2 mb-3">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div
              className="w-2 h-2 rounded-full"
              style={{
                backgroundColor: status.geoip_exists
                  ? "var(--color-success-fg)"
                  : "var(--color-danger-fg)",
              }}
            />
            <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
              GeoIP
            </span>
            {status.geoip_categories_count > 0 && (
              <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                ({status.geoip_categories_count})
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className="w-2 h-2 rounded-full"
              style={{
                backgroundColor: status.geosite_exists
                  ? "var(--color-success-fg)"
                  : "var(--color-danger-fg)",
              }}
            />
            <span className="text-xs" style={{ color: "var(--color-text-secondary)" }}>
              GeoSite
            </span>
            {status.geosite_categories_count > 0 && (
              <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                ({status.geosite_categories_count})
              </span>
            )}
          </div>

          {/* Installed version, right-aligned. The calm «Обновлено» chip used to sit here beside it;
              it moved into the header status slot, where the showcase specs it and where it cannot
              be mistaken for part of the version string. */}
          {status.release_tag && (
            <span className="text-xs ml-auto" style={{ color: "var(--color-text-muted)" }}>
              v{formatTag(status.release_tag)}
            </span>
          )}
        </div>
      </div>

      {/* Progress during download — under the details, above the rule. Only once the backend has
          reported a real step: the button's own spinner covers the "something is happening" part,
          so a bar sitting at 0% with no step to name would add nothing.
          R21-03 (DEBT-RAWPRIM): the shared ProgressBar, not a hand-rolled track+fill div pair, so
          the progress carries role=progressbar + aria-value* and its styling comes from the design
          system. */}
      {(downloading || busy) && progress && (
        <div className="mb-3">
          <ProgressBar
            value={progress.percent}
            max={100}
            size="sm"
            color="accent"
            label={translateStep(progress.step)}
          />
          <p className="text-xs mt-1" style={{ color: "var(--color-text-muted)" }}>
            {translateStep(progress.step)}
          </p>
        </div>
      )}

      {/* Phase 23 (D-12): the in-card auto-update Toggle stood here. It moved to
          Settings → Основные, where an app-level setting belongs and where it is persisted — the
          card is now a read-only reflection of state plus its two manual actions. */}

      {/* Action control. Separated from the details by a rule, as the showcase specs — the card
          reads as "state above, the one thing you can do below". D-13: every manual action that
          worked before still works; only the loudness changed. */}
      <div className="mt-3 pt-3 border-t" style={{ borderColor: "var(--color-border)" }}>
        {(() => {
          // Downloading: the button stays and carries the spinner itself. The duplication the owner
          // caught was the header ALSO saying «Загрузка...» — that copy is gone, this one is the
          // real control and the place a user looks for the state of an action they started.
          if (downloading) {
            return (
              <Button variant="primary" size="sm" fullWidth loading disabled>
                {t("routing.downloading", "Загрузка...")}
              </Button>
            );
          }

          // A write is running somewhere else — the background scheduler, or another window.
          //
          // The button was first made merely DISABLED here, keeping its normal label. Shipped, that
          // read as a frozen app: the owner saw a control grey out with nothing else moving and no
          // indication anything was happening ("кнопка в Disable ушла и всё"). A multi-megabyte
          // download should look like a download, whoever started it — so this now renders exactly
          // like a manual one: spinner, «Загрузка...», and the progress bar above (which is fed by
          // the same `geodata-progress` events the scheduler now emits).
          if (busy) {
            return (
              <Button variant="primary" size="sm" fullWidth loading disabled>
                {t("routing.downloading", "Загрузка...")}
              </Button>
            );
          }

          // Not downloaded — the one genuinely urgent case, so this stays primary.
          if (!status.downloaded) {
            return (
              <Button
                variant="primary"
                size="sm"
                fullWidth
                icon={<Download className="w-3.5 h-3.5" />}
                onClick={onDownload}
              >
                {t("routing.downloadGeodata")}
              </Button>
            );
          }

          // Downloaded + update available. The button is `secondary` while auto-update is ON: the
          // app is already fetching that release on its own schedule, so a full-width primary bar
          // was asking the user to do the app's job — the exact "why is it shouting at me about
          // something it handles itself" the owner hit. With auto OFF it IS the user's job, so it
          // goes primary. The label now carries the release TIME as well as the date, because
          // upstream ships several releases a day and a bare date made this read as "update to the
          // version you already have".
          if (updateCheck?.update_available && updateCheck.latest_tag) {
            return (
              <Button
                variant={autoUpdateEnabled ? "secondary" : "primary"}
                size="sm"
                fullWidth
                icon={<Download className="w-3.5 h-3.5" />}
                onClick={onDownload}
              >
                {`${t("routing.updateGeodata")} → v${formatTag(updateCheck.latest_tag)}`}
              </Button>
            );
          }

          // Downloaded, nothing to fetch (confirmed up to date, or not checked yet). A DISABLED
          // «Актуальная версия» button used to sit in the up-to-date case — dead weight in the
          // card's only action slot, while the fact it stated now lives in the header indicator.
          // The slot keeps the action that is always meaningful instead.
          return (
            <Button
              variant="secondary"
              size="sm"
              fullWidth
              loading={checking}
              icon={<RefreshCw className="w-3.5 h-3.5" />}
              onClick={checkUpdates}
              disabled={checking}
            >
              {checking
                ? t("routing.checkingUpdates", "Проверка...")
                : t("routing.checkUpdates", "Проверить обновления")}
            </Button>
          );
        })()}
      </div>
    </Card>
  );
}
