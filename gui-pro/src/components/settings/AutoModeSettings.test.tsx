// AutoModeSettings — behaviour + a11y tests for the Phase-27 failover design (plan 28-08).
//
// WHY NEARLY EVERY STRING IN THIS FILE MOVED: the card used to promise «автоподключение к лучшему
// серверу» and offered three numeric knobs to tune the latency engine behind it. 27 D-06/D-07
// replaced that promise with failover — switch when the connection is LOST — and 28-02/28-03 moved
// the decision into Rust. So the copy, the controls and the selectors are all new. What is NOT new
// is the accessibility behaviour: the keyboard reorder, its focus-follow, the live region and the
// drag-lock guards are carried over verbatim, and those are the ones this file guards hardest,
// because a rewrite is exactly how such work gets lost.
//
// Assertions are on visible Russian copy, roles and accessible names — never on CSS classes.
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { AutoModeSettings } from "./AutoModeSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

/** The copy the card renders, hoisted so a wording change lands in one place. */
const FAILOVER_LABEL = "Переключаться на другой сервер при потере связи";
const ORDER_LABEL = "Порядок переключения";
const LIST_ARIA = "Порядок переключения серверов";
const participate = (name: string) => `Использовать ${name}`;

const liveConfigs = [
  { id: "cfg-a", name: "Config A", host: "a.example.com", display_host: "a.example.com", user: "u", path: "/a", order: 0, last_used: true },
  { id: "cfg-b", name: "Config B", host: "b.example.com", display_host: "b.example.com", user: "u", path: "/b", order: 1, last_used: false },
  { id: "cfg-c", name: "Config C", host: "c.example.com", display_host: "c.example.com", user: "u", path: "/c", order: 2, last_used: false },
];

/** Master persisted ON — the state in which the nested panel exists at all. */
function masterOn() {
  localStorage.setItem("tt_auto_switch_enabled", "true");
}

/** Wait for the queue to be on screen with `expected` rows in it. */
async function findList(expected = 3) {
  const list = await screen.findByRole("list", { name: LIST_ARIA });
  await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(expected));
  return list;
}

beforeEach(() => {
  vi.clearAllMocks();
  i18n.changeLanguage("ru");
  localStorage.clear();
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "list_configs") return liveConfigs;
    if (cmd === "reorder_configs") return liveConfigs;
    return null;
  });
});

describe("AutoModeSettings — the failover promise", () => {
  // 27 D-06: the master toggle now describes what the app actually does. The old label promised a
  // move to «лучший сервер» on high latency — a promise the Rust trigger does not make, because it
  // measures nothing and reacts only to a lost tunnel.
  it("describes failover, and says nothing about speed or ping", async () => {
    render(<AutoModeSettings />);
    await screen.findByText("Авто-режим");

    expect(screen.getByRole("switch", { name: FAILOVER_LABEL })).toBeInTheDocument();
    expect(
      screen.getByText(/приложение один раз попробует переподключиться к текущему серверу/i),
    ).toBeInTheDocument();

    // The retired vocabulary must be gone from the card entirely, label AND description.
    expect(screen.queryByText(/лучшему серверу/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/высокой задержк/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/низким пингом/i)).not.toBeInTheDocument();
  });

  // The «?» carries the two things the row cannot say in one line: nothing is measured, and there is
  // no automatic return. It is a real focusable button with an accessible name (28-04's contract).
  it("gives the master row a named «?» whose text names both limits", async () => {
    render(<AutoModeSettings />);
    await screen.findByText("Авто-режим");

    const hint = screen.getByRole("button", { name: `Подробнее: ${FAILOVER_LABEL}` });
    // The Tab keydown is not decoration. A bare `focus` event is what a window returning from the
    // tray fires at the element it had focused, and `Tooltip` refuses to open a tip for a focus no
    // input in this document could have caused (G-32-16 round three). Pressing Tab is what makes
    // this a keyboard user rather than a window coming back.
    fireEvent.keyDown(document.body, { key: "Tab" });
    fireEvent.focus(hint);
    expect(await screen.findByText(/скорость и пинг не измеряются/i)).toBeInTheDocument();
    expect(screen.getByText(/само не возвращается/i)).toBeInTheDocument();
  });

  // 27 D-07: three numeric preferences removed. The negative assertion names where they went.
  it("renders no numeric parameter input anywhere (27 D-07 removed all three)", async () => {
    masterOn();
    render(<AutoModeSettings />);
    await findList();

    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Порог задержки, мс")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Интервал проверки, сек")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Сколько проверок подряд")).not.toBeInTheDocument();
  });
});

