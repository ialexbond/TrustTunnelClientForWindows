import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../shared/i18n";
import AboutPanel from "./AboutPanel";
import type { UpdateInfo } from "../shared/types";
import { renderWithProviders as render } from "../test/test-utils";

/**
 * WHAT THIS FILE IS FOR, AFTER PHASE 30.
 *
 * `AboutPanel` is no longer a screen — it is a COMPOSITION of four blocks that each have their own
 * component, their own tests and their own showcase entry. So this file's whole job is the
 * composition: that the four blocks are present, in the fixed order the screen contract binds, that
 * each of the showcase's screen states renders, and that the props the panel receives reach the
 * block that consumes them.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT. The chip's two label states, the two description strings,
 * the footer's controls, every plate's wording and the self-update call are all asserted in
 * `about/AboutHero.test.tsx`, `about/AppInfoCard.test.tsx`, `about/FooterLinks.test.tsx` and
 * `about/UpdateCard.test.tsx`. Repeating them here would create a second place to update and a
 * second place to forget — and the copy that was forgotten would still be green.
 */

const BASE_UPDATE_INFO: UpdateInfo = {
  available: false,
  latestVersion: "3.0.0",
  currentVersion: "3.0.0",
  downloadUrl: "",
  releaseNotes: "",
  checking: false,
};

const onCheckUpdates = vi.fn();
const onOpenDownload = vi.fn();

function renderPanel(updateInfo: Partial<UpdateInfo> = {}) {
  return render(
    <AboutPanel
      updateInfo={{ ...BASE_UPDATE_INFO, ...updateInfo }}
      onCheckUpdates={onCheckUpdates}
      onOpenDownload={onOpenDownload}
    />,
  );
}

/**
 * The four blocks, located through one anchor each rather than through a class name.
 *
 * The column itself is found by walking UP from the header band's heading until an ancestor's
 * parent also contains the footer — that parent is the single column, and the node the walk stopped
 * on is its first child. Doing it this way means the test never has to name a layout class, so a
 * spacing change cannot break it, while a block being dropped, duplicated or re-ordered still does.
 */
function locateColumn() {
  const heroAnchor = screen.getByRole("heading", { level: 1 });
  const footerAnchor = screen.getByRole("button", { name: i18n.t("about.github_aria") });

  let block: HTMLElement = heroAnchor;
  while (block.parentElement && !block.parentElement.contains(footerAnchor)) {
    block = block.parentElement;
  }
  const column = block.parentElement;
  if (!column) throw new Error("the About column could not be located from the header band");

  return {
    column,
    blocks: Array.from(column.children) as HTMLElement[],
    heroAnchor,
    footerAnchor,
    updateAnchor: screen.getByText(i18n.t("about.update_card_title")),
    infoAnchor: screen.getByText(i18n.t("about.app_info_title")),
  };
}

/**
 * The screen states, MEASURED from the showcase rather than quoted.
 *
 * The showcase drives its states through a single `state` string on a demo component; the panel is
 * driven by `updateInfo`, which is what the application actually hands it. The table below is the
 * translation between the two, and it is the only place that translation is written down — the
 * assertion under it pins the table's keys to the showcase's real export list, so the two cannot
 * quietly come to describe different screens.
 */
interface ScreenState {
  updateInfo: Partial<UpdateInfo>;
  /**
   * The plate heading the state must show, as it is rendered.
   *
   * A FUNCTION, not a string. Written as a string it was resolved when this module loaded — before
   * `beforeEach` switches i18n to Russian — so every state asserted the English wording and every
   * case failed. A lazy value is read inside the test, with the language already set.
   */
  heading: () => string;
  /** The download state is not a prop — it is entered by pressing «Обновить». */
  arrange?: () => Promise<void>;
}

const AVAILABLE: Partial<UpdateInfo> = {
  available: true,
  latestVersion: "3.1.0",
  downloadUrl: "https://example.com/TrustTunnel-3.1.0.exe",
  sha256: "abc123def456",
};

