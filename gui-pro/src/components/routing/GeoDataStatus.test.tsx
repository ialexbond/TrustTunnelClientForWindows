import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import i18n from "../../shared/i18n";
import { GeoDataStatusCard } from "./GeoDataStatus";
import { GEODATA_AUTO_UPDATE_CHANGED } from "../../shared/utils/geodataAutoUpdateSignal";
import type { GeoDataStatus } from "./useRoutingState";

function makeStatus(overrides: Partial<GeoDataStatus> = {}): GeoDataStatus {
  return {
    downloaded: false,
    geoip_exists: false,
    geosite_exists: false,
    geoip_categories_count: 0,
    geosite_categories_count: 0,
    ...overrides,
  };
}

describe("GeoDataStatusCard", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let onDownload: any;

  // Phase 23: the two knobs the card now reads from the backend — whether a newer release exists and
  // whether the persisted auto-update setting is ON. Tests set them before rendering.
  let updateAvailable: boolean;
  let autoUpdateEnabled: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    i18n.changeLanguage("ru");
    onDownload = vi.fn().mockResolvedValue(undefined);
    updateAvailable = false;
    autoUpdateEnabled = true;
    // Reset the event mock per test: the WR-01 case below replaces the implementation to capture a
    // handler, and a leaked implementation would make the neighbouring tests depend on its order.
    vi.mocked(listen).mockResolvedValue(() => {});
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_geodata_updates") {
        return {
          update_available: updateAvailable,
          current_tag: null,
          latest_tag: updateAvailable ? "202607010000" : null,
        };
      }
      if (cmd === "get_geodata_auto_update") return autoUpdateEnabled;
      return null;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders without crashing", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={false} onDownload={onDownload} />);
    expect(screen.getByText("Геоданные")).toBeInTheDocument();
  });

  it("shows description text", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={false} onDownload={onDownload} />);
    expect(screen.getByText(/GeoIP и GeoSite базы/)).toBeInTheDocument();
  });

  it("shows 'Не загружено' badge when not downloaded", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={false} onDownload={onDownload} />);
    expect(screen.getByText("Не загружено")).toBeInTheDocument();
  });

  it("shows download button when not downloaded", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={false} onDownload={onDownload} />);
    expect(screen.getByText("Скачать геоданные")).toBeInTheDocument();
  });

  it("calls onDownload when download button is clicked", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={false} onDownload={onDownload} />);
    fireEvent.click(screen.getByText("Скачать геоданные"));
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  // The permanent «ЗАГРУЖЕНО» success badge is gone. It stamped the card with a shout about the
  // normal, uninteresting case, and the design showcase had specced a calm one-line indicator
  // instead since the design pass. The rest state now names who keeps the data fresh, which is the
  // fact the user actually needs.
  it("shows a calm status instead of the success badge when downloaded", async () => {
    render(
      <GeoDataStatusCard
        status={makeStatus({ downloaded: true, geoip_exists: true, geosite_exists: true })}
        downloading={false}
        onDownload={onDownload}
      />,
    );
    // The mount-time update check owns the indicator while it is in flight, so the settled state is
    // only reachable once it has resolved: auto-update ON + nothing to fetch reads «Актуально».
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Актуально")).toBeInTheDocument();
    expect(screen.queryByText("Загружено")).not.toBeInTheDocument();
  });

  /** With the switch OFF the card says so, instead of a bare «Актуально» nothing will maintain. */
  it("names the off switch in the header when auto-update is disabled", async () => {
    autoUpdateEnabled = false;
    render(
      <GeoDataStatusCard
        status={makeStatus({ downloaded: true, geoip_exists: true, geosite_exists: true })}
        downloading={false}
        onDownload={onDownload}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText("Автообновление выключено")).toBeInTheDocument();
  });

  it("shows GeoIP and GeoSite labels", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={false} onDownload={onDownload} />);
    expect(screen.getByText("GeoIP")).toBeInTheDocument();
    expect(screen.getByText("GeoSite")).toBeInTheDocument();
  });

  it("shows category counts when available", () => {
    render(
      <GeoDataStatusCard
        status={makeStatus({
          downloaded: true,
          geoip_exists: true,
          geosite_exists: true,
          geoip_categories_count: 42,
          geosite_categories_count: 100,
        })}
        downloading={false}
        onDownload={onDownload}
      />,
    );
    expect(screen.getByText("(42)")).toBeInTheDocument();
    expect(screen.getByText("(100)")).toBeInTheDocument();
  });

  /**
   * NO in-flight label may appear twice, and each belongs on the BUTTON — that is the control the
   * user pressed, so it is where they look for its state.
   *
   * Written as a sweep over EVERY in-flight state rather than an assertion about one of them,
   * because asserting one is exactly how this defect shipped twice: «Загрузка...» was de-duplicated
   * while «Проверка...» kept rendering in both places, and the single-state test stayed green.
   */
  it.each([
    ["Загрузка...", { downloading: true }],
    ["Проверка...", { downloading: false }],
  ])("names %s exactly once, on the button", async (label, { downloading }) => {
    if (label === "Проверка...") {
      // Hold the check open so the transient state is observable at all.
      vi.mocked(invoke).mockImplementation(async (cmd: string) => {
        if (cmd === "check_geodata_updates") return new Promise(() => {});
        if (cmd === "get_geodata_auto_update") return true;
        return null;
      });
    }

    render(
      <GeoDataStatusCard
        status={makeStatus({ downloaded: label === "Проверка...", geoip_exists: true, geosite_exists: true })}
        downloading={downloading}
        onDownload={onDownload}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const matches = screen.getAllByText(label);
    expect(matches).toHaveLength(1);
    expect(matches[0].closest("button")).toBeDisabled();
  });

  /**
   * ...and the settled DATA state stays visible while that action runs. The header describes the
   * data, the button describes the action; a running check must not blank the header.
   *
   * This is the over-correction that followed the duplication fix: the header was silenced wholesale
   * during in-flight states, so «Актуально» disappeared the moment the user pressed «Проверить
   * обновления» — the card lost its state line exactly when the user was looking at it.
   */
  it("keeps the settled state visible while a check runs", async () => {
    let resolveCheck: ((v: unknown) => void) | null = null;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "check_geodata_updates") {
        // First call resolves (so a settled state exists), the second is held open.
        if (resolveCheck) return new Promise((r) => { resolveCheck = r; });
        resolveCheck = () => {};
        return { update_available: false, current_tag: null, latest_tag: null };
      }
      if (cmd === "get_geodata_auto_update") return true;
      return null;
    });

    await renderCard(downloadedStatus());
    expect(screen.getByText("Актуально")).toBeInTheDocument();

    // A second check, held in flight — the header must still show the data's state.
    fireEvent.click(screen.getByText("Проверить обновления"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("Актуально")).toBeInTheDocument();
    expect(screen.getAllByText("Проверка...")).toHaveLength(1);
  });

  /**
   * A write running SOMEWHERE ELSE — the background scheduler, or another window — must LOOK like a
   * download, not like a frozen control.
   *
   * Two owner corrections are folded in here. First: the button used to stay pressable, because the
   * frontend only knew about downloads it started itself, so a click during the first background
   * cycle reached the backend, lost the one-writer race and came back as GEODATA_ALREADY_UPDATING
   * ("если процесс идёт, почему кнопка активна???"). Then, once it was merely disabled with its
   * normal label: "кнопка в Disable ушла и всё" — a greyed-out control with nothing moving reads as
   * a hang. A background download now presents exactly like a manual one.
   */
  it.each([
    ["со скачанными базами", true],
    ["без баз", false],
  ])("presents a background write as a running download (%s)", async (_case, isDownloaded) => {
    await renderCard(isDownloaded ? downloadedStatus() : makeStatus(), { busy: true });

    const btn = screen.getByText("Загрузка...").closest("button");
    expect(btn).toBeDisabled();
    fireEvent.click(btn!);
    expect(onDownload).not.toHaveBeenCalled();
  });

  /** No progress bar until the backend names a step — the button's spinner already covers "busy". */
  it("shows no progress bar before the first progress event", () => {
    render(<GeoDataStatusCard status={makeStatus()} downloading={true} onDownload={onDownload} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  /**
   * The POINT of reversing D-04: a background download must actually SHOW its progress, not merely
   * grey the button out. The words on the build that only disabled it — "кнопка в Disable
   * ушла и всё... я хотел, чтобы прям было видно, что оно обновляется, что виден прогресс".
   *
   * This is the assertion that pins the reversal: `busy` (nobody in this window started it) plus a
   * progress event from the scheduler must render the bar and name the step. Without the `busy` leg
   * in the render condition the bar only ever appeared for a download this window started, which is
   * the behaviour he rejected.
   */
  it("shows the progress bar for a download this window did not start", async () => {
    let emitProgress: ((e: { payload: unknown }) => void) | null = null;
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === "geodata-progress") {
        emitProgress = handler as unknown as (e: { payload: unknown }) => void;
      }
      return () => {};
    });

    await renderCard(makeStatus(), { busy: true });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    await act(async () => {
      emitProgress!({
        payload: {
          file: "geoip.dat",
          downloaded_bytes: 5_000_000,
          total_bytes: 18_000_000,
          percent: 28,
          step: "geoip.dat downloaded",
        },
      });
      await Promise.resolve();
    });

    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "28");
    // The step is named, so the user can see WHAT is being fetched, not just that something is.
    expect(screen.getByText("geoip.dat загружен")).toBeInTheDocument();
  });

  /**
   * ...and the last frame of a background run must not linger. The clearing effect keys off `busy`
   * as well as `downloading`; before that it only watched this window's own flag, so a scheduler
   * run left its final progress frame frozen on the card until some manual download happened to
   * clear it.
   */
  it("clears the progress frame after a background download ends", async () => {
    let emitProgress: ((e: { payload: unknown }) => void) | null = null;
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === "geodata-progress") {
        emitProgress = handler as unknown as (e: { payload: unknown }) => void;
      }
      return () => {};
    });

    const { rerender } = await renderCard(makeStatus(), { busy: true });
    await act(async () => {
      emitProgress!({
        payload: {
          file: "geosite.dat",
          downloaded_bytes: 73_000_000,
          total_bytes: 73_000_000,
          percent: 100,
          step: "Done!",
        },
      });
      await Promise.resolve();
    });
    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    // The scheduler finished: `busy` goes false and the frame is cleared on the existing 2s timer.
    rerender(
      <GeoDataStatusCard
        status={makeStatus()}
        downloading={false}
        busy={false}
        onDownload={onDownload}
      />,
    );
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  /**
   * The TIME is part of the version identity, not decoration. Upstream publishes several releases a
   * day, so a date-only label rendered an installed 202608170512 and an offered 202608171005
   * identically — the card then read «Обновить → v17.08.2026» right next to «v17.08.2026», which is
   * what made a correct offer look like a bug on a first real install.
   */
  it("shows release tag formatted as date and time", () => {
    render(
      <GeoDataStatusCard
        status={makeStatus({
          downloaded: true,
          geoip_exists: true,
          geosite_exists: true,
          release_tag: "202603260521",
        })}
        downloading={false}
        onDownload={onDownload}
      />,
    );
    expect(screen.getByText("v26.03.2026 05:21")).toBeInTheDocument();
  });

  // ─── Phase 23: the card is calm and read-only ───

  const downloadedStatus = (overrides: Partial<GeoDataStatus> = {}) =>
    makeStatus({ downloaded: true, geoip_exists: true, geosite_exists: true, ...overrides });

  /**
   * Renders and flushes the mount-time invokes (the persisted-toggle read and the update check).
   * The suite runs on fake timers, so waitFor's timer-based polling is unreliable here — the invoke
   * mock resolves immediately, so draining the microtask queue inside act() is both enough and exact.
   */
  async function renderCard(status: GeoDataStatus, extra: { busy?: boolean } = {}) {
    const result = render(
      <GeoDataStatusCard
        status={status}
        downloading={false}
        onDownload={onDownload}
        {...extra}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    return result;
  }

  it("renders no switch — the auto-update setting moved to Settings", async () => {
    await renderCard(downloadedStatus());
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });

  it("does NOT badge an available update while auto-update is on", async () => {
    updateAvailable = true;
    autoUpdateEnabled = true;
    await renderCard(downloadedStatus());
    expect(screen.queryByText("Доступно обновление")).not.toBeInTheDocument();
    // ...and says nothing else in its place: with auto-update ON a pending release is the app's
    // business, and an ambient "updating in the background" caption beside a button still offering
    // that release was noise that could read as a contradiction.
    expect(screen.queryByText("Обновляется в фоне")).not.toBeInTheDocument();
  });

  it("still badges an available update while auto-update is off", async () => {
    updateAvailable = true;
    autoUpdateEnabled = false;
    await renderCard(downloadedStatus());
    expect(screen.getByText("Доступно обновление")).toBeInTheDocument();
  });

  it("offers the manual update button even when the badge is suppressed", async () => {
    updateAvailable = true;
    autoUpdateEnabled = true;
    await renderCard(downloadedStatus());
    expect(screen.getByText(/Обновить →/)).toBeInTheDocument();
  });

  /**
   * CR-03: the card is long-lived — RoutingPanel is never unmounted (App.tsx hides inactive tab
   * panels with opacity/visibility), so a mount-only read of the persisted setting went stale the
   * moment the user flipped the switch in Settings, and the D-05 badge stayed suppressed for the
   * rest of the session.
   *
   * This renders ONCE with auto-update ON (badge correctly suppressed), then flips the backend
   * answer and fires the same broadcast GeneralSection sends after its write — without any
   * remount. Against the old mount-only effect the badge never appears and this fails.
   */
  it("re-reads the auto-update setting when Settings broadcasts a change", async () => {
    updateAvailable = true;
    autoUpdateEnabled = true;
    await renderCard(downloadedStatus());
    expect(screen.queryByText("Доступно обновление")).not.toBeInTheDocument();

    autoUpdateEnabled = false;
    await act(async () => {
      window.dispatchEvent(new Event(GEODATA_AUTO_UPDATE_CHANGED));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("Доступно обновление")).toBeInTheDocument();
  });

  /** The reverse direction: switching auto-update back ON must calm the badge again, live. */
  it("suppresses the badge again when auto-update is switched back on", async () => {
    updateAvailable = true;
    autoUpdateEnabled = false;
    await renderCard(downloadedStatus());
    expect(screen.getByText("Доступно обновление")).toBeInTheDocument();

    autoUpdateEnabled = true;
    await act(async () => {
      window.dispatchEvent(new Event(GEODATA_AUTO_UPDATE_CHANGED));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("Доступно обновление")).not.toBeInTheDocument();
  });

  /**
   * WR-01: a silent scheduler commit must not leave the card offering an update that already
   * landed. `geodata-files-changed` refreshes the status (useRoutingState) but nothing was
   * invalidating the CACHED update check, and the mount effect does not re-fire because
   * `status.downloaded` was already true — so the primary button kept saying «Обновить → vOLD»,
   * and a click on it re-downloads tens of megabytes for nothing.
   */
  /**
   * A STALE update check must never win. Committing new geodata touches three files and the fs
   * watcher emits one event per touch, so several checks run at once — and the earliest of them
   * reads the meta BEFORE the new release tag is in it. Without the sequence token, that early
   * "an update is available" answer can resolve LAST and overwrite the correct one, leaving the card
   * offering a release that is already installed. Exactly what was observed on the first real
   * install: the log showed «auto-update: updated to 202608171005» and the button still offered it.
   */
  it("ignores a stale update check that resolves after a newer one", async () => {
    let filesChanged: (() => void) | null = null;
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === "geodata-files-changed") {
        filesChanged = handler as unknown as () => void;
      }
      return () => {};
    });

    // Two checks in flight: the FIRST (stale — pre-commit meta) claims an update exists and is
    // released LAST; the second sees the committed tag and is released first.
    const releases: Array<() => void> = [];
    let call = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "get_geodata_auto_update") return Promise.resolve(true);
      if (cmd !== "check_geodata_updates") return Promise.resolve(null);
      const mine = call++;
      return new Promise((resolve) => {
        releases[mine] = () =>
          resolve(
            mine === 0
              ? { update_available: true, current_tag: "202608170512", latest_tag: "202608171005" }
              : { update_available: false, current_tag: "202608171005", latest_tag: "202608171005" },
          );
      });
    });

    render(
      <GeoDataStatusCard status={downloadedStatus()} downloading={false} onDownload={onDownload} />,
    );
    await act(async () => { await Promise.resolve(); });

    // The watcher fires again mid-flight — a second, newer check starts.
    await act(async () => {
      filesChanged!();
      // FAB-03: the listener coalesces a burst of fs events into one check, so the timer has to run
      // before anything happens. One commit produces 6-15 events; without this the card would spend
      // the unauthenticated GitHub rate limit on a single update.
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
    });

    // Newer answers first, stale lands after.
    await act(async () => {
      releases[1]?.();
      await Promise.resolve();
      releases[0]?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText(/Обновить →/)).not.toBeInTheDocument();
    expect(screen.getByText("Актуально")).toBeInTheDocument();
  });

  it("re-checks for updates when the backend reports new geodata files", async () => {
    let filesChanged: (() => void) | null = null;
    vi.mocked(listen).mockImplementation(async (event, handler) => {
      if (event === "geodata-files-changed") {
        filesChanged = handler as unknown as () => void;
      }
      return () => {};
    });

    updateAvailable = true;
    await renderCard(downloadedStatus());
    expect(screen.getByText(/Обновить →/)).toBeInTheDocument();
    expect(filesChanged).not.toBeNull();

    // The scheduler committed the release the card was offering.
    updateAvailable = false;
    await act(async () => {
      filesChanged!();
      // FAB-03: the listener coalesces a burst of fs events into one check, so the timer has to run
      // before anything happens. One commit produces 6-15 events; without this the card would spend
      // the unauthenticated GitHub rate limit on a single update.
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText(/Обновить →/)).not.toBeInTheDocument();
    expect(screen.getByText("Актуально")).toBeInTheDocument();
  });

  /**
   * There is exactly ONE settled state, «Актуально», whatever the age of the last download.
   *
   * A second «Обновлено» state used to hold for a day after each download, derived from
   * `downloaded_at`. Owner's call to drop it: two states that both mean "the data is good" is one
   * state too many, and the freshened version printed beside the indicator already says an update
   * landed. This test pins the collapse — a fresh download, an ancient one and a nonsense future
   * timestamp must all read the same.
   */
  it("has a single settled state regardless of the download age", async () => {
    for (const downloaded_at of [
      String(Date.now() - 60 * 60 * 1000), // an hour ago
      String(Date.now() - 30 * 60 * 60 * 1000), // yesterday
      String(Date.now() + 48 * 60 * 60 * 1000), // a clock that jumped backwards
    ]) {
      const { unmount } = await renderCard(downloadedStatus({ downloaded_at }));
      expect(screen.getByText("Актуально")).toBeInTheDocument();
      expect(screen.queryByText("Обновлено")).not.toBeInTheDocument();
      unmount();
    }
  });

  /**
   * Every state renders through the SAME shape — icon + label, one colour, no fill, no pill. The slot
   * briefly mixed vocabularies (a tinted pill for some states, bare text for others), which is the
   * defect this pins: one status indicator, one form, colour as the only variable.
   */
  it("renders every state through one uniform shape", async () => {
    const shapeOf = (label: string) => {
      const el = screen.getByText(label).closest("span");
      const style = el ? getComputedStyle(el) : null;
      return {
        hasIcon: !!el?.querySelector("svg"),
        // A pill would need a background and padding; a bare status line has neither.
        filled:
          !!style &&
          style.backgroundColor !== "" &&
          style.backgroundColor !== "rgba(0, 0, 0, 0)" &&
          style.backgroundColor !== "transparent",
      };
    };

    // Settled — «Актуально».
    const uptodate = await renderCard(downloadedStatus());
    expect(shapeOf("Актуально")).toEqual({ hasIcon: true, filled: false });
    uptodate.unmount();

    // Actionable — «Обновление» (auto-update off).
    updateAvailable = true;
    autoUpdateEnabled = false;
    const pending = await renderCard(downloadedStatus());
    expect(shapeOf("Доступно обновление")).toEqual({ hasIcon: true, filled: false });
    pending.unmount();

    // Paused — «Автообновление выключено».
    updateAvailable = false;
    const paused = await renderCard(downloadedStatus());
    expect(shapeOf("Автообновление выключено")).toEqual({ hasIcon: true, filled: false });
    paused.unmount();

    // Missing — «Не загружено».
    autoUpdateEnabled = true;
    const missing = await renderCard(makeStatus());
    expect(shapeOf("Не загружено")).toEqual({ hasIcon: true, filled: false });
    missing.unmount();
  });
});