describe("AutoModeSettings — the nested panel", () => {
  // The design is explicit that OFF means absent, not present-and-greyed: a panel of controls that
  // cannot act is noise. Asserted as an absence of the panel's own heading and of the list.
  it("keeps the panel out of the markup while the master is off", async () => {
    render(<AutoModeSettings />);
    await screen.findByText("Авто-режим");

    expect(screen.queryByText(ORDER_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: LIST_ARIA })).not.toBeInTheDocument();
    // The two settings beneath it stay.
    expect(screen.getByRole("switch", { name: "Автоподключение при запуске" })).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Уведомления о состоянии подключения" }),
    ).toBeInTheDocument();
  });

  it("brings the panel in when the master is switched on", async () => {
    render(<AutoModeSettings />);
    await screen.findByText("Авто-режим");
    fireEvent.click(screen.getByRole("switch", { name: FAILOVER_LABEL }));

    expect(await screen.findByText(ORDER_LABEL)).toBeInTheDocument();
    await findList();
  });

  // WR-02 preserved: list_configs returns last-used-first, the queue must show manifest order.
  it("orders rows by the manifest, not by last-used", async () => {
    const lastUsedFirst = [
      { ...liveConfigs[2], last_used: true },
      { ...liveConfigs[0], last_used: false },
      liveConfigs[1],
    ];
    masterOn();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return lastUsedFirst;
      return null;
    });

    render(<AutoModeSettings />);
    const list = await findList();
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Config A");
    expect(rows[1]).toHaveTextContent("Config B");
    expect(rows[2]).toHaveTextContent("Config C");
  });

  // WR-01 preserved: useConfigList starts empty, so a naive useState seed leaves the list blank
  // forever when the master is already on at mount.
  it("seeds the order from a list that arrives after mount", async () => {
    masterOn();
    let resolveList: (v: typeof liveConfigs) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs")
        return new Promise<typeof liveConfigs>((res) => {
          resolveList = res;
        });
      return null;
    });

    render(<AutoModeSettings />);
    await screen.findByText("Авто-режим");
    resolveList(liveConfigs);
    await findList();
  });

  // The panel is drawn by InsetPanel's fill and outline. The left accent rail it replaces is an
  // owner-banned emphasis device, so its absence is asserted rather than assumed.
  it("carries no left accent rail", async () => {
    masterOn();
    const { container } = render(<AutoModeSettings />);
    await findList();
    expect(container.querySelector('[class*="border-l-"]')).toBeNull();
  });
});