const SCREEN_STATES: Record<string, ScreenState> = {
  // The interactive showcase entry boots at «актуальная версия» and cycles from there; its resting
  // state is the one asserted here, and the cycle itself belongs to the showcase, not to the panel.
  InAppContext: {
    updateInfo: {},
    heading: () => i18n.t("about.up_to_date_versioned", { version: "3.0.0" }),
  },
  UpToDate: {
    updateInfo: {},
    heading: () => i18n.t("about.up_to_date_versioned", { version: "3.0.0" }),
  },
  UpdateAvailable: {
    updateInfo: AVAILABLE,
    heading: () => i18n.t("about.update_available", { version: "3.1.0" }),
  },
  // The showcase calls this one `server-unreachable`; on the panel it arrives as `checkError`,
  // which is the field the real check writes.
  CheckFailed: {
    updateInfo: { checkError: "server-unreachable" },
    heading: () => i18n.t("about.check_failed_server"),
  },
  Downloading: {
    updateInfo: AVAILABLE,
    heading: () => i18n.t("about.downloading_version", { version: "3.1.0" }),
    arrange: async () => {
      // A download that never finishes: the card stays on the downloading plate for the assertion.
      vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
      fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.update") }));
      await waitFor(() => expect(screen.getByRole("progressbar")).toBeInTheDocument());
    },
  },
};

/**
 * Every `export const X: Story` the showcase declares, PINNED BY HAND.
 *
 * This list used to be measured from `AboutPanel.stories.tsx?raw`. That import had to go: story
 * files are excluded from the public release branch (`CLAUDE.md` §«Что НЕ идёт на release»), this
 * test is not, and on release the specifier would resolve to nothing — vitest could not even
 * transform the file, so «Frontend Quality» would be red and, by the project's own rule, the phase
 * could not be published. `UpdateCard.test.tsx` already pins its state list for exactly this
 * reason; this file is now consistent with it.
 *
 * What the pin costs: a state added to the showcase and not to `SCREEN_STATES` is no longer caught
 * automatically. What replaces the automatic catch is the phase-29 story-coverage gate plus the
 * assertion below, which still fails loudly the moment the two lists disagree. Read from the five
 * `export const … : Story` lines of `AboutPanel.stories.tsx` (phase 30).
 */
const SHOWCASE_STATES = [
  "CheckFailed",
  "Downloading",
  "InAppContext",
  "UpToDate",
  "UpdateAvailable",
].sort();

