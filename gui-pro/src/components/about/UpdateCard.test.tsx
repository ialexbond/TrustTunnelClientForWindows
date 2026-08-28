import { describe, it, expect, vi, beforeEach } from "vitest";
// The card's own source, as text. Vite's `?raw` suffix rather than `node:fs`:
// @types/node is not in this package's tsconfig, and `?raw` resolves the path at
// transform time so the assertion below does not depend on the runner's cwd.
import updateCardSource from "./UpdateCard.tsx?raw";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import i18n from "../../shared/i18n";
import { UpdateCard, type UpdateCardState } from "./UpdateCard";
import type { UpdateInfo } from "../../shared/types";
import { renderWithProviders as render } from "../../test/test-utils";

function makeUpdateInfo(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    available: false,
    latestVersion: "3.0.1",
    currentVersion: "3.0.0",
    downloadUrl: "",
    sha256: "",
    releaseNotes: "",
    checking: false,
    checkError: null,
    ...overrides,
  };
}

describe("UpdateCard", () => {
  // Initialized at declaration and re-created in beforeEach: `vi.fn()`'s INFERRED
  // return type is assignable to the card's `() => void` props, whereas the explicit
  // `ReturnType<typeof vi.fn>` annotation resolves through the constructor overload
  // and is not.
  let onCheck = vi.fn();
  let onOpenDownload = vi.fn();
  let onOpenChangelog = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
    onCheck = vi.fn();
    onOpenDownload = vi.fn();
    onOpenChangelog = vi.fn();
    vi.mocked(listen).mockResolvedValue(() => {});
  });

  // ─── The two failure plates (ABOUT-01 obligation 1) ───

  it("плитка no-internet называет причину словами из ru.json", () => {
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({ checkError: "no-internet" })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    expect(screen.getByText(i18n.t("about.check_failed_no_internet"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("about.check_failed_no_internet_body"))).toBeInTheDocument();
  });

  it("плитка server-unreachable называет свою причину, а не сетевую", () => {
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({ checkError: "server-unreachable" })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    expect(screen.getByText(i18n.t("about.check_failed_server"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("about.check_failed_server_body"))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("about.check_failed_no_internet"))).not.toBeInTheDocument();
  });

  it("T-30-01: неудачная проверка НЕ показывает плитку «актуальная версия»", () => {
    // The defect this phase exists to remove: a check that never succeeded used to
    // leave the card asserting the installed version was current.
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({ checkError: "no-internet" })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    expect(
      screen.queryByText(i18n.t("about.up_to_date_versioned", { version: "3.0.0" })),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("about.up_to_date"))).not.toBeInTheDocument();
  });

  // G-30-17b — the header treatment, pinned to the same shared component «Настройки» renders.
  //
  // The twin of this assertion lives in `AppInfoCard.test.tsx`, where it compares the rendered
  // chip against a real `SettingsCard`. Here the check is deliberately the cheap half: this card
  // is the one with a `description`, which is exactly where the old `CardHeader` misbehaved —
  // it centres the glyph against the whole title+description block, so the glyph floated between
  // the two lines and read as a stray square. That is what was observed.
  it("заголовок карточки рисует значок в чипе, а не голым", () => {
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({})}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    const heading = screen.getByRole("heading", { name: i18n.t("about.update_card_title") });
    const header = heading.closest("div")?.parentElement;
    const chip = header?.querySelector('span[aria-hidden="true"]');
    expect(chip).toBeTruthy();
    expect((chip as HTMLElement).className).toContain("h-7");
    expect((chip as HTMLElement).className).toContain("w-7");

    expect(updateCardSource).toContain("PanelHeader");
    expect(updateCardSource).not.toMatch(/<CardHeader/);
  });

  // G-30-16 — the regression guard for the duplicate control the owner found in UAT.
  //
  // It asserts a COUNT, not the absence of one label. Checking only that «Попробовать снова» is
  // gone would pass again the moment someone re-adds the same action under any other wording,
  // which is the mistake this card already made once: the plate's button and the header's were
  // never two actions, they were `onClick={onCheck}` twice.
  it.each(["no-internet", "server-unreachable"] as const)(
    "на плитке «%s» ровно одна кнопка запускает проверку",
    (checkError) => {
      render(
        <UpdateCard
          updateInfo={makeUpdateInfo({ checkError })}
          onCheck={onCheck}
          onOpenDownload={onOpenDownload}
          onOpenChangelog={onOpenChangelog}
        />,
      );

      // Click every button the failure state renders and count how many reach `onCheck`.
      // Whatever a second one is called, it is caught here.
      for (const button of screen.getAllByRole("button")) fireEvent.click(button);
      expect(onCheck).toHaveBeenCalledOnce();

      // And it is the header's own, permanent control — not a plate-local twin.
      onCheck.mockClear();
      fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.check_updates") }));
      expect(onCheck).toHaveBeenCalledOnce();
    },
  );

  it("повтор в полёте: занята кнопка проверки, а плитка и её текст не меняются", () => {
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({ checkError: "server-unreachable", checking: true })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    // Nothing is removed and nothing is replaced while the re-check runs — the failure the user
    // was reading stays on screen, and the ONE button involved carries the busy state.
    expect(screen.getByText(i18n.t("about.check_failed_server"))).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: i18n.t("buttons.check_updates") }),
    ).toBeDisabled();
  });

  // ─── The calm states ───

  it("плитка up-to-date называет установленную версию", () => {
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo()}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    expect(
      screen.getByText(i18n.t("about.up_to_date_versioned", { version: "3.0.0" })),
    ).toBeInTheDocument();
  });

  it("плитка checking спокойная, а кнопка проверки занята", () => {
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({ checking: true })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    expect(screen.getByText(i18n.t("about.checking_title"))).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: new RegExp(i18n.t("buttons.check_updates")) }),
    ).toBeDisabled();
  });

  it("плитка update-available даёт три действия, а кнопка проверки становится неактивной", () => {
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({
          available: true,
          downloadUrl: "https://example.com/setup.exe",
          releaseNotes: "Что-то починили",
        })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    expect(
      screen.getByText(i18n.t("about.update_available", { version: "3.0.1" })),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("buttons.update") })).toBeEnabled();
    expect(screen.getByRole("button", { name: i18n.t("buttons.download") })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.whats_new") }));
    expect(onOpenChangelog).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: new RegExp(i18n.t("buttons.check_updates")) }),
    ).toBeDisabled();
  });

  // ─── The integrity expectation still travels (T-30-03) ───

  it("«Обновить» передаёт expectedSha256 в self_update", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({
          available: true,
          downloadUrl: "https://example.com/setup.exe",
          sha256: "abc123def456",
        })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.update") }));
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("self_update", {
        downloadUrl: "https://example.com/setup.exe",
        expectedSha256: "abc123def456",
        language: expect.any(String),
        theme: expect.any(String),
      });
    });
  });

  it("во время загрузки полоса прогресса имеет роль и подпись словами", async () => {
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {})); // never settles
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({
          available: true,
          downloadUrl: "https://example.com/setup.exe",
        })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.update") }));
    await waitFor(() => {
      expect(
        screen.getByRole("progressbar", {
          name: i18n.t("about.download_progress", { percent: 0 }),
        }),
      ).toBeInTheDocument();
    });
  });

  it("«Что нового» не может остаться нажимаемой кнопкой без обработчика", () => {
    // REGRESSION. `onOpenChangelog` was declared optional while the button was rendered
    // unconditionally, so a mount that omitted it produced an enabled, focusable, screen-reader
    // announced control that did nothing — the same defect plan 30-06 removed from the footer.
    // Hiding the button is not the fix either: about.md binds «Что нового» to EVERY plate. So the
    // handler is mandatory, and this asserts the declaration rather than one render: a render only
    // proves what the current call sites happen to pass.
    const source: string = updateCardSource;
    const start: number = source.indexOf("interface UpdateCardProps {");
    expect(start).toBeGreaterThan(-1);
    const body: string = source.slice(start, source.indexOf("\n}", start));
    expect(body).toContain("onOpenChangelog: () => void;");
    expect(body).not.toContain("onOpenChangelog?:");

    // And it really is wired to the button.
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo()}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );
    const whatsNew = screen.getByRole("button", { name: i18n.t("buttons.whats_new") });
    expect(whatsNew).toBeEnabled();
    fireEvent.click(whatsNew);
    expect(onOpenChangelog).toHaveBeenCalledOnce();
  });

  // ─── The absent slot (OBL-1f / T-30-02) ───

  it("контракт карточки не имеет поля, куда мог бы попасть текст ошибки", () => {
    // Asserted on the SOURCE, not only on a render: a render proves what the current
    // call site happens to pass, while the ABSENT SLOT is the invariant. Same device
    // as the D-29 static-grep invariants in src-tauri/src/commands/updater.rs — the
    // in-repo precedent for proving an absence rather than a presence.
    const source: string = updateCardSource;
    expect(source.length, "UpdateCard.tsx source must be readable for this assertion").toBeGreaterThan(0);

    // Field-declaration lines only: comments explain the design and are allowed to
    // use these words, whereas a FIELD carrying one of them would be the slot.
    function fieldNames(interfaceName: string): string[] {
      const start: number = source.indexOf(`interface ${interfaceName} {`);
      expect(start).toBeGreaterThan(-1);
      const body: string = source.slice(start, source.indexOf("\n}", start));
      return body
        .split("\n")
        .map((line: string) => line.trim())
        .filter(
          (line: string) =>
            !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"),
        )
        .map((line: string) => /^([A-Za-z_][A-Za-z0-9_]*)\??\s*:/.exec(line)?.[1])
        .filter((name): name is string => Boolean(name));
    }

    // Anything that could carry an exception, a message, a URL, a host or a status.
    const FORBIDDEN = /error|message|detail|reason|url|host|endpoint|status|code|stack/i;

    const cardProps = fieldNames("UpdateCardProps");
    const plateShape = fieldNames("PlateShape");

    expect(cardProps.length).toBeGreaterThan(0);
    expect(plateShape.length).toBeGreaterThan(0);
    for (const name of [...cardProps, ...plateShape]) {
      expect(name, `${name} would be a slot for raw failure detail`).not.toMatch(FORBIDDEN);
    }
  });

  it("ни одна неудачная плитка не рендерит подстроку отвергнутого значения", () => {
    // The hook maps an unrecognised backend token to `server-unreachable`, so a raw
    // string cannot even reach this component — but the card is also asked to prove
    // it renders nothing but its own copy.
    const { container } = render(
      <UpdateCard
        updateInfo={makeUpdateInfo({ checkError: "no-internet" })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    const rendered = container.textContent ?? "";
    expect(rendered).not.toContain("github");
    expect(rendered).not.toContain("http");
    expect(rendered).not.toContain("403");
    expect(rendered).not.toContain("ENOTFOUND");
    // The discriminant itself is a machine token and must not be shown either.
    expect(rendered).not.toContain("no-internet");
  });

  // ─── The last successful check (about.md §Карточка обновления) ───

  /**
   * «Последняя удачная проверка: » — the line's opening, with the phrase left out.
   *
   * A FUNCTION and not a const: a const in the describe body is evaluated while the module
   * loads, which is before `beforeEach` switches i18n to Russian — it would freeze the
   * English mirror and then never match what the card renders.
   */
  function lastCheckPrefix(): string {
    return i18n.t("about.last_check", { when: "" }).trim();
  }

  /** An ISO stamp `minutes` minutes before now, for the relative line. */
  function minutesAgo(minutes: number): string {
    return new Date(Date.now() - minutes * 60_000).toISOString();
  }

  it("строка последней проверки написана относительно, а не отметкой времени", () => {
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({ lastChecked: minutesAgo(5) })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    expect(
      screen.getByText(
        i18n.t("about.last_check", { when: i18n.t("about.when_minutes", { count: 5 }) }),
      ),
    ).toBeInTheDocument();
  });

  it("неудачная проверка НЕ стирает строку последней удачной проверки", () => {
    // The honesty rule of the two failure plates: what the app knew before is still
    // true, and keeping the older moment is more useful than showing emptiness.
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({ checkError: "no-internet", lastChecked: minutesAgo(5) })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    expect(
      screen.getByText(
        i18n.t("about.last_check", { when: i18n.t("about.when_minutes", { count: 5 }) }),
      ),
    ).toBeInTheDocument();
    // …and the plate still names the cause, so the two facts sit side by side.
    expect(screen.getByText(i18n.t("about.check_failed_no_internet"))).toBeInTheDocument();
  });

  it("проверок ещё не было — строки нет вовсе, ни прочерка, ни заглушки", () => {
    const { container } = render(
      <UpdateCard
        updateInfo={makeUpdateInfo({ lastChecked: null })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    expect(container.textContent ?? "").not.toContain(lastCheckPrefix());
  });

  it("плитка и строка последней проверки — ОДНА вежливая живая область", () => {
    const { container } = render(
      <UpdateCard
        updateInfo={makeUpdateInfo({ lastChecked: minutesAgo(5) })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    // One region, not two: a reader has to hear «проверяем → результат» and
    // «неудача → повтор» in order, and two regions would announce them apart.
    const regions = container.querySelectorAll("[aria-live]");
    expect(regions).toHaveLength(1);
    const region = regions[0];
    expect(region.getAttribute("aria-live")).toBe("polite");
    const spoken = region.textContent ?? "";
    expect(spoken).toContain(i18n.t("about.up_to_date_versioned", { version: "3.0.0" }));
    expect(spoken).toContain(lastCheckPrefix());
  });

  // ─── The retry adds no new state (about.md, retry-in-flight) ───

  it("во время повтора плитка стоит на месте целиком, занята только кнопка проверки", () => {
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({
          checkError: "server-unreachable",
          checking: true,
          lastChecked: minutesAgo(5),
        })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    // The failure heading, its body and the last-check line all stay exactly as they
    // were — the retry is not a sixth outcome, so nothing on the plate is replaced.
    expect(screen.getByText(i18n.t("about.check_failed_server"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("about.check_failed_server_body"))).toBeInTheDocument();
    expect(
      screen.getByText(
        i18n.t("about.last_check", { when: i18n.t("about.when_minutes", { count: 5 }) }),
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: i18n.t("buttons.check_updates") }),
    ).toBeDisabled();
  });

  // «Что нового» is the ONLY action a failure plate offers, and it is not a second way to check —
  // it opens the notes for the version already installed. Pinning it here keeps the G-30-16 count
  // test above honest: that one proves no second CHECK exists, this one proves the plate was not
  // stripped bare in the process.
  it("неудачная плитка сохраняет «Что нового» и не предлагает ничего, что качает", () => {
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({ checkError: "no-internet" })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.whats_new") }));
    expect(onOpenChangelog).toHaveBeenCalledOnce();

    // Nothing to download on a check that never produced a version.
    expect(
      screen.queryByRole("button", { name: i18n.t("buttons.update") }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: i18n.t("buttons.download") }),
    ).not.toBeInTheDocument();
  });

  it("во время загрузки кнопка проверки неактивна — проверять уже нечего", async () => {
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {})); // never settles
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({
          available: true,
          downloadUrl: "https://example.com/setup.exe",
        })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.update") }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: new RegExp(i18n.t("buttons.check_updates")) }),
      ).toBeDisabled();
    });
  });

  it("фоновая проверка во время загрузки не убирает полосу и не возвращает «Обновить»", async () => {
    // REGRESSION. `checking` used to outrank `updating` in deriveState, and the 24h background
    // timer in useUpdateChecker fires regardless of what the card is doing. Mid-download the plate
    // switched to «Проверяем обновления…», the progress bar vanished while an elevated installer
    // was being fetched, and a check that came back with available:true left «Обновить» enabled
    // again — a second press would have started a second self_update.
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {})); // download never settles
    const downloading = makeUpdateInfo({
      available: true,
      downloadUrl: "https://example.com/setup.exe",
    });
    const { rerender } = render(
      <UpdateCard
        updateInfo={downloading}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.update") }));
    await waitFor(() => expect(screen.getByRole("progressbar")).toBeInTheDocument());

    // The background check starts…
    rerender(
      <UpdateCard
        updateInfo={{ ...downloading, checking: true }}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("buttons.update") })).toBeDisabled();

    // …and comes back saying an update is available, which is exactly what re-enabled the button.
    rerender(
      <UpdateCard
        updateInfo={{ ...downloading, checking: false, latestVersion: "3.2.0" }}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: i18n.t("buttons.update") })).toBeDisabled();
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });

  it("self_update, который вернулся вместо того чтобы завершить процесс, не оставляет карточку замороженной", async () => {
    // REGRESSION. `updating` was cleared only in the catch, on the unstated assumption that
    // self_update always ends the process. If it ever resolves instead, the card stayed on
    // «Скачиваем…» with every control held — no progress, no way back, until the app is restarted.
    vi.mocked(invoke).mockResolvedValue(undefined);
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({
          available: true,
          latestVersion: "3.1.0",
          downloadUrl: "https://example.com/setup.exe",
        })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.update") }));

    await waitFor(() => {
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });
    // Back on the update-available plate, with its own actions live again. (The header's check
    // button stays disabled there by design — «проверять больше нечего» — so it is not asserted.)
    expect(screen.getByRole("button", { name: i18n.t("buttons.update") })).toBeEnabled();
    expect(screen.getByRole("button", { name: i18n.t("buttons.download") })).toBeEnabled();
    expect(
      screen.getByText(i18n.t("about.update_available", { version: "3.1.0" })),
    ).toBeInTheDocument();
  });

  // ─── The failed self-update names a cause, never a payload (S2) ───
  //
  // THE SECOND ROUTE TO THE SCREEN. T-30-02 and the hygiene gate's rule 3 both measured the failure
  // PLATE — `PlateShape` has no field able to hold an error string, and `UpdateCardProps` exposes no
  // slot for one. Neither watched the snackbar the card raises from its own catch arm, and that arm
  // was `pushSnack(formatError(e), "error")`. `formatError` returns `e.message` verbatim, and
  // `self_update` rejects with rendered strings — «Download failed: {e}», «Cannot determine exe
  // path: {e}», «Download HTTP error: {status}». So a filesystem path, a URL or an HTTP status
  // reached the user while the two rules covering the card reported PASS.
  //
  // These tests are RENDERED rather than asserted on the source, for the same reason T-30-17 was
  // rewritten that way: what matters is what appears on screen, and an assertion about the code that
  // produces it can be true while the property it claims is false.

  /**
   * Press «Обновить» against a `self_update` that rejects with `rejection`, and wait until
   * `expectedMessage` is actually on screen.
   *
   * WAITING FOR THE MESSAGE, NOT FOR THE PLATE. The first version of this helper waited for the
   * progress bar to disappear — which is true BEFORE the click as well, so `waitFor` returned
   * immediately and the absence assertions ran before the rejection had been handled. A test that
   * inspects the screen before the thing it is testing has rendered proves nothing, and it does it
   * intermittently, which is worse than failing.
   *
   * The wait is also what makes the absence assertions meaningful: they run at the one moment the
   * snackbar IS up, which is the only moment a leak could be visible.
   */
  async function failingSelfUpdate(rejection: unknown, expectedMessage: string) {
    vi.mocked(invoke).mockRejectedValue(rejection);
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({
          available: true,
          latestVersion: "3.1.0",
          downloadUrl: "https://example.com/setup.exe",
        })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.update") }));
    await screen.findByText(expectedMessage);
    // The WHOLE document, not the render container: the snackbar is free to portal out of it, and
    // scoping the scan to the container would let a leak sit one node outside it and still report
    // clean. `document.body` is the surface the user actually looks at.
    return document.body.textContent ?? "";
  }

  it("отказ self_update не выносит на экран ни пути, ни адреса, ни кода ответа", async () => {
    // The real rejection shape, verbatim from `updater.rs`: a Windows path inside a rendered
    // message. Everything in it that must not appear is asserted by ITS OWN text, so a future
    // rewording of the wrapper cannot make the test vacuous.
    const onScreen = await failingSelfUpdate(
      new Error(
        "Download failed: C:\\Users\\tester\\AppData\\Local\\Temp\\tt_update_9f2\\setup.exe",
      ),
      i18n.t("about.update_failed"),
    );

    expect(onScreen).not.toContain("C:\\");
    expect(onScreen).not.toContain("AppData");
    expect(onScreen).not.toContain("Download failed");
    expect(onScreen).not.toContain("tt_update");
  });

  it("HTTP-статус из отказа self_update на экран не попадает", async () => {
    const onScreen = await failingSelfUpdate(
      new Error("Download HTTP error: 403 Forbidden"),
      i18n.t("about.update_failed"),
    );

    expect(onScreen).not.toContain("403");
    expect(onScreen).not.toContain("Forbidden");
    expect(onScreen).not.toContain("HTTP");
  });

  it("нарушение целостности названо своей причиной, а не общей", async () => {
    // Tauri rejects an `invoke` with the backend's `Err` string itself, not with an Error — hence
    // a bare string here. The distinction earns its own line: the download finished and did NOT
    // match what the release published, so «попробуйте позже» would be the wrong advice.
    const onScreen = await failingSelfUpdate(
      "UPDATE_CHECKSUM_MISMATCH",
      i18n.t("about.update_failed_integrity"),
    );

    expect(onScreen).not.toContain("UPDATE_CHECKSUM");
    expect(onScreen).not.toContain(i18n.t("about.update_failed"));
  });

  it("неизвестный код отказа не проходит насквозь, а сводится к общей причине", async () => {
    // The no-passthrough property, stated over a token the front end has never heard of. This is
    // what stops a future backend string — a stack trace, a hostname, a status line — from becoming
    // the text the snackbar renders.
    const onScreen = await failingSelfUpdate(
      "SOME_FUTURE_BACKEND_TOKEN_WITH_A_HOST_api.github.com",
      i18n.t("about.update_failed"),
    );

    expect(onScreen).not.toContain("api.github.com");
    expect(onScreen).not.toContain("SOME_FUTURE_BACKEND_TOKEN");
  });

  // ─── The reserved auto-update area (ABOUT-01 prohibition / T-30-12) ───

  it("зарезервированное место «Обновлять автоматически» не рисует НИ ОДНОГО элемента управления", () => {
    // Asked by ROLE rather than by a source grep: a toggle added by any means at all —
    // Switch, a bare <input type="checkbox">, a div with role="switch" — is caught here,
    // where a grep for one component name would miss the other two. A disabled control
    // with a «скоро» caption is the app promising a capability it does not have.
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({ lastChecked: minutesAgo(5) })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  // ─── EDGE: idempotency of the check button ───

  it("две проверки подряд вызывают обработчик дважды и не оставляют кнопку залипшей", () => {
    render(
      <UpdateCard
        updateInfo={makeUpdateInfo({ lastChecked: minutesAgo(5) })}
        onCheck={onCheck}
        onOpenDownload={onOpenDownload}
        onOpenChangelog={onOpenChangelog}
      />,
    );

    const check = screen.getByRole("button", {
      name: new RegExp(i18n.t("buttons.check_updates")),
    });
    fireEvent.click(check);
    fireEvent.click(check);

    expect(onCheck).toHaveBeenCalledTimes(2);
    // The busy affordance is DERIVED from `updateInfo.checking`, never stored here, so a
    // second press cannot leave a spinner running against a card that is at rest.
    expect(check).toBeEnabled();
  });

  // ─── Every state renders from the one shell ───

  /**
   * One recipe per card state. A `Record<UpdateCardState, …>` on purpose: an eighth state
   * added to the union makes THIS FILE fail to compile, where an array would have gone on
   * passing while silently covering six of seven.
   */
  const STATE_FIXTURES: Record<
    UpdateCardState,
    { info: Partial<UpdateInfo>; startDownload?: boolean }
  > = {
    checking: { info: { checking: true } },
    "up-to-date": { info: {} },
    "update-available": {
      info: { available: true, downloadUrl: "https://example.com/setup.exe" },
    },
    "no-internet": { info: { checkError: "no-internet" } },
    "server-unreachable": { info: { checkError: "server-unreachable" } },
    "retry-in-flight": { info: { checkError: "server-unreachable", checking: true } },
    downloading: {
      info: { available: true, downloadUrl: "https://example.com/setup.exe" },
      startDownload: true,
    },
  };

  it("все состояния карточки рисуются одной и той же оболочкой", async () => {
    // SEVEN — measured from UpdateCard.stories.tsx this phase: eight exports, minus
    // «В приложении (контекст)», which is the interactive card inside the in-app frame
    // rather than a state of its own. Counted from the story exports, not quoted from a
    // planning document. The stories file itself is NOT imported here: it is excluded
    // from the release branch, and a test that stays on release may not depend on it.
    expect(Object.keys(STATE_FIXTURES)).toHaveLength(7);

    vi.mocked(invoke).mockImplementation(() => new Promise(() => {})); // download never settles

    for (const [state, fixture] of Object.entries(STATE_FIXTURES)) {
      const { container, unmount } = render(
        <UpdateCard
          updateInfo={makeUpdateInfo({ lastChecked: minutesAgo(5), ...fixture.info })}
          onCheck={onCheck}
          onOpenDownload={onOpenDownload}
          onOpenChangelog={onOpenChangelog}
        />,
      );

      if (fixture.startDownload) {
        fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.update") }));
        await waitFor(() => {
          expect(screen.getByRole("progressbar")).toBeInTheDocument();
        });
      }

      // Every state shows the header, exactly one live region and a non-empty plate.
      expect(screen.getByText(i18n.t("about.update_card_title")), state).toBeInTheDocument();
      expect(container.querySelectorAll("[aria-live]"), state).toHaveLength(1);
      expect((container.textContent ?? "").length, state).toBeGreaterThan(0);

      unmount();
    }
  });
});