// WR-02 (Phase-28 review). `set_failover_settings` is what actually arms the Rust monitor, and its
// refusal used to be swallowed: the card read ON while `app_settings.json` read OFF, so failover
// was dead for the whole session with nothing on screen saying why — the «оно просто не
// переключается» failure `useAppSettings`'s own doc-comment says it exists to prevent.
describe("AutoModeSettings — a refused failover write is not silent", () => {
  /** Rust refuses set_failover_settings and reports the master as still OFF. */
  function refuseFailoverWrite() {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return liveConfigs;
      if (cmd === "set_failover_settings") throw new Error("disk full");
      if (cmd === "get_failover_settings") return { enabled: false, excluded_ids: [] };
      return null;
    });
  }

  it("reports the refusal and puts the master toggle back on Rust's value", async () => {
    const onSaveFailed = vi.fn();
    refuseFailoverWrite();
    render(<AutoModeSettings onSaveFailed={onSaveFailed} />);
    await screen.findByText("Авто-режим");

    const master = screen.getByRole("switch", { name: FAILOVER_LABEL });
    fireEvent.click(master);

    await waitFor(() => expect(onSaveFailed).toHaveBeenCalled());
    // Reverted onto what the app REPORTS (the `revertTo` shape), not onto a local inversion.
    await waitFor(() => expect(master).not.toBeChecked());
    // …and the localStorage the rest of the app reads follows, so a re-mount cannot resurrect
    // the phantom ON.
    expect(localStorage.getItem("tt_auto_switch_enabled")).toBe("false");
  });

  it("reports a refused participation change too", async () => {
    const onSaveFailed = vi.fn();
    masterOn();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return liveConfigs;
      if (cmd === "set_failover_settings") throw new Error("disk full");
      if (cmd === "get_failover_settings") return { enabled: true, excluded_ids: [] };
      return null;
    });
    render(<AutoModeSettings onSaveFailed={onSaveFailed} />);
    await findList();

    fireEvent.click(screen.getByRole("switch", { name: participate("Config B") }));

    await waitFor(() => expect(onSaveFailed).toHaveBeenCalled());
    // Rust still has nobody excluded, so the row goes back to participating.
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: participate("Config B") })).toBeChecked(),
    );
  });

  it("stays silent when the write succeeds", async () => {
    const onSaveFailed = vi.fn();
    render(<AutoModeSettings onSaveFailed={onSaveFailed} />);
    await screen.findByText("Авто-режим");

    fireEvent.click(screen.getByRole("switch", { name: FAILOVER_LABEL }));
    await findList();
    expect(onSaveFailed).not.toHaveBeenCalled();
  });
});

describe("AutoModeSettings — participation", () => {
  it("gives every row a participation switch that names its server", async () => {
    masterOn();
    render(<AutoModeSettings />);
    await findList();

    for (const cfg of liveConfigs) {
      expect(screen.getByRole("switch", { name: participate(cfg.name) })).toBeChecked();
    }
  });

  // The rule the design states twice: excluding a server must not move its row. Moving it would make
  // the user hunt for a row they only meant to switch off.
  it("leaves the row where it is and renumbers the participating rows", async () => {
    masterOn();
    render(<AutoModeSettings />);
    const list = await findList();

    fireEvent.click(screen.getByRole("switch", { name: participate("Config B") }));

    await waitFor(() => {
      const rows = within(list).getAllByRole("listitem");
      expect(rows[1]).toHaveTextContent("Config B"); // did not move
      expect(rows[0]).toHaveTextContent("1");
      expect(rows[1]).toHaveTextContent("—"); // out of the queue: no position to show
      expect(rows[2]).toHaveTextContent("2"); // renumbered around the gap
    });
  });

  it("persists the exclusion set and confirms it like any other setting", async () => {
    const onSaved = vi.fn();
    masterOn();
    render(<AutoModeSettings onSaved={onSaved} />);
    await findList();

    fireEvent.click(screen.getByRole("switch", { name: participate("Config B") }));

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("tt_auto_switch_excluded_ids") ?? "[]")).toEqual([
        "cfg-b",
      ]),
    );
    // The Rust queue builder reads this pair — a UI-only exclusion would be a lie on screen.
    expect(invoke).toHaveBeenCalledWith("set_failover_settings", {
      enabled: true,
      excludedIds: ["cfg-b"],
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it("brings an excluded server back", async () => {
    localStorage.setItem("tt_auto_switch_excluded_ids", JSON.stringify(["cfg-b"]));
    masterOn();
    render(<AutoModeSettings />);
    await findList();

    const rowSwitch = screen.getByRole("switch", { name: participate("Config B") });
    expect(rowSwitch).not.toBeChecked();
    fireEvent.click(rowSwitch);

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("tt_auto_switch_excluded_ids") ?? "[]")).toEqual([]),
    );
  });

  // WR-11 — the one the single-toggle tests above cannot see. `toggleParticipation` used to derive
  // the next exclusion set from its own RENDER CLOSURE, and `setFailoverExcludedIds` took a value,
  // never an updater. Two toggles dispatched in ONE batch therefore both read the pre-batch array
  // and the second write dropped the first: the server the user opted out of stayed in the real
  // failover queue while the switch on its row showed it excluded. A silent divergence between what
  // the user sees and what the tunnel will actually do — the worst shape a settings bug can take.
  //
  // The batch is produced with two NATIVE clicks inside a single `act()`: React queues both updates
  // and flushes them together, so no re-render happens between the handlers. That is what rapid
  // clicking, or Space held across two rows, produces in the running app. `fireEvent` cannot show
  // it — each call flushes on its own, which is precisely why the defect survived the suite.
  it("two participation toggles in one batch: both survive", async () => {
    masterOn();
    render(<AutoModeSettings />);
    await findList();

    const switchA = screen.getByRole("switch", { name: participate("Config A") });
    const switchB = screen.getByRole("switch", { name: participate("Config B") });

    act(() => {
      switchA.click();
      switchB.click();
    });

    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("tt_auto_switch_excluded_ids") ?? "[]")).toEqual([
        "cfg-a",
        "cfg-b",
      ]),
    );
    // What actually decides the queue is the Rust-side copy, so the LAST write must carry both —
    // a correct localStorage entry beside a one-id payload would still leave cfg-a in the queue.
    const failoverWrites = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "set_failover_settings");
    expect(failoverWrites[failoverWrites.length - 1]?.[1]).toEqual({
      enabled: true,
      excludedIds: ["cfg-a", "cfg-b"],
    });
    // …and the switches say the same thing the store does.
    expect(switchA).not.toBeChecked();
    expect(switchB).not.toBeChecked();
  });
});