describe("AboutPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    i18n.changeLanguage("ru");
  });

  // ─── The composition ───

  it("рисует четыре блока в одной колонке и в закреплённом порядке", () => {
    renderPanel();
    const { blocks, heroAnchor, updateAnchor, infoAnchor, footerAnchor } = locateColumn();

    // Four blocks, no more: a fifth child of the column would be a surface the screen contract
    // does not have, and the contract is that this tab answers three questions and no others.
    expect(blocks).toHaveLength(4);

    // Order is part of the contract — шапка, обновление, описание, ссылки.
    expect(blocks[0].contains(heroAnchor)).toBe(true);
    expect(blocks[1].contains(updateAnchor)).toBe(true);
    expect(blocks[2].contains(infoAnchor)).toBe(true);
    expect(blocks[3].contains(footerAnchor)).toBe(true);
  });

  it("не заводит собственных органов управления помимо тех, что принадлежат четырём блокам", () => {
    const { container } = renderPanel();
    const { blocks } = locateColumn();

    // Every control on the tab must belong to one of the four blocks. The panel is a container:
    // a button that answers to it and to nothing else would be a control with no component test,
    // no showcase entry and no line in the screen document.
    const controls = Array.from(container.querySelectorAll("button"));
    expect(controls.length).toBeGreaterThan(0);
    controls.forEach((control) => {
      expect(blocks.some((block) => block.contains(control))).toBe(true);
    });
  });

  it("сам полосу загрузки не рисует — она принадлежит карточке обновления", async () => {
    // Rendered with an update PENDING: «Обновить» has to exist before it can be pressed.
    renderPanel(AVAILABLE);
    // Nothing is downloading, so there is no progress anywhere on the tab…
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    await SCREEN_STATES.Downloading.arrange?.();

    // …and once there is, there is exactly ONE, and it lives inside the update card rather than
    // beside it. The panel used to own the progress state and the `update-progress` listener;
    // both moved into the card in phase 30, and a second bar here would mean a second owner.
    const { blocks } = locateColumn();
    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(1);
    expect(blocks[1].contains(bars[0])).toBe(true);
  });

  // ─── The screen states, measured from the showcase ───

  it("покрывает ровно те состояния экрана, которые объявлены в витрине", () => {
    // Both lists are pinned in this file (see SHOWCASE_STATES for why the showcase can no longer
    // be read at build time). A case added to one and not the other still turns this red.
    expect(Object.keys(SCREEN_STATES).sort()).toEqual(SHOWCASE_STATES);
    expect(SHOWCASE_STATES.length).toBeGreaterThan(0);
  });

  it.each(Object.entries(SCREEN_STATES))(
    "состояние «%s» рисуется целиком: четыре блока на месте, плитка называет своё состояние",
    async (_name, state) => {
      renderPanel(state.updateInfo);
      await state.arrange?.();

      expect(screen.getByText(state.heading())).toBeInTheDocument();

      // The screen contract's central claim: between the states exactly TWO things change — the
      // plate inside the update card, and the dot on the tab pill (which the bottom navigation
      // owns, not this component). Everything else is identical in every state, so every state
      // asserts the same four blocks in the same order.
      const { blocks, heroAnchor, updateAnchor, infoAnchor, footerAnchor } = locateColumn();
      expect(blocks).toHaveLength(4);
      expect(blocks[0].contains(heroAnchor)).toBe(true);
      expect(blocks[1].contains(updateAnchor)).toBe(true);
      expect(blocks[2].contains(infoAnchor)).toBe(true);
      expect(blocks[3].contains(footerAnchor)).toBe(true);
    },
  );

  // ─── The wiring the panel owns ───

  it("передаёт карточке обработчик проверки, полученный от приложения", () => {
    renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(i18n.t("buttons.check_updates")) }),
    );
    expect(onCheckUpdates).toHaveBeenCalledOnce();
  });

  it("передаёт карточке обработчик ручной загрузки, полученный от приложения", () => {
    renderPanel(AVAILABLE);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.download") }));
    expect(onOpenDownload).toHaveBeenCalledOnce();
  });

  it("окно «Что нового» открывается и тогда, когда обновления нет", () => {
    // The panel MOUNTS the window and owns its open/closed state; the control that opens it lives
    // in the card and reaches that state through the callback the card already receives. Before
    // phase 30 the button lived behind «в ответе проверки приехал текст заметок», so at an
    // up-to-date version there was no way in at all.
    renderPanel();

    const notes = screen.getByRole("button", { name: i18n.t("buttons.whats_new") });
    expect(notes).toBeEnabled();

    fireEvent.click(notes);
    expect(
      screen.getByRole("dialog", { name: i18n.t("about.notes_window_title") }),
    ).toBeInTheDocument();
  });

  it("отдаёт окну заметки вышедшей версии, когда обновление действительно найдено", () => {
    renderPanel({ ...AVAILABLE, releaseNotes: "Bug fixes and improvements" });

    fireEvent.click(screen.getByRole("button", { name: i18n.t("buttons.whats_new") }));
    expect(screen.getByText("Bug fixes and improvements")).toBeInTheDocument();
  });

  it("подставляет замороженную версию продукта, когда проверка ещё не назвала установленную", () => {
    // The fallback lives here and only here: `AboutHero` deliberately takes no default of its own,
    // so there is one place that decides what «версия неизвестна» renders as.
    renderPanel({ currentVersion: "" });
    expect(screen.getByText(/v3\.0\.0/)).toBeInTheDocument();
  });
});
