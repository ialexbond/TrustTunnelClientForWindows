// AutoModeSettings — behavior + a11y tests (Phase 12, plan 12-06).
//
// Turns the Wave-0 12-01 `it.todo` scaffold GREEN. Asserts behavior + accessibility
// (roles / aria / live-region), NOT CSS classes:
//   - D-24/F08: the auto-best params + priority list are absent from the DOM when the
//     master toggle is OFF, present when ON.
//   - F19: a reorder is announced via an aria-live=polite region («<имя> — позиция N из M»),
//     and the new order is persisted via invoke('reorder_configs', { ids }).
//   - D-06: the notifications toggle persists a real boolean (tt_notifications_enabled).
//   - D-01: the startup auto-connect toggle reads/writes the existing tt_auto_connect key.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../../shared/i18n";
import { AutoModeSettings } from "./AutoModeSettings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const liveConfigs = [
  { id: "cfg-a", name: "Config A", host: "a.example.com", user: "u", path: "/a", order: 0, last_used: true },
  { id: "cfg-b", name: "Config B", host: "b.example.com", user: "u", path: "/b", order: 1, last_used: false },
  { id: "cfg-c", name: "Config C", host: "c.example.com", user: "u", path: "/c", order: 2, last_used: false },
];

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

describe("AutoModeSettings", () => {
  it("hidden when off — params not rendered", async () => {
    // master OFF by default → the NumberInputs + priority list are NOT in the DOM (D-24/F08).
    render(<AutoModeSettings />);
    await screen.findByText("Авто-режим");

    expect(screen.queryByLabelText("Порог задержки, мс")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Интервал проверки, сек")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("list", { name: "Приоритет конфигов для авто-подключения" }),
    ).not.toBeInTheDocument();

    // Flip the master toggle ON → params + priority list appear.
    const masterToggle = screen.getAllByRole("switch")[0];
    fireEvent.click(masterToggle);

    expect(await screen.findByLabelText("Порог задержки, мс")).toBeInTheDocument();
    expect(screen.getByLabelText("Интервал проверки, сек")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("list", { name: "Приоритет конфигов для авто-подключения" }),
      ).toBeInTheDocument(),
    );
  });

  it("threshold accepts a multi-digit value — no clamp-to-min on each keystroke (owner UAT)", async () => {
    // Regression: the field clamped the persisted value to the min on EVERY keystroke, so typing a
    // multi-digit value snapped to the min after the first digit and could never be reached. The
    // draft + commit-on-blur fix keeps the typed string free until blur. (Min is 150 since F24 — the
    // threshold measures tunnel latency — so we type 250 to stay clearly ABOVE the floor.)
    render(<AutoModeSettings />);
    await screen.findByText("Авто-режим");
    fireEvent.click(screen.getAllByRole("switch")[0]); // master ON → params appear

    const input = (await screen.findByLabelText("Порог задержки, мс")) as HTMLInputElement;
    // Mid-typing must NOT snap to the 150 minimum.
    fireEvent.change(input, { target: { value: "2" } });
    expect(input.value).toBe("2");
    fireEvent.change(input, { target: { value: "250" } });
    expect(input.value).toBe("250");
    // Commit on blur persists the in-range value as-typed (NOT clamped to 150).
    fireEvent.blur(input);
    expect(localStorage.getItem("tt_auto_switch_threshold_ms")).toBe("250");

    // A genuinely below-min value still clamps — but only on blur, not while typing. (Min is 150.)
    fireEvent.change(input, { target: { value: "10" } });
    expect(input.value).toBe("10");
    fireEvent.blur(input);
    expect(localStorage.getItem("tt_auto_switch_threshold_ms")).toBe("150");
  });

  it("priority list has NO per-row arrow buttons (owner UAT — keyboard arrows on the row instead)", async () => {
    render(<AutoModeSettings />);
    await screen.findByText("Авто-режим");
    fireEvent.click(screen.getAllByRole("switch")[0]); // master ON
    await screen.findByRole("list", { name: "Приоритет конфигов для авто-подключения" });
    // The removed ▲▼ IconButtons must be gone.
    expect(screen.queryByRole("button", { name: "Переместить вверх" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Переместить вниз" })).not.toBeInTheDocument();
    // Rows are focusable (tabbable) so the keyboard arrows can drive the reorder.
    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveAttribute("tabindex", "0");
  });

  it("notifications toggle persists (no-op render)", async () => {
    // D-06: toggling notifications writes the real boolean Phase 13 reads (tt_notifications_enabled).
    render(<AutoModeSettings />);
    await screen.findByText("Авто-режим");

    // notifications is the LAST switch (master, auto-connect-launch, notifications) and ON by default.
    const switches = screen.getAllByRole("switch");
    const notifyToggle = switches[switches.length - 1];
    expect(notifyToggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(notifyToggle);
    expect(localStorage.getItem("tt_notifications_enabled")).toBe("false");
  });

  it("auto-connect toggle reads/writes the existing tt_auto_connect key", async () => {
    // D-01: the startup toggle binds to the EXISTING tt_auto_connect key (via useAppSettings).
    render(<AutoModeSettings />);
    await screen.findByText("Авто-режим");

    // With nothing stored, autoConnectOnLaunch defaults ON; toggling it writes "false".
    const switches = screen.getAllByRole("switch");
    const autoConnectToggle = switches[1]; // master[0], auto-connect-launch[1], notifications[2]
    fireEvent.click(autoConnectToggle);
    expect(localStorage.getItem("tt_auto_connect")).toBe("false");
  });

  it("announces reorder via a live region", async () => {
    // F19: a keyboard move announces «<имя> — позиция N из M» via an aria-live=polite region AND
    // persists the new order via invoke('reorder_configs', { ids }). (Filled in Task 2.)
    render(<AutoModeSettings />);
    await screen.findByText("Авто-режим");

    // Reveal the priority list.
    fireEvent.click(screen.getAllByRole("switch")[0]);
    await screen.findByRole("list", { name: "Приоритет конфигов для авто-подключения" });

    // Move the SECOND config (Config B) up one slot by focusing its row and pressing ArrowUp.
    // (The per-row ▲▼ buttons were removed in the owner UAT pass — the keyboard arrows on the
    // focusable row are the accessible reorder path now.)
    const items = screen.getAllByRole("listitem");
    const secondRow = items[1];
    fireEvent.keyDown(secondRow, { key: "ArrowUp" });

    // The live region re-announces the moved item's new position.
    const liveRegion = screen.getByRole("status");
    await waitFor(() => {
      expect(liveRegion).toHaveTextContent(/Config B/);
      expect(liveRegion).toHaveTextContent(/позиция 1 из 3/);
    });

    // Persisted with the new top-to-bottom id order (B moved above A).
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reorder_configs", {
        ids: ["cfg-b", "cfg-a", "cfg-c"],
      }),
    );
  });

  // ─── WR-01: priority list populates when configs arrive AFTER the master toggle is ON ───
  // REGRESSION-FIRST: before the re-sync effect, PriorityList copied configs into local state ONCE.
  // When master is persisted ON, the list mounts while useConfigList is still [] (list_configs not
  // yet resolved), so the priority list was permanently empty even after the real list arrived.
  it("populates the priority list when configs resolve after master is already ON", async () => {
    // Master persisted ON → the params block (and PriorityList) mounts on the FIRST render.
    localStorage.setItem("tt_auto_switch_enabled", "true");

    // Defer the list_configs resolution so PriorityList mounts against an empty list first.
    let resolveList: (v: typeof liveConfigs) => void = () => {};
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs")
        return new Promise<typeof liveConfigs>((res) => {
          resolveList = res;
        });
      if (cmd === "reorder_configs") return liveConfigs;
      return null;
    });

    render(<AutoModeSettings />);
    await screen.findByText("Авто-режим");

    // The priority list is present (master ON) but empty until configs arrive.
    const list = await screen.findByRole("list", {
      name: "Приоритет конфигов для авто-подключения",
    });
    expect(within(list).queryAllByRole("listitem")).toHaveLength(0);

    // The async list arrives → the re-sync effect must seed the order so the rows appear.
    resolveList(liveConfigs);
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem")).toHaveLength(3),
    );
  });

  // ─── WR-02: priority list shows raw manifest `order`, not last-used-first ───
  // list_configs returns the list sorted last-used-first (Config C below has last_used:true at
  // order 2). The priority list must show SWITCH-PRIORITY order (raw `order` ascending: A, B, C),
  // not hoist the last-used config to slot 1.
  it("shows the priority list in raw order (not last-used-first)", async () => {
    const lastUsedFirst = [
      // As list_configs returns it: last-used (order 2) hoisted to the top.
      { id: "cfg-c", name: "Config C", host: "c.example.com", user: "u", path: "/c", order: 2, last_used: true },
      { id: "cfg-a", name: "Config A", host: "a.example.com", user: "u", path: "/a", order: 0, last_used: false },
      { id: "cfg-b", name: "Config B", host: "b.example.com", user: "u", path: "/b", order: 1, last_used: false },
    ];
    localStorage.setItem("tt_auto_switch_enabled", "true");
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "list_configs") return lastUsedFirst;
      if (cmd === "reorder_configs") return lastUsedFirst;
      return null;
    });

    render(<AutoModeSettings />);
    await screen.findByText("Авто-режим");
    const list = await screen.findByRole("list", {
      name: "Приоритет конфигов для авто-подключения",
    });
    await waitFor(() =>
      expect(within(list).getAllByRole("listitem")).toHaveLength(3),
    );

    // Rows must be in raw `order` (A, B, C) — NOT the last-used-first order (C, A, B).
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Config A");
    expect(rows[1]).toHaveTextContent("Config B");
    expect(rows[2]).toHaveTextContent("Config C");
  });

  // ─── Phase 14 (Wave 0, plan 14-01): lock the auto-mode controls while switching ───
  //
  // GREEN as of 14-03 (D-13) — a mid-switch auto-mode toggle or priority reorder could fire a
  // COMPETING switch (Pitfall 5: useAutoSwitch re-seeds on [masterOn, status, activeConfigPath]). So
  // while a switch is in flight the master toggle + priority reorder are LOCKED via the `locked` prop
  // (App threads isSwitching → AppSettingsPanel → here). Assert behavior/aria (disabled switch,
  // non-actionable reorder), never CSS classes.
  describe("Phase 14 — lock while switching (GREEN in 14-03)", () => {
    // D-13: with the lock engaged the master toggle is DISABLED — a click cannot flip it (so it can
    // never arm the auto-switch engine mid-switch). The prop name (`locked`, OR'd with isSwitching
    // upstream) mirrors the existing ConfigCard.locked idiom (D-21) — do NOT invent a parallel one.
    it("disables the master toggle while locked", () => {
      render(<AutoModeSettings locked />);
      const masterToggle = screen.getAllByRole("switch")[0];
      // A locked master toggle is non-interactive: aria-disabled or the native disabled attribute.
      const isDisabled =
        masterToggle.getAttribute("aria-disabled") === "true" ||
        (masterToggle as HTMLButtonElement).disabled === true;
      expect(isDisabled).toBe(true);
    });

    // D-13: the master toggle is ENABLED again when the lock clears (atomic re-enable on settle).
    it("enables the master toggle when not locked", () => {
      render(<AutoModeSettings locked={false} />);
      const masterToggle = screen.getAllByRole("switch")[0];
      const isDisabled =
        masterToggle.getAttribute("aria-disabled") === "true" ||
        (masterToggle as HTMLButtonElement).disabled === true;
      expect(isDisabled).toBe(false);
    });

    // D-13: the priority reorder is locked too — a keyboard ArrowUp on a focused row must NOT persist
    // a new order while switching (a mid-switch reorder is a competing state change). Master is ON so
    // the priority list is present; with the lock engaged, a reorder keypress fires no reorder_configs.
    it("does not persist a priority reorder while locked", async () => {
      localStorage.setItem("tt_auto_switch_enabled", "true");
      render(<AutoModeSettings locked />);
      await screen.findByText("Авто-режим");
      const list = await screen.findByRole("list", {
        name: "Приоритет конфигов для авто-подключения",
      });
      await waitFor(() =>
        expect(within(list).getAllByRole("listitem")).toHaveLength(3),
      );

      const items = within(list).getAllByRole("listitem");
      fireEvent.keyDown(items[1], { key: "ArrowUp" });

      // No reorder was persisted — the reorder is locked while switching.
      expect(invoke).not.toHaveBeenCalledWith(
        "reorder_configs",
        expect.anything(),
      );
    });
  });
});