describe("AutoModeSettings — keyboard reorder and announcements", () => {
  // The Phase-27 blocker in one sentence: pressing the same arrow twice must move the same row.
  // That only works if focus travels with the row, so the test presses twice and checks both.
  it("moves the focused row and takes the focus with it, press after press", async () => {
    masterOn();
    render(<AutoModeSettings />);
    const list = await findList();

    const rows = within(list).getAllByRole("listitem");
    rows[2].focus();
    fireEvent.keyDown(rows[2], { key: "ArrowUp" });

    await waitFor(() => {
      const after = within(list).getAllByRole("listitem");
      expect(after[1]).toHaveTextContent("Config C");
      expect(after[1]).toHaveFocus();
    });

    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    await waitFor(() => {
      const after = within(list).getAllByRole("listitem");
      expect(after[0]).toHaveTextContent("Config C");
      expect(after[0]).toHaveFocus();
    });
  });

  it("persists the new order and confirms the save", async () => {
    const onSaved = vi.fn();
    masterOn();
    render(<AutoModeSettings onSaved={onSaved} />);
    const list = await findList();

    fireEvent.keyDown(within(list).getAllByRole("listitem")[1], { key: "ArrowUp" });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reorder_configs", {
        ids: ["cfg-b", "cfg-a", "cfg-c"],
      }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  // WR-01 (Phase-28 review) regression. `moveBy` used to run `persistOrder` / `setAnnounce` /
  // `onSaved` INSIDE a `setOrder` updater, and React 19 double-invokes updaters under StrictMode —
  // which `main.tsx:129` wraps the whole app in. So one arrow press wrote the manifest TWICE in
  // dev. Rendering inside StrictMode is what makes this test able to fail: without it the double
  // invocation never happens and the bug is invisible, which is why the suite missed it.
  it("writes the manifest exactly once per arrow press, even under StrictMode", async () => {
    const onSaved = vi.fn();
    masterOn();
    render(
      <StrictMode>
        <AutoModeSettings onSaved={onSaved} />
      </StrictMode>,
    );
    const list = await findList();

    fireEvent.keyDown(within(list).getAllByRole("listitem")[1], { key: "ArrowUp" });

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reorder_configs", {
        ids: ["cfg-b", "cfg-a", "cfg-c"],
      }),
    );
    const writes = vi
      .mocked(invoke)
      .mock.calls.filter(([cmd]) => cmd === "reorder_configs");
    expect(writes).toHaveLength(1);
    // The confirmation rides with the write, so it must not double either — two «Настройки
    // сохранены» snackbars for one keypress is the same defect wearing a different face.
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("announces a reorder in the live region", async () => {
    masterOn();
    render(<AutoModeSettings />);
    const list = await findList();

    fireEvent.keyDown(within(list).getAllByRole("listitem")[1], { key: "ArrowUp" });

    await waitFor(() =>
      expect(screen.getByTestId("automode-live-region")).toHaveTextContent(
        "Config B — позиция 1 из 3",
      ),
    );
  });

  // The SECOND message, and the reason the region is not decorative: a screen reader does not
  // re-announce what a row MEANS when a switch inside it flips.
  it("announces a participation change in the live region too", async () => {
    masterOn();
    render(<AutoModeSettings />);
    await findList();

    fireEvent.click(screen.getByRole("switch", { name: participate("Config B") }));
    await waitFor(() =>
      expect(screen.getByTestId("automode-live-region")).toHaveTextContent("Config B — отключён"),
    );

    fireEvent.click(screen.getByRole("switch", { name: participate("Config B") }));
    await waitFor(() =>
      expect(screen.getByTestId("automode-live-region")).toHaveTextContent(
        "Config B — используется",
      ),
    );
  });

  // The gesture must be reachable from the row itself, not only from the hover-only «?».
  it("points every reorderable row at the sr-only instructions sentence", async () => {
    masterOn();
    render(<AutoModeSettings />);
    const list = await findList();

    const row = within(list).getAllByRole("listitem")[0];
    expect(row).toHaveAccessibleDescription(
      /стрелки вверх и вниз переставляют выбранную строку/i,
    );
  });
});

describe("AutoModeSettings — the lock while a switch is in flight", () => {
  it("holds the master toggle", async () => {
    render(<AutoModeSettings locked />);
    await screen.findByText("Авто-режим");
    expect(screen.getByRole("switch", { name: FAILOVER_LABEL })).toBeDisabled();
  });

  it("releases it when the lock clears", async () => {
    render(<AutoModeSettings locked={false} />);
    await screen.findByText("Авто-режим");
    expect(screen.getByRole("switch", { name: FAILOVER_LABEL })).not.toBeDisabled();
  });

  it("holds every participation switch, without removing anything", async () => {
    masterOn();
    render(<AutoModeSettings locked />);
    const list = await findList();

    for (const cfg of liveConfigs) {
      expect(screen.getByRole("switch", { name: participate(cfg.name) })).toBeDisabled();
    }
    // Nothing is hidden while held — the grab handles stay put (owner rule: disable, never remove).
    expect(within(list).getAllByTestId("priority-row-grip")).toHaveLength(3);
  });

  it("swallows a keyboard reorder", async () => {
    masterOn();
    render(<AutoModeSettings locked />);
    const list = await findList();

    fireEvent.keyDown(within(list).getAllByRole("listitem")[1], { key: "ArrowUp" });
    expect(invoke).not.toHaveBeenCalledWith("reorder_configs", expect.anything());
  });

  // Phase-14 IN-01, preserved verbatim: a drag that STARTED before the lock must persist nothing
  // when it ends, or the lock is not atomic against an in-flight drag.
  it("persists nothing from a drag that began before the lock", async () => {
    masterOn();
    const { rerender } = render(<AutoModeSettings locked={false} />);
    const list = await findList();
    const rows = within(list).getAllByRole("listitem");

    // jsdom implements no DataTransfer, so the drag events carry a stand-in. The browser always
    // supplies one; guarding for its absence in production would be defending against the platform.
    fireEvent.dragStart(rows[1], { dataTransfer: { effectAllowed: "" } });
    fireEvent.dragEnter(rows[0]);
    rerender(<AutoModeSettings locked />); // the switch starts mid-drag
    fireEvent.dragEnd(rows[1]);

    expect(invoke).not.toHaveBeenCalledWith("reorder_configs", expect.anything());
  });
});

/* ============================================================================================
 * The eleven list states.
 *
 * Each is driven from REAL INPUTS — the master value, useConfigList's loading / error / configs,
 * the participation set and the `locked` prop — never from a `status` prop. A status prop would let
 * the card render a state its data does not support, which is exactly the drift the story tier
 * exists to prevent: in the app, the data IS the state.
 * ========================================================================================== */

describe("AutoModeSettings — the eleven list states", () => {
  it("populated: several servers, at least two participating, numbers over participating rows only", async () => {
    masterOn();
    render(<AutoModeSettings />);
    const list = await findList();

    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("1");
    expect(rows[1]).toHaveTextContent("2");
    expect(rows[2]).toHaveTextContent("3");
    expect(within(list).queryByText("—")).not.toBeInTheDocument();
    // No «Текущий» badge and no caption over the switch column: the queue answers «in what order
    // will it switch», not «where am I connected now».
    expect(screen.queryByText(/^Текущий$/)).not.toBeInTheDocument();
  });

  it("master-off: no nested panel in the markup at all, the two settings beneath it remain", async () => {
    render(<AutoModeSettings />);
    await screen.findByText("Авто-режим");

    expect(screen.queryByText(ORDER_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: LIST_ARIA })).not.toBeInTheDocument();
    expect(screen.queryByTestId("automode-live-region")).not.toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(3); // master + the two below it
  });

  it("no-servers: the master toggle is inactive and an invitation stands where the panel would be", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return [];
      return null;
    });
    masterOn();
    render(<AutoModeSettings />);

    expect(await screen.findByText("Серверов пока нет")).toBeInTheDocument();
    expect(screen.getByText(/Добавьте сервер во вкладке «Подключение»/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: FAILOVER_LABEL })).toBeDisabled();
    // The invitation REPLACES the panel — arming a failover with nowhere to go is not a setting.
    expect(screen.queryByRole("list", { name: LIST_ARIA })).not.toBeInTheDocument();
  });

  it("single-server: no grab handle, the participation switch held, a calm note above the list", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return [liveConfigs[0]];
      return null;
    });
    masterOn();
    render(<AutoModeSettings />);
    const list = await findList(1);

    expect(within(list).queryAllByTestId("priority-row-grip")).toHaveLength(0);
    expect(screen.getByRole("switch", { name: participate("Config A") })).toBeDisabled();
    expect(screen.getByText(/Пока сервер один, переключаться некуда/)).toBeInTheDocument();
  });

  it("one-participating: the same note, because the user's situation is the same", async () => {
    localStorage.setItem("tt_auto_switch_excluded_ids", JSON.stringify(["cfg-b", "cfg-c"]));
    masterOn();
    render(<AutoModeSettings />);
    await findList();

    expect(screen.getByText(/Пока сервер один, переключаться некуда/)).toBeInTheDocument();
    // Three rows, one number — the note is about the QUEUE, not about the list length.
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("all-excluded: a warning is shown and nothing is corrected automatically", async () => {
    localStorage.setItem(
      "tt_auto_switch_excluded_ids",
      JSON.stringify(["cfg-a", "cfg-b", "cfg-c"]),
    );
    masterOn();
    render(<AutoModeSettings />);
    await findList();

    expect(screen.getByText("Все серверы исключены — переключаться не на что")).toBeInTheDocument();
    // No switch flips back on its own, and the stored set is left exactly as the user left it.
    for (const cfg of liveConfigs) {
      expect(screen.getByRole("switch", { name: participate(cfg.name) })).not.toBeChecked();
    }
    expect(JSON.parse(localStorage.getItem("tt_auto_switch_excluded_ids") ?? "[]")).toEqual([
      "cfg-a",
      "cfg-b",
      "cfg-c",
    ]);
  });

  it("loading: three placeholder rows in the same box, with the master toggle live throughout", async () => {
    let resolveList: (v: typeof liveConfigs) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs")
        return new Promise<typeof liveConfigs>((res) => {
          resolveList = res;
        });
      return null;
    });
    masterOn();
    render(<AutoModeSettings />);

    const skeleton = await screen.findByTestId("automode-skeleton");
    expect(skeleton.children).toHaveLength(3);
    // Not the empty-state invitation: the list is being read, it is not known to be empty.
    expect(screen.queryByText("Серверов пока нет")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: FAILOVER_LABEL })).not.toBeDisabled();

    resolveList(liveConfigs);
    await findList();
    expect(screen.queryByTestId("automode-skeleton")).not.toBeInTheDocument();
  });

  it("load-failed: a localized heading and a retry, with the backend's own words nowhere on screen", async () => {
    const BACKEND_ERROR = "ENOENT: configs.json is unreadable at C:/Users/secret/path";
    let calls = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") {
        calls += 1;
        throw new Error(BACKEND_ERROR);
      }
      return null;
    });
    masterOn();
    render(<AutoModeSettings />);

    expect(await screen.findByText("Не удалось прочитать список серверов")).toBeInTheDocument();
    // T-28-25 / D-05: the error channel is a boolean, so the backend string has nowhere to go.
    expect(screen.queryByText(/ENOENT/)).not.toBeInTheDocument();
    expect(screen.queryByText(/configs\.json/)).not.toBeInTheDocument();
    // NOT the «серверов пока нет» invitation: the servers exist, they just could not be read.
    expect(screen.queryByText("Серверов пока нет")).not.toBeInTheDocument();
    // The master toggle still shows the user's saved value — only the list is unknown.
    const master = screen.getByRole("switch", { name: FAILOVER_LABEL });
    expect(master).toBeChecked();
    expect(master).not.toBeDisabled();

    const before = calls;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(calls).toBe(before + 1));
  });

  // WR-10 — the DEFAULT path, and the one the test above could not see because it calls masterOn()
  // first. `APP_SETTINGS_DEFAULTS.masterOn` is FALSE, so this is what most users would actually get
  // when the manifest cannot be read. The failure surface used to live inside the master-gated
  // block, and `noServers` is false while `error` is true, so the card rendered the master row and
  // NOTHING else: no error, no placeholder, no retry — silence over a failure, which is exactly what
  // 27 D-15 overturned when it gave `useConfigList` an error channel in the first place.
  it("load-failed with «Авто-режим» OFF: the failure still shows, with a working retry", async () => {
    let calls = 0;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") {
        calls += 1;
        throw new Error("ENOENT: configs.json is unreadable");
      }
      return null;
    });
    // No masterOn() — the persisted default, which is OFF.
    render(<AutoModeSettings />);

    expect(await screen.findByText("Не удалось прочитать список серверов")).toBeInTheDocument();
    const master = screen.getByRole("switch", { name: FAILOVER_LABEL });
    expect(master).not.toBeChecked();
    // The backend's own words still have nowhere to go — the channel is a boolean.
    expect(screen.queryByText(/ENOENT/)).not.toBeInTheDocument();
    // Still not the «серверов пока нет» invitation: the servers exist, they could not be read.
    expect(screen.queryByText("Серверов пока нет")).not.toBeInTheDocument();
    // What stays master-gated is the queue EDITOR: there is no order to arrange for a list nobody
    // could read, so hoisting the failure must not drag the panel out with it.
    expect(screen.queryByText(ORDER_LABEL)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: LIST_ARIA })).not.toBeInTheDocument();

    const before = calls;
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(calls).toBe(before + 1));
  });

  it("switching: everything held, nothing removed, nothing new but a status line", async () => {
    masterOn();
    const { rerender } = render(<AutoModeSettings />);
    const list = await findList();
    const switchesBefore = screen.getAllByRole("switch").length;

    rerender(<AutoModeSettings locked />);

    expect(screen.getByText("Идёт переключение на другой сервер…")).toBeInTheDocument();
    expect(screen.getAllByRole("switch")).toHaveLength(switchesBefore); // nothing removed or added
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getAllByTestId("priority-row-grip")).toHaveLength(3);
  });

  it("long-name: the name truncates with the full value in a tooltip, and the switch stays on the row", async () => {
    const longName = "Очень длинное название сервера, которое точно не помещается в строку списка";
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return [{ ...liveConfigs[0], name: longName }, liveConfigs[1]];
      return null;
    });
    masterOn();
    render(<AutoModeSettings />);
    const list = await findList(2);

    const nameNode = screen.getByText(longName);
    expect(nameNode).toHaveClass("truncate");
    fireEvent.mouseEnter(nameNode.parentElement!);
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent(longName));
    // The switch did not get pushed out of its row by the long name.
    const row = within(list).getAllByRole("listitem")[0];
    expect(within(row).getByRole("switch", { name: participate(longName) })).toBeInTheDocument();
  });

  it("dragging: the others part around the dragged row and the numbers recompute live", async () => {
    masterOn();
    render(<AutoModeSettings />);
    const list = await findList();
    const rows = within(list).getAllByRole("listitem");

    fireEvent.dragStart(rows[2], { dataTransfer: { effectAllowed: "" } });
    fireEvent.dragEnter(rows[0]);

    await waitFor(() => {
      const after = within(list).getAllByRole("listitem");
      expect(after[0]).toHaveTextContent("Config C");
      expect(after[0]).toHaveTextContent("1"); // renumbered before the drop, not after it
      expect(after[1]).toHaveTextContent("Config A");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Item 9 (30.1 milestone review) — a reorder the backend REFUSED must not be
// announced as «Настройки сохранены».
//
// `persistOrder` was fire-and-forget with an empty catch, and both call sites (the
// keyboard move and the drag drop) called `onSaved` unconditionally right after it.
// So a refused write left the user with a confirmation they earned nothing for and a
// visible queue order the failover engine does not use — the card and Rust silently
// disagreeing about which server is tried first.
//
// The counter-pattern is on this very surface: the master toggle and the participation
// set already route a refusal through a reconcile-and-report pair (`savedToRust` →
// `reconcileFailoverFromRust` + `onSaveFailed`). The reorder was the odd one out.
// ─────────────────────────────────────────────────────────────────────────
describe("AutoModeSettings — item 9 (30.1): a refused reorder confirms nothing", () => {
  /** Rust accepts everything except the reorder. */
  function refuseReorder() {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return liveConfigs;
      if (cmd === "reorder_configs") throw new Error("disk full");
      return null;
    });
  }

  it("reports the refusal, fires no confirmation, and puts the visible order back", async () => {
    const onSaved = vi.fn();
    const onSaveFailed = vi.fn();
    masterOn();
    refuseReorder();
    render(<AutoModeSettings onSaved={onSaved} onSaveFailed={onSaveFailed} />);
    const list = await findList();

    // Move Config B up over Config A.
    fireEvent.keyDown(within(list).getAllByRole("listitem")[1], { key: "ArrowUp" });

    // The confirmation must not have fired on the keypress itself — before the fix it did,
    // synchronously, before the write it was confirming had even been attempted.
    expect(onSaved).not.toHaveBeenCalled();
    // The refusal reaches the user through the same slot the other two refused writes use…
    await waitFor(() => expect(onSaveFailed).toHaveBeenCalled());
    // …and «Настройки сохранены» never fired at all for a write that did not land.
    expect(onSaved).not.toHaveBeenCalled();
    // The queue is back on the order Rust actually holds, rather than leaving the user looking at
    // an arrangement failover will not use.
    await waitFor(() => {
      const rows = within(list).getAllByRole("listitem");
      expect(rows[0]).toHaveTextContent("Config A");
      expect(rows[1]).toHaveTextContent("Config B");
    });
  });

  it("the live region corrects itself to the row's REAL position after a refusal", async () => {
    // The announcement is the screen-reader equivalent of the visible order, so leaving it saying
    // «на позиции 1 из 3» after the move was refused is the same lie in another channel.
    masterOn();
    refuseReorder();
    render(<AutoModeSettings />);
    const list = await findList();

    fireEvent.keyDown(within(list).getAllByRole("listitem")[1], { key: "ArrowUp" });

    await waitFor(() =>
      expect(screen.getByTestId("automode-live-region")).toHaveTextContent(
        "Config B — позиция 2 из 3",
      ),
    );
  });

  it("an ACCEPTED reorder still confirms exactly as before", async () => {
    const onSaved = vi.fn();
    const onSaveFailed = vi.fn();
    masterOn();
    render(<AutoModeSettings onSaved={onSaved} onSaveFailed={onSaveFailed} />);
    const list = await findList();

    fireEvent.keyDown(within(list).getAllByRole("listitem")[1], { key: "ArrowUp" });

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onSaveFailed).not.toHaveBeenCalled();
    // …and the move stands.
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Config B");
  });
});
